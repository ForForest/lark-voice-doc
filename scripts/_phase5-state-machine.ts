/**
 * _phase5-state-machine.ts — Validation suite for the persistent whiteboard
 * state machine. Five scenarios, no server required.
 *
 *   1. Pending question lifecycle (add question → resolve → check graph)
 *   2. Persistence across simulated "server restart"
 *   3. Drift rejection (LLM proposes invalid transitions, state unchanged)
 *   4. change_kind (flowchart → mindmap reuses parentId)
 *   5. Multi-doc independence (two docTokens, separate states)
 *
 * Run:
 *   npx tsx scripts/_phase5-state-machine.ts
 *
 * Each scenario prints PASS/FAIL with diagnostics. Exits non-zero on any fail.
 */

import 'dotenv/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  WhiteboardManager,
  emptyState,
  applyTransition,
  type WBTransition,
  type WhiteboardState,
} from '../src/lib/whiteboard-state';
import { renderMermaid, renderStateDigest } from '../src/lib/whiteboard-render';
import {
  proposeTransitions,
  validateTransitions,
} from '../src/lib/whiteboard-llm';

const TEST_DATA_DIR = path.join(process.cwd(), 'data', 'whiteboard-state-test');

const results: { name: string; ok: boolean; detail: string }[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

function assertEq<T>(actual: T, expected: T, label: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.log(`  ↳ ${label} mismatch:\n      actual=${a}\n      expected=${e}`);
    return false;
  }
  return true;
}

async function cleanDataDir() {
  try {
    const files = await fs.readdir(TEST_DATA_DIR);
    for (const f of files) {
      if (f.endsWith('.json') || f.endsWith('.tmp')) {
        await fs.unlink(path.join(TEST_DATA_DIR, f)).catch(() => {});
      }
    }
  } catch {
    // dir doesn't exist
  }
}

// ── Scenario 1: pending question lifecycle ──────────────────────────────────

async function scenario1_pendingLifecycle() {
  console.log('\n── Scenario 1: pending question lifecycle ──');
  const mgr = new WhiteboardManager(TEST_DATA_DIR);
  const docToken = 'doc_s1_pending';
  await mgr.deleteOnDisk(docToken);

  // Turn 1: Beeni adds a topic + pending question
  const r1 = await mgr.mutate(
    docToken,
    [
      { action: 'add_node', node: { id: 'N1', kind: 'topic', label: 'whiteboard 选模型', status: 'active' } },
      { action: 'add_node', node: { id: 'Q1', kind: 'question', label: '用 Doubao 还是 Gemini?', status: 'pending' } },
      { action: 'add_edge', edge: { from: 'N1', to: 'Q1' } },
    ],
    { turnId: 't1', byLLM: 'manual' },
    'wb_s1',
  );
  if (r1.appliedCount !== 3) {
    record('S1.1 turn1 applies 3 transitions', false, `applied=${r1.appliedCount}`);
    return;
  }
  if (r1.state.nodes['Q1']?.status !== 'pending') {
    record('S1.1 Q1 is pending', false, 'status=' + r1.state.nodes['Q1']?.status);
    return;
  }
  const m1 = renderMermaid(r1.state);
  if (!m1.includes('❓') || !m1.includes('pending')) {
    record('S1.1 Q1 renders as pending (orange dashed)', false, 'mermaid missing pending class or ❓');
    console.log('mermaid:\n' + m1);
    return;
  }
  record('S1.1 add pending question + render', true, `nodes=${Object.keys(r1.state.nodes).length} edges=${r1.state.edges.length}`);

  // Turn 2: resolve Q1
  const r2 = await mgr.mutate(
    docToken,
    [
      { action: 'resolve_question', questionId: 'Q1', conclusion: '用 Doubao', resolvedById: 'A1' },
    ],
    { turnId: 't2', byLLM: 'manual' },
  );
  if (r2.appliedCount !== 1) {
    record('S1.2 resolve_question applies', false, `applied=${r2.appliedCount} reasons=${r2.reasons.join('|')}`);
    return;
  }
  const q1After = r2.state.nodes['Q1'];
  const a1 = r2.state.nodes['A1'];
  if (q1After.status !== 'decided' || q1After.resolvedBy !== 'A1') {
    record('S1.2 Q1 marked decided + resolvedBy=A1', false, JSON.stringify(q1After));
    return;
  }
  if (!a1 || a1.kind !== 'decision' || a1.label !== '用 Doubao') {
    record('S1.2 decision node A1 created', false, JSON.stringify(a1));
    return;
  }
  const m2 = renderMermaid(r2.state);
  if (!m2.includes('A1') || !m2.includes('✓') || !m2.includes('decided')) {
    record('S1.2 A1 renders as decided (green solid)', false, 'mermaid missing decided class');
    console.log('mermaid:\n' + m2);
    return;
  }
  record('S1.2 resolve_question → mermaid updated', true, `nodes=${Object.keys(r2.state.nodes).length}`);

  // History has 2 entries
  if (r2.state.history.length !== 2) {
    record('S1.3 history has 2 events', false, `len=${r2.state.history.length}`);
    return;
  }
  record('S1.3 history audit log', true, `2 events recorded`);

  record('S1 OVERALL', true, '');
}

// ── Scenario 2: persistence across simulated server restart ─────────────────

async function scenario2_persistence() {
  console.log('\n── Scenario 2: persistence across "server restart" ──');
  const docToken = 'doc_s2_restart';
  await new WhiteboardManager(TEST_DATA_DIR).deleteOnDisk(docToken);

  // Run 1: build a 5-turn state
  const mgr1 = new WhiteboardManager(TEST_DATA_DIR);
  for (let i = 1; i <= 5; i++) {
    await mgr1.mutate(
      docToken,
      [
        { action: 'add_node', node: { id: `T${i}`, kind: 'topic', label: `topic ${i}`, status: 'active' } },
      ],
      { turnId: `t${i}`, byLLM: 'manual' },
      'wb_s2',
    );
  }
  const before = await mgr1.load(docToken);
  const beforeNodes = Object.keys(before.nodes).sort();
  const beforeVersion = before.version;
  const beforeHistory = before.history.length;

  // Simulate restart: NEW manager instance, fresh cache
  const mgr2 = new WhiteboardManager(TEST_DATA_DIR);
  const after = await mgr2.load(docToken);
  const afterNodes = Object.keys(after.nodes).sort();

  if (!assertEq(afterNodes, beforeNodes, 'nodes')) {
    record('S2.1 nodes survive restart', false, '');
    return;
  }
  if (after.version !== beforeVersion) {
    record('S2.1 version matches', false, `before=${beforeVersion} after=${after.version}`);
    return;
  }
  if (after.history.length !== beforeHistory) {
    record('S2.1 history matches', false, `before=${beforeHistory} after=${after.history.length}`);
    return;
  }
  record('S2.1 5 turns survive restart', true, `nodes=${afterNodes.length} version=${after.version}`);

  // Replay should give identical state
  const replayed = mgr2.replay(after);
  if (!assertEq(Object.keys(replayed.nodes).sort(), beforeNodes, 'replayed nodes')) {
    record('S2.2 replay matches', false, '');
    return;
  }
  record('S2.2 replay reconstructs', true, `${replayed.history.length} events replayed`);

  record('S2 OVERALL', true, '');
}

// ── Scenario 3: drift rejection ──────────────────────────────────────────────

async function scenario3_driftRejection() {
  console.log('\n── Scenario 3: drift rejection ──');
  const docToken = 'doc_s3_drift';
  const mgr = new WhiteboardManager(TEST_DATA_DIR);
  await mgr.deleteOnDisk(docToken);

  // Seed: 1 topic, 1 pending question
  await mgr.mutate(
    docToken,
    [
      { action: 'add_node', node: { id: 'N1', kind: 'topic', label: 'real topic', status: 'active' } },
      { action: 'add_node', node: { id: 'Q1', kind: 'question', label: 'real Q', status: 'pending' } },
    ],
    { turnId: 't0', byLLM: 'manual' },
    'wb_s3',
  );
  const seedNodes = Object.keys((await mgr.load(docToken)).nodes).sort();

  // Now apply a flood of garbage transitions: nonexistent ids, bad statuses,
  // resolve already-decided questions, edges to missing nodes, etc.
  const garbage: WBTransition[] = [
    { action: 'resolve_question', questionId: 'Q999', conclusion: 'fake', resolvedById: 'A999' },
    { action: 'update_status', nodeId: 'N_NOT_EXIST', status: 'done' },
    { action: 'relabel', nodeId: 'X42', newLabel: 'phantom' },
    { action: 'add_edge', edge: { from: 'GHOST1', to: 'GHOST2' } },
    { action: 'remove_node', nodeId: 'Z1' },
    { action: 'add_node', node: { id: 'N1', kind: 'topic', label: 'duplicate id different label', status: 'active' } },
    // One valid one mixed in, just to confirm partial-success works
    { action: 'add_node', node: { id: 'N2', kind: 'note', label: 'valid', status: 'active' } },
  ];
  const r = await mgr.mutate(docToken, garbage, { turnId: 't_garbage', byLLM: 'manual' });
  const rejected = r.results.filter((x) => !x).length;
  if (rejected < 6) {
    record('S3.1 server rejects bad transitions', false, `rejected=${rejected}/7`);
    return;
  }
  if (r.appliedCount !== 1) {
    record('S3.2 only the valid one applied', false, `applied=${r.appliedCount}`);
    return;
  }
  // Q1 still pending (resolve_question on Q999 should not have touched Q1)
  const after = await mgr.load(docToken);
  if (after.nodes['Q1'].status !== 'pending') {
    record('S3.3 Q1 still pending', false, `status=${after.nodes['Q1'].status}`);
    return;
  }
  // History records the rejections (audit trail)
  const lastEvt = after.history[after.history.length - 1];
  if (!lastEvt || lastEvt.transitions.length !== garbage.length) {
    record('S3.4 history records attempted (incl rejected)', false, '');
    return;
  }
  if (lastEvt.reasons.filter((r) => r).length < 6) {
    record('S3.4 history records rejection reasons', false, `reasons=${JSON.stringify(lastEvt.reasons)}`);
    return;
  }
  record('S3 OVERALL', true, `${rejected} rejected, 1 applied, audit log preserved`);
}

// ── Scenario 4: change_kind keeps nodes ─────────────────────────────────────

async function scenario4_changeKind() {
  console.log('\n── Scenario 4: change_kind preserves nodes ──');
  const docToken = 'doc_s4_kind';
  const mgr = new WhiteboardManager(TEST_DATA_DIR);
  await mgr.deleteOnDisk(docToken);

  // Build a flowchart with parent-child relationships
  await mgr.mutate(
    docToken,
    [
      { action: 'add_node', node: { id: 'root', kind: 'topic', label: 'memory', status: 'active' } },
      { action: 'add_node', node: { id: 'WM', kind: 'topic', label: '工作记忆', status: 'active', parentId: 'root' } },
      { action: 'add_node', node: { id: 'CM', kind: 'topic', label: '会话记忆', status: 'active', parentId: 'root' } },
      { action: 'add_node', node: { id: 'LF', kind: 'topic', label: '长期事实', status: 'active', parentId: 'root' } },
      { action: 'add_edge', edge: { from: 'root', to: 'WM' } },
      { action: 'add_edge', edge: { from: 'root', to: 'CM' } },
      { action: 'add_edge', edge: { from: 'root', to: 'LF' } },
    ],
    { turnId: 't1', byLLM: 'manual' },
    'wb_s4',
  );

  const flow = renderMermaid(await mgr.load(docToken));
  if (!flow.startsWith('flowchart')) {
    record('S4.1 starts as flowchart', false, flow.slice(0, 60));
    return;
  }
  record('S4.1 flowchart rendered', true, '');

  // Switch to mindmap — parentId structure should produce a tree
  const r = await mgr.mutate(
    docToken,
    [{ action: 'change_kind', newKind: 'mindmap' }],
    { turnId: 't2', byLLM: 'manual' },
  );
  if (r.state.kind !== 'mindmap') {
    record('S4.2 kind changed', false, `kind=${r.state.kind}`);
    return;
  }
  const mind = renderMermaid(r.state);
  if (!mind.startsWith('mindmap')) {
    record('S4.2 mindmap renders', false, mind.slice(0, 60));
    return;
  }
  // root should appear as root((memory))
  if (!mind.includes('root((memory))')) {
    record('S4.3 root node found in mindmap', false, mind);
    return;
  }
  // children should be indented descendants of root
  if (!mind.includes('工作记忆') || !mind.includes('会话记忆') || !mind.includes('长期事实')) {
    record('S4.3 children preserved in mindmap', false, mind);
    return;
  }
  record('S4.2 change_kind reuses parentId for mindmap tree', true, '');

  // Nodes count + history preserved through kind change
  const after = await mgr.load(docToken);
  if (Object.keys(after.nodes).length !== 4) {
    record('S4.3 nodes count preserved', false, `n=${Object.keys(after.nodes).length}`);
    return;
  }
  if (after.history.length !== 2) {
    record('S4.4 history length 2', false, `h=${after.history.length}`);
    return;
  }
  record('S4 OVERALL', true, '');
}

// ── Scenario 5: multi-doc independence ──────────────────────────────────────

async function scenario5_multiDoc() {
  console.log('\n── Scenario 5: multi-doc independence ──');
  const docA = 'doc_s5_alpha';
  const docB = 'doc_s5_beta';
  const mgr = new WhiteboardManager(TEST_DATA_DIR);
  await mgr.deleteOnDisk(docA);
  await mgr.deleteOnDisk(docB);

  await mgr.mutate(
    docA,
    [{ action: 'add_node', node: { id: 'A1', kind: 'topic', label: 'alpha topic', status: 'active' } }],
    { turnId: 't1', byLLM: 'manual' },
    'wb_alpha',
  );
  await mgr.mutate(
    docB,
    [{ action: 'add_node', node: { id: 'B1', kind: 'topic', label: 'beta topic', status: 'active' } }],
    { turnId: 't1', byLLM: 'manual' },
    'wb_beta',
  );

  const sA = await mgr.load(docA);
  const sB = await mgr.load(docB);
  if (Object.keys(sA.nodes).join(',') !== 'A1') {
    record('S5.1 docA has only A1', false, JSON.stringify(Object.keys(sA.nodes)));
    return;
  }
  if (Object.keys(sB.nodes).join(',') !== 'B1') {
    record('S5.1 docB has only B1', false, JSON.stringify(Object.keys(sB.nodes)));
    return;
  }
  // Cross-poke: write a lot to docA, ensure docB unchanged
  for (let i = 2; i <= 6; i++) {
    await mgr.mutate(
      docA,
      [{ action: 'add_node', node: { id: `A${i}`, kind: 'topic', label: `more ${i}`, status: 'active' } }],
      { turnId: `t${i}`, byLLM: 'manual' },
    );
  }
  const sAA = await mgr.load(docA);
  const sBB = await mgr.load(docB);
  if (Object.keys(sAA.nodes).length !== 6) {
    record('S5.2 docA grew to 6', false, `n=${Object.keys(sAA.nodes).length}`);
    return;
  }
  if (Object.keys(sBB.nodes).length !== 1) {
    record('S5.2 docB still 1', false, `n=${Object.keys(sBB.nodes).length}`);
    return;
  }
  // Files exist separately
  const filesA = path.join(TEST_DATA_DIR, `${docA}.json`);
  const filesB = path.join(TEST_DATA_DIR, `${docB}.json`);
  await fs.stat(filesA);
  await fs.stat(filesB);
  record('S5 OVERALL', true, 'two docs persisted independently');
}

// ── Bonus: validate proposeTransitions parser handles real LLM output ────────

async function scenarioBonus_validateParser() {
  console.log('\n── Bonus: transition parser handles malformed/valid JSON ──');
  // Cases the LLM might emit:
  const cases: { name: string; raw: string; expectedTransitions: number }[] = [
    {
      name: 'clean JSON',
      raw: '{"change_note":"ok","transitions":[{"action":"add_node","node":{"kind":"topic","label":"x","status":"active"}}]}',
      expectedTransitions: 1,
    },
    {
      name: 'fenced ```json',
      raw: '```json\n{"change_note":"ok","transitions":[{"action":"add_node","node":{"label":"y","kind":"topic","status":"active"}}]}\n```',
      expectedTransitions: 1,
    },
    {
      name: 'empty array (skip)',
      raw: '{"change_note":"无结构","transitions":[]}',
      expectedTransitions: 0,
    },
    {
      name: 'unknown action filtered',
      raw: '{"change_note":"x","transitions":[{"action":"bogus_action"},{"action":"add_node","node":{"label":"x","kind":"topic","status":"active"}}]}',
      expectedTransitions: 1,
    },
  ];
  for (const c of cases) {
    // simulate the parsing logic from proposeTransitions
    const jsonObj = (() => {
      try {
        return JSON.parse(c.raw);
      } catch {
        const fence = c.raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence)
          try {
            return JSON.parse(fence[1]);
          } catch {}
        return null;
      }
    })();
    const arr = jsonObj?.transitions || [];
    const v = validateTransitions(arr);
    if (v.transitions.length !== c.expectedTransitions) {
      record(`bonus.${c.name}`, false, `got=${v.transitions.length} want=${c.expectedTransitions}`);
      continue;
    }
    record(`bonus.${c.name}`, true, '');
  }
}

// ── (Optional) live LLM smoke: only when env keys present ───────────────────

async function scenarioLive_proposeTransitions() {
  const hasDoubao = !!process.env.ARK_API_KEY;
  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (!hasDoubao && !hasGemini) {
    console.log('\n── Live LLM smoke skipped (no API keys) ──');
    return;
  }
  console.log('\n── Live LLM smoke: proposeTransitions on real model ──');
  const fresh: WhiteboardState = emptyState('doc_live', 'wb_live');
  // seed a pending question
  applyTransition(fresh, {
    action: 'add_node',
    node: { id: 'Q1', kind: 'question', label: '用 Doubao 还是 Gemini?', status: 'pending' },
  });
  fresh.version = 1;
  try {
    const r = await proposeTransitions({
      state: fresh,
      transcript: 'Q1 我决定了, 就用 Doubao reasoning, 质量优先。',
      userHint: '请把决议落到 Q1 上',
      model: hasDoubao ? 'doubao' : 'gemini-flash',
    });
    console.log('  changeNote:', r.changeNote);
    console.log('  transitions:', JSON.stringify(r.transitions, null, 2));
    console.log('  latency:', r.latencyMs + 'ms', 'model:', r.modelUsed);
    const hasResolve = r.transitions.some(
      (t) => t.action === 'resolve_question' && (t as any).questionId === 'Q1',
    );
    record('live.resolve_question proposed', hasResolve, hasResolve ? 'ok' : 'LLM did not propose resolve_question');
  } catch (err) {
    record('live.LLM call', false, (err as Error).message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Phase 5 — WhiteboardState machine validation');
  console.log('===========================================');
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  await cleanDataDir();

  try {
    await scenario1_pendingLifecycle();
  } catch (e) {
    record('S1 OVERALL', false, (e as Error).message);
  }
  try {
    await scenario2_persistence();
  } catch (e) {
    record('S2 OVERALL', false, (e as Error).message);
  }
  try {
    await scenario3_driftRejection();
  } catch (e) {
    record('S3 OVERALL', false, (e as Error).message);
  }
  try {
    await scenario4_changeKind();
  } catch (e) {
    record('S4 OVERALL', false, (e as Error).message);
  }
  try {
    await scenario5_multiDoc();
  } catch (e) {
    record('S5 OVERALL', false, (e as Error).message);
  }
  try {
    await scenarioBonus_validateParser();
  } catch (e) {
    record('bonus OVERALL', false, (e as Error).message);
  }
  try {
    await scenarioLive_proposeTransitions();
  } catch (e) {
    record('live OVERALL', false, (e as Error).message);
  }

  console.log('\n──────── SCOREBOARD ────────');
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  for (const r of results) {
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  }
  console.log(`\n  total: ${pass} pass, ${fail} fail (of ${results.length})`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
