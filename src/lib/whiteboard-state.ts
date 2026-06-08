/**
 * whiteboard-state.ts — Persistent state machine for 飞书 whiteboards.
 *
 * Phase 5 design — "白板永远不漂" (Founder's hard requirement).
 *
 * Why a state machine instead of "LLM outputs a fresh mermaid each turn"?
 *   - LLM hallucination compounds: after 10+ turns Beeni forgets which
 *     questions are still open, re-introduces decided ones, drops nodes.
 *   - Mermaid is a *rendering* concern. The source of truth should be
 *     structured nodes + edges + status flags, so we can deterministically
 *     re-render at any time.
 *   - Server-side validation: when the LLM proposes
 *     `resolve_question Q42` and Q42 doesn't exist, we reject the transition
 *     rather than allow it to silently break the graph.
 *
 * Persistence model:
 *   - One JSON file per docToken under `data/whiteboard-state/<docToken>.json`.
 *   - Atomic write (tmpfile + rename).
 *   - Lazy load on first access; in-memory cache per process.
 *   - history[] is append-only — never truncated — so any past state can be
 *     reconstructed by replaying transitions in order.
 *
 * Concurrency:
 *   - All mutations go through WhiteboardManager.mutate() which:
 *     1) loads (or returns cached) state
 *     2) applies transitions (validating each — rejects on conflict)
 *     3) bumps version + appends history event
 *     4) writes to disk
 *   - We don't support multi-writer optimistic concurrency because Phase 5 is
 *     single-user / single-process (founder's pill). The version field is
 *     present for future use.
 *
 * Tests live in `scripts/_phase5-state-machine.ts`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export type WhiteboardKind =
  | 'flowchart'
  | 'mindmap'
  | 'sequence'
  | 'gantt'
  | 'quadrant'
  | 'state';

export type WBNodeKind = 'topic' | 'question' | 'decision' | 'note';
export type WBNodeStatus = 'pending' | 'decided' | 'active' | 'done';

export interface WBNode {
  id: string;
  kind: WBNodeKind;
  label: string;
  status: WBNodeStatus;
  createdAt: number;
  resolvedAt?: number;
  /** Decision node id that resolves this (for kind=question). */
  resolvedBy?: string;
  /** Parent node id (for hierarchical structures like mindmap). */
  parentId?: string;
  /** Group membership (flowchart subgraph / lane). */
  subgraphId?: string;
}

export type WBEdgeKind = 'flow' | 'resolves' | 'depends';

export interface WBEdge {
  from: string;
  to: string;
  label?: string;
  kind?: WBEdgeKind;
}

export interface WBSubgraph {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface WhiteboardState {
  docToken: string;
  whiteboardToken: string;
  kind: WhiteboardKind;
  nodes: Record<string, WBNode>;
  edges: WBEdge[];
  subgraphs: Record<string, WBSubgraph>;
  history: WBHistoryEvent[];
  version: number;
  createdAt: number;
  lastUpdatedAt: number;
  /** Auto-increment counter for synthesized node ids (N1, N2, ...). */
  nextNodeSeq: number;
}

export type WBTransition =
  | {
      action: 'add_node';
      node: Omit<WBNode, 'createdAt'> & { id?: string };
    }
  | { action: 'add_edge'; edge: WBEdge }
  | { action: 'add_subgraph'; subgraph: WBSubgraph }
  | {
      action: 'resolve_question';
      questionId: string;
      conclusion: string;
      /**
       * id for the decision node. If it doesn't exist, we create it. If it
       * exists, we connect to it.
       */
      resolvedById: string;
    }
  | {
      action: 'update_status';
      nodeId: string;
      status: WBNodeStatus;
    }
  | { action: 'relabel'; nodeId: string; newLabel: string }
  | { action: 'remove_node'; nodeId: string }
  | { action: 'remove_edge'; from: string; to: string }
  | { action: 'change_kind'; newKind: WhiteboardKind };

export interface WBHistoryEvent {
  ts: number;
  turnId: string;
  transitions: WBTransition[];
  /**
   * Per-transition outcome aligned with `transitions[]`. true = applied,
   * false = rejected (e.g. invalid id). All rejections are kept for audit.
   */
  results: boolean[];
  /** Brief reason per rejected transition (empty string when applied). */
  reasons: string[];
  /** Which LLM proposed (doubao / gemini-flash / 'manual'). */
  byLLM: string;
  /** True if at least one transition was applied. */
  appliedOK: boolean;
}

// ── Default state factory ────────────────────────────────────────────────────

export function emptyState(
  docToken: string,
  whiteboardToken: string,
  kind: WhiteboardKind = 'flowchart',
): WhiteboardState {
  const now = Date.now();
  return {
    docToken,
    whiteboardToken,
    kind,
    nodes: {},
    edges: [],
    subgraphs: {},
    history: [],
    version: 0,
    createdAt: now,
    lastUpdatedAt: now,
    nextNodeSeq: 1,
  };
}

// ── Validation + apply ───────────────────────────────────────────────────────

const VALID_KINDS: WhiteboardKind[] = [
  'flowchart',
  'mindmap',
  'sequence',
  'gantt',
  'quadrant',
  'state',
];
const VALID_NODE_KINDS: WBNodeKind[] = ['topic', 'question', 'decision', 'note'];
const VALID_STATUSES: WBNodeStatus[] = ['pending', 'decided', 'active', 'done'];

function genNodeId(state: WhiteboardState, hint?: WBNodeKind): string {
  const prefix = hint === 'question' ? 'Q' : hint === 'decision' ? 'A' : 'N';
  // ensure uniqueness even if user-supplied ids overlap N-prefix
  while (true) {
    const id = `${prefix}${state.nextNodeSeq++}`;
    if (!state.nodes[id]) return id;
  }
}

/**
 * Apply a single transition in-place. Returns {ok, reason}. On reject the
 * state is left UNCHANGED so caller can append a failure result without
 * needing to deep-clone.
 */
export function applyTransition(
  state: WhiteboardState,
  t: WBTransition,
): { ok: boolean; reason: string } {
  switch (t.action) {
    case 'add_node': {
      const n = t.node;
      if (!n || typeof n !== 'object') return { ok: false, reason: 'node missing' };
      if (n.kind && !VALID_NODE_KINDS.includes(n.kind))
        return { ok: false, reason: `bad node kind: ${n.kind}` };
      if (n.status && !VALID_STATUSES.includes(n.status))
        return { ok: false, reason: `bad status: ${n.status}` };
      const label = String(n.label || '').trim();
      if (!label) return { ok: false, reason: 'node label empty' };
      let id = (n.id || '').trim();
      if (id && state.nodes[id]) {
        // idempotent: same id + same label & kind = treat as already-applied success
        const existing = state.nodes[id];
        if (existing.label === label && existing.kind === (n.kind || existing.kind)) {
          return { ok: true, reason: '' };
        }
        return { ok: false, reason: `node id already exists: ${id}` };
      }
      if (!id) id = genNodeId(state, n.kind);
      // parentId / subgraphId integrity (best-effort: warn but don't reject — orphans allowed)
      const node: WBNode = {
        id,
        kind: (n.kind || 'topic') as WBNodeKind,
        label: label.slice(0, 60),
        status: (n.status || 'active') as WBNodeStatus,
        createdAt: Date.now(),
      };
      if (n.parentId) node.parentId = String(n.parentId);
      if (n.subgraphId) node.subgraphId = String(n.subgraphId);
      if (n.resolvedBy) node.resolvedBy = String(n.resolvedBy);
      state.nodes[id] = node;
      // If part of a subgraph, register membership
      if (node.subgraphId && state.subgraphs[node.subgraphId]) {
        const sg = state.subgraphs[node.subgraphId];
        if (!sg.nodeIds.includes(id)) sg.nodeIds.push(id);
      }
      return { ok: true, reason: '' };
    }
    case 'add_edge': {
      const e = t.edge;
      if (!e || !e.from || !e.to)
        return { ok: false, reason: 'edge missing from/to' };
      if (!state.nodes[e.from])
        return { ok: false, reason: `edge.from node missing: ${e.from}` };
      if (!state.nodes[e.to])
        return { ok: false, reason: `edge.to node missing: ${e.to}` };
      // dedupe identical edges (same from/to/label/kind)
      const dup = state.edges.find(
        (x) =>
          x.from === e.from &&
          x.to === e.to &&
          (x.label || '') === (e.label || '') &&
          (x.kind || 'flow') === (e.kind || 'flow'),
      );
      if (dup) return { ok: true, reason: '' };
      state.edges.push({
        from: e.from,
        to: e.to,
        label: e.label ? String(e.label).slice(0, 30) : undefined,
        kind: e.kind || 'flow',
      });
      return { ok: true, reason: '' };
    }
    case 'add_subgraph': {
      const sg = t.subgraph;
      if (!sg || !sg.id || !sg.label)
        return { ok: false, reason: 'subgraph missing id/label' };
      if (state.subgraphs[sg.id])
        return { ok: true, reason: '' }; // idempotent
      state.subgraphs[sg.id] = {
        id: sg.id,
        label: String(sg.label).slice(0, 40),
        nodeIds: Array.isArray(sg.nodeIds)
          ? sg.nodeIds.filter((n) => !!state.nodes[n])
          : [],
      };
      return { ok: true, reason: '' };
    }
    case 'resolve_question': {
      const q = state.nodes[t.questionId];
      if (!q) return { ok: false, reason: `question not found: ${t.questionId}` };
      if (q.kind !== 'question')
        return { ok: false, reason: `node ${t.questionId} is not a question (kind=${q.kind})` };
      if (q.status === 'decided' && q.resolvedBy)
        return {
          ok: false,
          reason: `question ${t.questionId} already resolved by ${q.resolvedBy}`,
        };
      const decisionId = (t.resolvedById || '').trim() || genNodeId(state, 'decision');
      const conclusion = String(t.conclusion || '').trim().slice(0, 60);
      if (!conclusion) return { ok: false, reason: 'resolve_question: empty conclusion' };
      // Ensure decision node exists
      if (!state.nodes[decisionId]) {
        state.nodes[decisionId] = {
          id: decisionId,
          kind: 'decision',
          label: conclusion,
          status: 'decided',
          createdAt: Date.now(),
        };
      } else {
        // ensure existing node is in decided shape
        const d = state.nodes[decisionId];
        d.status = 'decided';
        if (!d.label) d.label = conclusion;
      }
      q.status = 'decided';
      q.resolvedBy = decisionId;
      q.resolvedAt = Date.now();
      // edge question → decision
      const dup = state.edges.find(
        (e) => e.from === t.questionId && e.to === decisionId && e.kind === 'resolves',
      );
      if (!dup)
        state.edges.push({
          from: t.questionId,
          to: decisionId,
          kind: 'resolves',
          label: '决议',
        });
      return { ok: true, reason: '' };
    }
    case 'update_status': {
      const node = state.nodes[t.nodeId];
      if (!node) return { ok: false, reason: `node not found: ${t.nodeId}` };
      if (!VALID_STATUSES.includes(t.status))
        return { ok: false, reason: `bad status: ${t.status}` };
      node.status = t.status;
      if (t.status === 'done' || t.status === 'decided') {
        if (!node.resolvedAt) node.resolvedAt = Date.now();
      }
      return { ok: true, reason: '' };
    }
    case 'relabel': {
      const node = state.nodes[t.nodeId];
      if (!node) return { ok: false, reason: `node not found: ${t.nodeId}` };
      const label = String(t.newLabel || '').trim();
      if (!label) return { ok: false, reason: 'relabel: empty label' };
      node.label = label.slice(0, 60);
      return { ok: true, reason: '' };
    }
    case 'remove_node': {
      if (!state.nodes[t.nodeId])
        return { ok: false, reason: `node not found: ${t.nodeId}` };
      delete state.nodes[t.nodeId];
      // remove dangling edges
      state.edges = state.edges.filter((e) => e.from !== t.nodeId && e.to !== t.nodeId);
      // remove from subgraphs
      for (const sg of Object.values(state.subgraphs)) {
        sg.nodeIds = sg.nodeIds.filter((id) => id !== t.nodeId);
      }
      // unset parentId of any children
      for (const n of Object.values(state.nodes)) {
        if (n.parentId === t.nodeId) delete n.parentId;
      }
      return { ok: true, reason: '' };
    }
    case 'remove_edge': {
      const before = state.edges.length;
      state.edges = state.edges.filter(
        (e) => !(e.from === t.from && e.to === t.to),
      );
      if (state.edges.length === before)
        return { ok: false, reason: `edge not found: ${t.from}->${t.to}` };
      return { ok: true, reason: '' };
    }
    case 'change_kind': {
      if (!VALID_KINDS.includes(t.newKind))
        return { ok: false, reason: `bad kind: ${t.newKind}` };
      // No node mutation — renderer adapts. parentId remains valid for mindmap.
      state.kind = t.newKind;
      return { ok: true, reason: '' };
    }
    default: {
      return { ok: false, reason: `unknown action: ${(t as any).action}` };
    }
  }
}

// ── Manager (persistence + cache) ────────────────────────────────────────────

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data', 'whiteboard-state');

function sanitizeToken(token: string): string {
  return token.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

export class WhiteboardManager {
  private cache = new Map<string, WhiteboardState>();
  private inflight = new Map<string, Promise<WhiteboardState>>();
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || DEFAULT_DATA_DIR;
  }

  private filePath(docToken: string): string {
    return path.join(this.dataDir, `${sanitizeToken(docToken)}.json`);
  }

  /**
   * Load state for a docToken. If file missing, returns a fresh empty state
   * (NOT yet written to disk — caller saves via mutate / save).
   */
  async load(
    docToken: string,
    whiteboardToken: string = '',
    kind: WhiteboardKind = 'flowchart',
  ): Promise<WhiteboardState> {
    const cached = this.cache.get(docToken);
    if (cached) {
      // If caller supplies a fresh whiteboardToken and state had none, update.
      if (whiteboardToken && !cached.whiteboardToken) {
        cached.whiteboardToken = whiteboardToken;
      }
      return cached;
    }
    // dedupe in-flight loads
    const inflight = this.inflight.get(docToken);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        await fs.mkdir(this.dataDir, { recursive: true });
        const raw = await fs.readFile(this.filePath(docToken), 'utf-8');
        const parsed = JSON.parse(raw) as WhiteboardState;
        // Backfill missing fields for forward-compat
        if (typeof parsed.nextNodeSeq !== 'number') {
          const max = Math.max(
            0,
            ...Object.keys(parsed.nodes || {})
              .map((id) => {
                const m = id.match(/(\d+)$/);
                return m ? Number(m[1]) : 0;
              }),
          );
          parsed.nextNodeSeq = max + 1;
        }
        if (!parsed.subgraphs) parsed.subgraphs = {};
        if (!parsed.history) parsed.history = [];
        if (whiteboardToken && !parsed.whiteboardToken) {
          parsed.whiteboardToken = whiteboardToken;
        }
        this.cache.set(docToken, parsed);
        return parsed;
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          const fresh = emptyState(docToken, whiteboardToken, kind);
          this.cache.set(docToken, fresh);
          return fresh;
        }
        throw err;
      } finally {
        this.inflight.delete(docToken);
      }
    })();
    this.inflight.set(docToken, p);
    return p;
  }

  /** Force-set state (for tests or recovery). */
  setState(state: WhiteboardState): void {
    this.cache.set(state.docToken, state);
  }

  /** Atomic save to disk. */
  async save(state: WhiteboardState): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const file = this.filePath(state.docToken);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(state, null, 2);
    await fs.writeFile(tmp, serialized, 'utf-8');
    await fs.rename(tmp, file);
  }

  /**
   * The primary mutation entry point. Applies all transitions atomically:
   *   - For each transition, validate + apply (in-memory mutation).
   *   - Bumps version + writes a single history event with per-transition
   *     results.
   *   - Persists to disk once.
   * Returns the {state, results} so caller can report rejections.
   */
  async mutate(
    docToken: string,
    transitions: WBTransition[],
    meta: { turnId: string; byLLM: string },
    whiteboardTokenHint?: string,
  ): Promise<{
    state: WhiteboardState;
    results: boolean[];
    reasons: string[];
    appliedCount: number;
  }> {
    const state = await this.load(docToken, whiteboardTokenHint || '');
    const results: boolean[] = [];
    const reasons: string[] = [];
    for (const t of transitions) {
      try {
        const r = applyTransition(state, t);
        results.push(r.ok);
        reasons.push(r.reason);
      } catch (err) {
        results.push(false);
        reasons.push((err as Error).message);
      }
    }
    const appliedCount = results.filter(Boolean).length;
    state.version++;
    state.lastUpdatedAt = Date.now();
    state.history.push({
      ts: Date.now(),
      turnId: meta.turnId || `t${state.version}`,
      transitions,
      results,
      reasons,
      byLLM: meta.byLLM || 'unknown',
      appliedOK: appliedCount > 0,
    });
    await this.save(state);
    return { state, results, reasons, appliedCount };
  }

  /**
   * Replay history events from scratch — useful for audit / recovery.
   * Returns the rebuilt state (does NOT persist or replace cache).
   */
  replay(state: WhiteboardState): WhiteboardState {
    const fresh = emptyState(state.docToken, state.whiteboardToken, state.kind);
    for (const evt of state.history) {
      for (const t of evt.transitions) {
        applyTransition(fresh, t);
      }
      fresh.version++;
      fresh.lastUpdatedAt = evt.ts;
    }
    fresh.history = [...state.history];
    return fresh;
  }

  /** Drop in-memory cache (useful in tests). */
  clearCache(): void {
    this.cache.clear();
  }

  /** For tests: delete state file. */
  async deleteOnDisk(docToken: string): Promise<void> {
    this.cache.delete(docToken);
    try {
      await fs.unlink(this.filePath(docToken));
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

/** Default shared manager instance (used by server / RecordingSession). */
let _default: WhiteboardManager | null = null;
export function getWhiteboardManager(dataDir?: string): WhiteboardManager {
  if (!_default) _default = new WhiteboardManager(dataDir);
  return _default;
}
