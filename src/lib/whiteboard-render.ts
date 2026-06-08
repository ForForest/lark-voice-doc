/**
 * whiteboard-render.ts — Pure renderer: WhiteboardState → mermaid source.
 *
 * Phase 5 principle: LLM never outputs mermaid directly. It outputs
 * structured transitions. The mermaid is regenerated from state every push
 * via these pure functions, so the visual is always consistent with the
 * audit log.
 *
 * Color/style convention (sage palette, single accent):
 *   - pending   — orange dashed border (eye-grabbing "open question")
 *   - decided   — sage green solid (resolved decision)
 *   - active    — soft sage outline (in-progress topic)
 *   - done      — muted grey, low opacity (archived)
 *
 * Node shape convention:
 *   - question  — [/"❓ label"/] (hex / parallelogram, signals "open")
 *   - decision  — ["✓ label"]   (rectangle with checkmark)
 *   - topic     — (("label"))   (circle, neutral)
 *   - note      — [["label"]]   (subroutine-style, sidenote)
 */

import type {
  WhiteboardState,
  WBNode,
  WBNodeStatus,
  WhiteboardKind,
} from './whiteboard-state';

// ── Sanitization helpers ────────────────────────────────────────────────────

/**
 * Mermaid is finicky with quotes / parens / brackets inside labels. We strip
 * dangerous chars and escape `"` to `'`. Keep label readable.
 */
function sanitizeLabel(s: string): string {
  return (s || '')
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\](){}]/g, '')
    .trim()
    .slice(0, 60);
}

function nodeShape(n: WBNode): string {
  const label = sanitizeLabel(n.label);
  switch (n.kind) {
    case 'question':
      return `${n.id}[/"❓ ${label}"/]`;
    case 'decision':
      return `${n.id}["✓ ${label}"]`;
    case 'note':
      return `${n.id}[["${label}"]]`;
    case 'topic':
    default:
      return `${n.id}(("${label}"))`;
  }
}

function statusClass(status: WBNodeStatus): string {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'decided':
      return 'decided';
    case 'active':
      return 'active';
    case 'done':
      return 'done';
    default:
      return 'active';
  }
}

const CLASS_DEFS = [
  'classDef pending stroke:#FFA500,stroke-width:2px,stroke-dasharray:5 5,fill:#FFF8E7,color:#4A3500',
  'classDef decided stroke:#5F7A5C,stroke-width:2px,fill:#E8F0E5,color:#2C3E2A',
  'classDef active  stroke:#94AE91,stroke-width:1.5px,fill:#F4F8F2,color:#2C3E2A',
  'classDef done    stroke:#8A8273,stroke-width:1px,fill:#EEEAE0,color:#5B564B,opacity:0.55',
];

// ── Per-kind renderers ───────────────────────────────────────────────────────

function renderFlowchart(state: WhiteboardState, direction: 'LR' | 'TD' = 'LR'): string {
  const lines: string[] = [`flowchart ${direction}`];

  // 1) Group nodes by subgraph
  const nodesInSubgraph = new Set<string>();
  for (const sg of Object.values(state.subgraphs)) {
    if (sg.nodeIds.length === 0) continue;
    lines.push(`  subgraph ${sg.id}["${sanitizeLabel(sg.label)}"]`);
    for (const nid of sg.nodeIds) {
      const n = state.nodes[nid];
      if (!n) continue;
      lines.push(`    ${nodeShape(n)}`);
      nodesInSubgraph.add(nid);
    }
    lines.push('  end');
  }

  // 2) Free-floating nodes
  for (const n of Object.values(state.nodes)) {
    if (nodesInSubgraph.has(n.id)) continue;
    lines.push(`  ${nodeShape(n)}`);
  }

  // 3) Edges
  for (const e of state.edges) {
    const arrow = e.kind === 'resolves' ? '-..->' : e.kind === 'depends' ? '-.->|deps|' : '-->';
    const label = e.label ? `|${sanitizeLabel(e.label)}|` : '';
    lines.push(`  ${e.from} ${arrow}${label} ${e.to}`);
  }

  // 4) Class assignments
  for (const n of Object.values(state.nodes)) {
    lines.push(`  class ${n.id} ${statusClass(n.status)}`);
  }
  lines.push('  %% --- styles ---');
  lines.push(...CLASS_DEFS.map((d) => `  ${d}`));

  return lines.join('\n');
}

function renderMindmap(state: WhiteboardState): string {
  const lines: string[] = ['mindmap'];
  // Build adjacency: parentId → children
  const roots: WBNode[] = [];
  const children: Record<string, WBNode[]> = {};
  for (const n of Object.values(state.nodes)) {
    if (n.parentId && state.nodes[n.parentId]) {
      (children[n.parentId] ||= []).push(n);
    } else {
      roots.push(n);
    }
  }
  if (roots.length === 0) {
    return 'mindmap\n  root((empty))';
  }
  // If multiple roots, synthesize a single "讨论" root
  if (roots.length > 1) {
    lines.push('  root((讨论))');
    for (const r of roots) writeMindmapNode(r, children, lines, 2);
  } else {
    writeMindmapNode(roots[0], children, lines, 1, true);
  }
  return lines.join('\n');
}

function writeMindmapNode(
  node: WBNode,
  children: Record<string, WBNode[]>,
  lines: string[],
  depth: number,
  isRoot = false,
): void {
  const indent = '  '.repeat(depth);
  const label = sanitizeLabel(node.label);
  let shape: string;
  if (isRoot) {
    shape = `root((${label}))`;
  } else if (node.kind === 'question') {
    shape = `${node.id}[❓ ${label}]`;
  } else if (node.kind === 'decision') {
    shape = `${node.id}[✓ ${label}]`;
  } else {
    shape = `${node.id}(${label})`;
  }
  lines.push(`${indent}${shape}`);
  const kids = children[node.id] || [];
  for (const k of kids) writeMindmapNode(k, children, lines, depth + 1);
}

function renderSequence(state: WhiteboardState): string {
  const lines: string[] = ['sequenceDiagram'];
  // Participants: deduplicate by node id
  const orderedNodes = Object.values(state.nodes);
  for (const n of orderedNodes) {
    lines.push(`  participant ${n.id} as ${sanitizeLabel(n.label)}`);
  }
  for (const e of state.edges) {
    const arrow = e.kind === 'resolves' ? '-->>' : '->>';
    const label = sanitizeLabel(e.label || '');
    lines.push(`  ${e.from}${arrow}${e.to}: ${label || 'msg'}`);
  }
  // Notes for pending questions
  for (const n of orderedNodes) {
    if (n.kind === 'question' && n.status === 'pending') {
      lines.push(`  Note over ${n.id}: ❓ open`);
    }
  }
  if (orderedNodes.length === 0) {
    lines.push('  Note over root: empty');
  }
  return lines.join('\n');
}

function renderGantt(state: WhiteboardState): string {
  const lines: string[] = ['gantt', '  title 项目排期', '  dateFormat YYYY-MM-DD'];
  // Use created/resolved times as date hints. Group by subgraph as section.
  const today = new Date();
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const sections: Record<string, WBNode[]> = {};
  const noSection: WBNode[] = [];
  for (const n of Object.values(state.nodes)) {
    if (n.subgraphId && state.subgraphs[n.subgraphId]) {
      (sections[n.subgraphId] ||= []).push(n);
    } else {
      noSection.push(n);
    }
  }
  const writeTask = (n: WBNode) => {
    const start = new Date(n.createdAt || today.getTime());
    const end = n.resolvedAt
      ? new Date(n.resolvedAt)
      : new Date(start.getTime() + 86_400_000);
    const status =
      n.status === 'done' || n.status === 'decided'
        ? 'done'
        : n.status === 'active'
          ? 'active'
          : 'crit';
    lines.push(
      `    ${sanitizeLabel(n.label)} :${status}, ${n.id}, ${fmt(start)}, ${fmt(end)}`,
    );
  };
  for (const [sgId, members] of Object.entries(sections)) {
    lines.push(`  section ${sanitizeLabel(state.subgraphs[sgId].label)}`);
    for (const n of members) writeTask(n);
  }
  if (noSection.length > 0) {
    lines.push(`  section 任务`);
    for (const n of noSection) writeTask(n);
  }
  if (Object.keys(state.nodes).length === 0) {
    lines.push('  section 空');
    lines.push(`    placeholder :crit, ph, ${fmt(today)}, 1d`);
  }
  return lines.join('\n');
}

function renderQuadrant(state: WhiteboardState): string {
  const lines: string[] = ['quadrantChart', '  title 比较 / 定位'];
  lines.push('  x-axis 低 --> 高');
  lines.push('  y-axis 低 --> 高');
  lines.push('  quadrant-1 优先');
  lines.push('  quadrant-2 待评估');
  lines.push('  quadrant-3 不做');
  lines.push('  quadrant-4 观察');
  // Without numerical coords on nodes we spread them evenly
  const nodes = Object.values(state.nodes);
  let i = 0;
  for (const n of nodes) {
    const x = 0.2 + ((i * 0.27) % 0.7);
    const y = 0.2 + ((i * 0.41) % 0.7);
    lines.push(`  ${sanitizeLabel(n.label)}: [${x.toFixed(2)}, ${y.toFixed(2)}]`);
    i++;
  }
  if (nodes.length === 0) lines.push('  placeholder: [0.5, 0.5]');
  return lines.join('\n');
}

function renderState(state: WhiteboardState): string {
  const lines: string[] = ['stateDiagram-v2'];
  for (const n of Object.values(state.nodes)) {
    lines.push(`  ${n.id} : ${sanitizeLabel(n.label)}`);
  }
  if (Object.keys(state.nodes).length > 0) {
    // Connect first node from [*] for a real start state
    const first = Object.values(state.nodes)[0];
    lines.push(`  [*] --> ${first.id}`);
  }
  for (const e of state.edges) {
    const label = sanitizeLabel(e.label || '');
    lines.push(`  ${e.from} --> ${e.to}${label ? ` : ${label}` : ''}`);
  }
  return lines.join('\n');
}

// ── Public entry ────────────────────────────────────────────────────────────

/**
 * Pure render: WhiteboardState → mermaid source (no fences).
 * Dispatches on state.kind.
 */
export function renderMermaid(state: WhiteboardState): string {
  switch (state.kind) {
    case 'mindmap':
      return renderMindmap(state);
    case 'sequence':
      return renderSequence(state);
    case 'gantt':
      return renderGantt(state);
    case 'quadrant':
      return renderQuadrant(state);
    case 'state':
      return renderState(state);
    case 'flowchart':
    default:
      return renderFlowchart(state);
  }
}

/**
 * Render a compact human-readable digest of state (for LLM context — much
 * cheaper than serializing the whole JSON, and structured so the model
 * grokks pending questions quickly).
 */
export function renderStateDigest(state: WhiteboardState): string {
  const lines: string[] = [];
  lines.push(`[白板状态] kind=${state.kind} version=${state.version} nodes=${Object.keys(state.nodes).length} edges=${state.edges.length}`);
  const pending = Object.values(state.nodes).filter(
    (n) => n.kind === 'question' && n.status === 'pending',
  );
  const decided = Object.values(state.nodes).filter(
    (n) => n.kind === 'question' && n.status === 'decided',
  );
  const topics = Object.values(state.nodes).filter((n) => n.kind === 'topic');
  if (pending.length > 0) {
    lines.push('未决问题:');
    for (const q of pending) lines.push(`  - ${q.id}: ${q.label}`);
  }
  if (decided.length > 0) {
    lines.push('已决议:');
    for (const q of decided) {
      const concl = q.resolvedBy ? state.nodes[q.resolvedBy]?.label || '?' : '?';
      lines.push(`  - ${q.id} (${q.label}) → ${concl}`);
    }
  }
  if (topics.length > 0) {
    lines.push('讨论主题:');
    for (const t of topics) lines.push(`  - ${t.id}: ${t.label} [${t.status}]`);
  }
  if (state.edges.length > 0) {
    lines.push('连线:');
    for (const e of state.edges.slice(0, 20)) {
      lines.push(`  - ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`);
    }
    if (state.edges.length > 20) lines.push(`  ... (${state.edges.length - 20} 条省略)`);
  }
  return lines.join('\n');
}
