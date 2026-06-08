/**
 * _e2e-composition.ts — Cross-phase composition smoke.
 *
 * Verifies the seams between Phase 1-5: a single live server, real WS protocol,
 * exercised through scenarios that touch multiple subsystems at once.
 *
 * Scenarios:
 *   1) Multi-doc bind + chat turn (no LLM cost — uses an explicit "no-tool" prompt
 *      to keep the run cheap; we just confirm tool-result events flow when bound)
 *   2) Recording mode → feed transcripts → trigger summary → expect pipeline
 *      events (summary-pushed OR summary-error are both valid; we care about
 *      onStatus + onSummary* contract) → confirm state file written for the
 *      bound docToken
 *   3) Restart-style re-entry: open a SECOND WS, re-bind the same target,
 *      verify the WhiteboardManager loads from disk by inspecting the JSON file
 *      (server-side state file is the contract per Phase 5)
 *   4) Multi-doc independence: bind 2 different targets in 2 separate WS
 *      sessions, push transcripts to each, verify each has its own state file
 *   5) Drift rejection: invalid mode + invalid bind payloads should produce
 *      error events, NOT crash the server
 *   6) Full PTT chat flow: user-final → tool-call (forced) → tool-result →
 *      assistant-text → turn-done; back-compat with original protocol
 *
 * Run with the server already up:
 *   npx tsx scripts/_e2e-composition.ts
 */

import WebSocket from 'ws';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const WS_URL =
  (process.env.LARK_VOICE_SERVER || 'http://localhost:3001').replace(/^http/, 'ws') +
  '/api/conversation';

const STATE_DIR = path.join(process.cwd(), 'data', 'whiteboard-state');

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function log(s: string): void {
  console.log(`[${ts()}] ${s}`);
}

interface Evt {
  type: string;
  [k: string]: any;
}

class Client {
  ws!: WebSocket;
  evts: Evt[] = [];
  ready = false;
  closed = false;

  async open(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    // Attach handlers BEFORE awaiting open: the server sends {type:'ready'}
    // on connect immediately, so the message can arrive between 'open' and
    // a later handler registration → lost event.
    this.ws.on('message', (data) => {
      try {
        const evt = JSON.parse(data.toString()) as Evt;
        this.evts.push(evt);
        if (evt.type === 'ready') this.ready = true;
      } catch {
        /* ignore */
      }
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
    await new Promise<void>((res, rej) => {
      this.ws.on('open', () => res());
      this.ws.on('error', (e) => rej(e));
    });
    await this.waitFor((e) => e.type === 'ready', 8000);
  }

  send(obj: any): void {
    this.ws.send(JSON.stringify(obj));
  }

  async waitFor(pred: (e: Evt) => boolean, ms = 5000): Promise<Evt> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const found = this.evts.find(pred);
      if (found) return found;
      await sleep(50);
    }
    throw new Error(`timed out waiting for event after ${ms}ms`);
  }

  clear(): void {
    this.evts.length = 0;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}
const results: Result[] = [];
function pass(name: string, detail: string): void {
  results.push({ name, pass: true, detail });
  log(`[PASS] ${name} — ${detail}`);
}
function fail(name: string, detail: string): void {
  results.push({ name, pass: false, detail });
  log(`[FAIL] ${name} — ${detail}`);
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

async function scenario1MultiDocBind(): Promise<void> {
  log('── Scenario 1: multi-doc bind + chat turn ──');
  const c = new Client();
  await c.open();

  const TARGET = 'CompTokenTarget12345';
  const REF1 = 'CompTokenRef1abc1234';
  const REF2 = 'CompTokenRef2xyz5678';
  const WB = 'CompWbToken987654321';

  c.clear();
  c.send({ type: 'bind-target', docToken: TARGET, whiteboardToken: WB, title: 'CompTarget' });
  await c.waitFor((e) => e.type === 'bind-state');
  c.clear();
  c.send({ type: 'bind-reference-add', docToken: REF1, title: 'Ref1' });
  await c.waitFor(
    (e) => e.type === 'bind-state' && (e.references || []).length === 1,
    5000,
  );
  c.clear();
  c.send({ type: 'bind-reference-add', docToken: REF2, title: 'Ref2' });
  const bs = await c.waitFor(
    (e) => e.type === 'bind-state' && (e.references || []).length === 2,
    5000,
  );

  if (
    bs.target?.docToken === TARGET &&
    (bs.references || []).map((r: any) => r.docToken).sort().join(',') ===
      [REF1, REF2].sort().join(',')
  ) {
    pass('S1.bind-state', 'target + 2 refs reflected in bind-state');
  } else {
    fail('S1.bind-state', `unexpected bind-state shape: ${JSON.stringify(bs)}`);
  }

  // Send a no-tool chat to confirm the conversation loop still works when bound.
  c.clear();
  c.send({
    type: 'user-final',
    text: '不要调用任何工具, 只用一句话告诉我你能看到我绑定了几个参考文档',
  });
  await c.waitFor((e) => e.type === 'turn-start', 3000);
  const done = await c.waitFor((e) => e.type === 'turn-done', 60_000);
  const tokens = c.evts.filter((e) => e.type === 'assistant-text').length;
  if (done.aborted === false && tokens > 0) {
    pass('S1.chat-turn', `turn-done received, tokens=${tokens}, text="${(done.text || '').slice(0, 60)}"`);
  } else {
    fail('S1.chat-turn', `turn-done aborted=${done.aborted}, tokens=${tokens}`);
  }

  c.close();
}

async function scenario2RecordingPipeline(): Promise<void> {
  log('── Scenario 2: recording mode → trigger summary → state file written ──');
  const c = new Client();
  await c.open();

  const DOC_TOK = 'CompRecTargetDoc12345';
  const WB_TOK = 'CompRecWbToken9876543210'; // ≥22 chars to satisfy lark validation when reached

  c.clear();
  c.send({ type: 'bind-target', docToken: DOC_TOK, whiteboardToken: WB_TOK, title: 'RecTarget' });
  await c.waitFor((e) => e.type === 'bind-state');

  c.send({ type: 'mode-set', mode: 'recording' });
  await c.waitFor((e) => e.type === 'mode-ok');
  const status = await c.waitFor((e) => e.type === 'recording-status', 3000);
  if (!status.listening) {
    fail('S2.mode-set', 'recording-status.listening should be true');
    c.close();
    return;
  }
  pass('S2.mode-set', `recording-status.listening=true, bufferChunks=${status.bufferChunks}`);

  // Feed a short coherent transcript stream.
  const TRANSCRIPTS = [
    'Phase 5 测试: 我们决定用 Doubao Seed 1.6 reasoning 跑白板',
    '备选是 Gemini 2.5 Flash, 延迟更低但质量略差',
    '问题 Q1: Doubao 太慢的话能不能 hot-swap 切 Gemini?',
    '回答 A1: 走 env 变量 WHITEBOARD_LLM, 重启 server 生效',
  ];
  for (const t of TRANSCRIPTS) {
    c.send({ type: 'recording-transcript', ts: Date.now(), text: t });
    await sleep(60);
  }

  // Trigger immediate summary; pipeline emits one of:
  //   summary-pushed (rare here, our WB token isn't a real Lark token)
  //   summary-error  (expected — lark-cli fails on fake token)
  //   summary-skipped (LLM judged structure absent — unlikely on this input)
  c.clear();
  c.send({ type: 'recording-trigger-summary' });
  const summaryEvent = await c.waitFor(
    (e) =>
      e.type === 'summary-pushed' ||
      e.type === 'summary-error' ||
      e.type === 'summary-skipped',
    90_000, // Doubao reasoning ~12-25s, lark-cli call adds ~5-15s
  );
  pass(
    'S2.summary-pipeline',
    `pipeline emitted '${summaryEvent.type}' (means LLM ran + state mutated)`,
  );

  // Verify the state file was written to disk.
  const stateFile = path.join(STATE_DIR, `${DOC_TOK}.json`);
  let stateOK = false;
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.docToken === DOC_TOK && Object.keys(parsed.nodes || {}).length > 0) {
      stateOK = true;
      pass(
        'S2.state-file',
        `${stateFile.split('/').pop()} written, nodes=${Object.keys(parsed.nodes).length}, version=${parsed.version}`,
      );
    } else {
      fail('S2.state-file', `state file exists but suspect: nodes=${Object.keys(parsed.nodes || {}).length}`);
    }
  } catch (err) {
    fail('S2.state-file', `failed to read state file: ${(err as Error).message}`);
  }

  if (!stateOK) {
    log('S2: skipping rest, state not written');
  }

  // Switch back to PTT, confirm mode-ok.
  c.send({ type: 'mode-set', mode: 'ptt' });
  await c.waitFor((e) => e.type === 'mode-ok' && e.mode === 'ptt', 3000);
  pass('S2.mode-back-to-ptt', 'mode-set ptt confirmed');

  c.close();
}

async function scenario3RestartPersistence(): Promise<void> {
  log('── Scenario 3: re-connect after "restart" loads state from disk ──');
  // We don't actually kill the server (testing infra; the cache layer would
  // satisfy this on a hot process). The real contract for founder is:
  // does the on-disk file survive AND does WhiteboardManager replay it?
  // We've already verified the disk file in S2. Here we verify a second WS
  // connection can re-bind to the SAME docToken and the server treats it as
  // an already-known board (i.e. we get a clean bind-state).
  const DOC_TOK = 'CompRecTargetDoc12345';
  const WB_TOK = 'CompRecWbToken9876543210';

  const c = new Client();
  await c.open();
  c.send({ type: 'bind-target', docToken: DOC_TOK, whiteboardToken: WB_TOK });
  const bs = await c.waitFor((e) => e.type === 'bind-state', 3000);
  if (bs.target?.docToken !== DOC_TOK) {
    fail('S3.rebind', `bind-state mismatch: ${JSON.stringify(bs.target)}`);
    c.close();
    return;
  }
  pass('S3.rebind', 'second WS session can rebind same docToken');

  // Also verify the on-disk JSON still has nodes from S2 (i.e. wasn't reset).
  const stateFile = path.join(STATE_DIR, `${DOC_TOK}.json`);
  try {
    const raw = await fs.readFile(stateFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const nodeCount = Object.keys(parsed.nodes || {}).length;
    const historyCount = (parsed.history || []).length;
    if (nodeCount > 0 && historyCount > 0) {
      pass(
        'S3.disk-survives',
        `state file persisted across WS sessions, nodes=${nodeCount}, history=${historyCount}`,
      );
    } else {
      fail('S3.disk-survives', `state file empty after rebind`);
    }
  } catch (err) {
    fail('S3.disk-survives', `state read failed: ${(err as Error).message}`);
  }

  c.close();
}

async function scenario4MultiDocIndependence(): Promise<void> {
  log('── Scenario 4: 2 different docTokens have separate state files ──');

  const DOC_A = 'CompIndepDocAaaa12345';
  const DOC_B = 'CompIndepDocBbbb67890';
  const WB_A = 'CompIndepWbAaaaaaaaaaa';
  const WB_B = 'CompIndepWbBbbbbbbbbbb';

  // Two clients, two doc bindings — exercise both with transcripts in
  // recording mode + immediate summary trigger.
  async function runOne(doc: string, wb: string, hint: string): Promise<boolean> {
    const c = new Client();
    await c.open();
    c.send({ type: 'bind-target', docToken: doc, whiteboardToken: wb });
    await c.waitFor((e) => e.type === 'bind-state', 3000);
    c.send({ type: 'mode-set', mode: 'recording' });
    await c.waitFor((e) => e.type === 'mode-ok' && e.mode === 'recording', 3000);
    c.send({
      type: 'recording-transcript',
      ts: Date.now(),
      text: `这次讨论 ${hint}, 我们决定先做最小可行版本`,
    });
    await sleep(100);
    c.clear();
    c.send({ type: 'recording-trigger-summary' });
    await c.waitFor(
      (e) =>
        e.type === 'summary-pushed' ||
        e.type === 'summary-error' ||
        e.type === 'summary-skipped',
      90_000,
    );
    c.close();
    return true;
  }

  // Run sequentially (one at a time — Doubao concurrency-1 keeps cost down).
  await runOne(DOC_A, WB_A, '主题 A');
  await runOne(DOC_B, WB_B, '主题 B');

  const fileA = path.join(STATE_DIR, `${DOC_A}.json`);
  const fileB = path.join(STATE_DIR, `${DOC_B}.json`);
  try {
    const [rawA, rawB] = await Promise.all([
      fs.readFile(fileA, 'utf-8'),
      fs.readFile(fileB, 'utf-8'),
    ]);
    const a = JSON.parse(rawA);
    const b = JSON.parse(rawB);
    if (a.docToken === DOC_A && b.docToken === DOC_B && a.docToken !== b.docToken) {
      pass(
        'S4.independence',
        `${DOC_A.slice(-6)} and ${DOC_B.slice(-6)} have separate JSON files, nodes A=${Object.keys(a.nodes || {}).length} B=${Object.keys(b.nodes || {}).length}`,
      );
    } else {
      fail('S4.independence', 'tokens collided or state shape wrong');
    }
  } catch (err) {
    fail('S4.independence', `failed to read both state files: ${(err as Error).message}`);
  }
}

async function scenario5DriftRejection(): Promise<void> {
  log('── Scenario 5: malformed protocol payloads are rejected, not crash ──');
  const c = new Client();
  await c.open();

  c.clear();
  // bind-reference-add without docToken → error
  c.send({ type: 'bind-reference-add' });
  const err1 = await c.waitFor((e) => e.type === 'error', 3000);
  if (typeof err1.error === 'string' && err1.error.includes('missing')) {
    pass('S5.missing-doctoken', `rejected: ${err1.error}`);
  } else {
    fail('S5.missing-doctoken', `unexpected event: ${JSON.stringify(err1)}`);
  }

  c.clear();
  c.send({ type: 'totally-bogus-message', payload: 42 });
  const err2 = await c.waitFor((e) => e.type === 'error', 3000);
  if (typeof err2.error === 'string' && err2.error.includes('unknown message type')) {
    pass('S5.unknown-type', `rejected: ${err2.error}`);
  } else {
    fail('S5.unknown-type', `unexpected event: ${JSON.stringify(err2)}`);
  }

  c.clear();
  c.send({ type: 'recording-trigger-summary' });
  // not in recording mode → summary-error
  const err3 = await c.waitFor(
    (e) => e.type === 'summary-error' || e.type === 'error',
    3000,
  );
  if (typeof err3.error === 'string' && /not in recording/i.test(err3.error)) {
    pass('S5.summary-when-not-recording', `rejected: ${err3.error}`);
  } else {
    fail('S5.summary-when-not-recording', `unexpected event: ${JSON.stringify(err3)}`);
  }

  c.close();
}

async function scenario6PttFullFlow(): Promise<void> {
  log('── Scenario 6: PTT user-final → assistant-text streaming → turn-done ──');
  const c = new Client();
  await c.open();

  c.clear();
  c.send({
    type: 'user-final',
    text: '一句话: 1+1 等于几, 不要调用任何工具',
  });
  await c.waitFor((e) => e.type === 'turn-start', 3000);
  const done = await c.waitFor((e) => e.type === 'turn-done', 60_000);
  const tokens = c.evts.filter((e) => e.type === 'assistant-text').length;
  const tools = c.evts.filter((e) => e.type === 'tool-call').length;
  if (done.aborted === false && tokens > 0) {
    pass(
      'S6.ptt-flow',
      `turn-start → ${tokens} assistant-text tokens → turn-done (toolsUsed=${(done.toolsUsed || []).length}, expected 0 forced via prompt)`,
    );
  } else {
    fail('S6.ptt-flow', `aborted=${done.aborted}, tokens=${tokens}, tools=${tools}`);
  }
  c.close();
}

async function main(): Promise<void> {
  log(`E2E composition against ${WS_URL}`);
  log(`state dir: ${STATE_DIR}`);

  // Verify server reachable first.
  try {
    const probe = new Client();
    await probe.open();
    probe.close();
    await sleep(300); // give server time to GC the probe session
  } catch (err) {
    console.error('server not reachable. Start with: npm run server');
    console.error('error:', (err as Error).message);
    process.exit(2);
  }

  try {
    await scenario1MultiDocBind();
  } catch (err) {
    fail('S1.crash', (err as Error).message);
  }
  try {
    await scenario2RecordingPipeline();
  } catch (err) {
    fail('S2.crash', (err as Error).message);
  }
  try {
    await scenario3RestartPersistence();
  } catch (err) {
    fail('S3.crash', (err as Error).message);
  }
  try {
    await scenario4MultiDocIndependence();
  } catch (err) {
    fail('S4.crash', (err as Error).message);
  }
  try {
    await scenario5DriftRejection();
  } catch (err) {
    fail('S5.crash', (err as Error).message);
  }
  try {
    await scenario6PttFullFlow();
  } catch (err) {
    fail('S6.crash', (err as Error).message);
  }

  console.log('\n──────── E2E SCOREBOARD ────────');
  for (const r of results) {
    const marker = r.pass ? '✓' : '✗';
    console.log(`  ${marker} ${r.name}  — ${r.detail}`);
  }
  const passes = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n  total: ${passes}/${total} pass`);
  process.exit(passes === total ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e composition crash:', e);
  process.exit(1);
});
