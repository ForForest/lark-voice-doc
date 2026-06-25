/**
 * _e2e-realtime-whiteboard.ts — comprehensive headless harness for the realtime
 * creative-discussion build. No mic, no real 飞书 board. Proves the whole flow:
 *
 *   Part 1 (unit, real Doubao): RecordingSession debounce behaviour
 *     1a coalescing      — a rapid burst of chunks → ONE board redraw, not N
 *     1b incremental     — a second burst → another redraw; state version grows
 *     1c trailing-refire — a chunk arriving mid-redraw still gets drawn (no drop)
 *     1d cadence         — first redraw lands far under the old 90s timer
 *   Part 2 (server WS, dry-run push): the live wiring
 *     2a PTT live board  — a normal voice turn both replies AND scribes the board
 *     2b 火山 TTS stream  — /api/tts-stream returns real mp3 audio chunks
 *
 * Real Doubao calls (proposeTransitions + the agent) are made; the 飞书 push is
 * stubbed (injected fn in Part 1; WHITEBOARD_PUSH_DRYRUN in Part 2), so this
 * needs ARK_API_KEY + VOLC_* but NOT 飞书 OAuth.
 *
 *   Run: npx tsx scripts/_e2e-realtime-whiteboard.ts
 */
import 'dotenv/config';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { RecordingSession } from '../src/lib/agent-loop';
import { getWhiteboardManager } from '../src/lib/whiteboard-state';

const REPO = path.resolve(__dirname, '..');
const TEST_PORT = 3099;
const BASE = `http://localhost:${TEST_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { name: string; pass: boolean; detail: string }
const results: Res[] = [];
function record(name: string, pass: boolean, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Unique tokens so the on-disk state file is isolated + cleanable.
const stamp = `${process.pid}`;
const UNIT_DOC = `e2eUnitDoc_${stamp}_aaaaaaaaaa`;
const UNIT_WB = `e2eUnitWb_${stamp}_bbbbbbbbbb`;

// ── Part 1: RecordingSession debounce (unit, no server) ──────────────────────
async function part1() {
  console.log('\n── Part 1: RecordingSession debounce (real Doubao proposer) ──');
  const pushes: { mermaid: string; at: number }[] = [];
  let slowPushMs = 0;
  const errors: string[] = [];

  const rec = new RecordingSession({
    debounceMs: 800,
    maxWaitMs: 5000,
    pushWhiteboard: async (_wb, mermaid) => {
      if (slowPushMs) await sleep(slowPushMs);
      pushes.push({ mermaid, at: Date.now() });
    },
    onSummaryError: (e) => errors.push(e.message),
    onSummarySkipped: (r) => console.log('   [skipped]', r),
  });
  rec.setTarget({ docToken: UNIT_DOC, whiteboardToken: UNIT_WB, title: '创意讨论测试' });

  const mgr = getWhiteboardManager();

  // 1a — coalescing: 4 rapid chunks in one breath → exactly ONE redraw.
  const burst1Start = Date.now();
  for (const t of [
    '我想做一个语音创意工具',
    '核心是边聊边在白板上记录想法',
    '用豆包做对话, 智商要高',
    '白板用飞书的, 实时更新',
  ]) {
    rec.addTranscript(Date.now(), t);
    await sleep(120);
  }
  // wait for the debounce + LLM to land one push
  await waitUntil(() => pushes.length >= 1, 40000);
  await sleep(1500); // give any erroneous extra pushes a chance to (not) appear
  record('1a coalescing: rapid burst → single redraw', pushes.length === 1, `pushes=${pushes.length}`);
  record('1d cadence: first redraw far under 90s', pushes.length >= 1 && pushes[0].at - burst1Start < 30000,
    pushes.length ? `${pushes[0].at - burst1Start}ms` : 'no push');

  // 1b — incremental: a second topic → another redraw; state version advances.
  const verAfter1 = (await mgr.load(UNIT_DOC, UNIT_WB)).version;
  const pushesAfter1 = pushes.length;
  for (const t of ['对了, 还要支持语音回复', '回复用火山的 TTS, 音色自然一点']) {
    rec.addTranscript(Date.now(), t);
    await sleep(120);
  }
  await waitUntil(() => pushes.length > pushesAfter1, 40000);
  await sleep(800);
  const verAfter2 = (await mgr.load(UNIT_DOC, UNIT_WB)).version;
  record('1b incremental: second burst → another redraw', pushes.length === pushesAfter1 + 1,
    `pushes ${pushesAfter1}→${pushes.length}`);
  record('1b incremental: whiteboard state version advanced', verAfter2 > verAfter1, `v${verAfter1}→v${verAfter2}`);

  // 1c — trailing re-fire: a chunk that lands while a redraw is in flight must
  // still get drawn (the single-flight guard must not drop it).
  slowPushMs = 2000; // widen the in-flight window deterministically
  const pushesAfter2 = pushes.length;
  rec.addTranscript(Date.now(), '再补一点: 用户不传照片也能用'); // arms debounce
  await sleep(1300); // debounce(800) elapsed → now mid proposeTransitions/slow-push
  rec.addTranscript(Date.now(), '这条想法也要画上去, 别丢了'); // lands during in-flight → dirty
  await waitUntil(() => pushes.length >= pushesAfter2 + 2, 45000);
  record('1c trailing re-fire: mid-redraw chunk not dropped', pushes.length >= pushesAfter2 + 2,
    `pushes ${pushesAfter2}→${pushes.length}`);

  // 1e — dispose() cancels an armed redraw: no zombie push after teardown.
  slowPushMs = 0;
  const pushesBeforeDispose = pushes.length;
  rec.addTranscript(Date.now(), '这条不该画——马上就 dispose 了'); // arms the debounce
  rec.dispose(); // tears down — must cancel the armed timer + block new ones
  rec.addTranscript(Date.now(), '这条也不该画——已经 closed'); // must be ignored
  await sleep(4000); // well past debounce(800) + a propose window
  record('1e dispose: no zombie redraw after teardown', pushes.length === pushesBeforeDispose,
    `pushes ${pushesBeforeDispose}→${pushes.length}`);

  record('1 no summary errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  // cleanup the on-disk state for this test doc
  try { await mgr.deleteOnDisk(UNIT_DOC); } catch {}
}

// ── Part 2: server WS + TTS (dry-run push) ───────────────────────────────────
let server: ChildProcess | null = null;

async function startServer() {
  const tsxBin = path.join(REPO, 'node_modules', '.bin', 'tsx');
  server = spawn(tsxBin, ['src/server.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      WHITEBOARD_PUSH_DRYRUN: '1',
      // Keep the agent turn fast + deterministic for the wiring test (we're
      // verifying the live-board + reply path, not the agent's reasoning depth).
      DOUBAO_AGENT_THINKING: 'disabled',
      // Fail-fast any stray lark CLI call (the test uses a fake token + the
      // user OAuth may be expired) so the agent turn can't stall on retries.
      LARK_CMD_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', () => {});
  server.stderr?.on('data', (d) => { const s = d.toString(); if (/error|Error/.test(s)) process.stderr.write('[server] ' + s); });
  // poll health
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function wsConnect(): Promise<{ ws: WebSocket; evts: any[]; send: (o: any) => void; waitFor: (f: (e: any) => boolean, ms?: number) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/conversation`);
    const evts: any[] = [];
    ws.on('message', (d) => { try { evts.push(JSON.parse(d.toString())); } catch {} });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, evts,
      send: (o: any) => ws.send(JSON.stringify(o)),
      waitFor: (f, ms = 60000) => new Promise((res, rej) => {
        const start = Date.now();
        const t = setInterval(() => {
          const found = evts.find(f);
          if (found) { clearInterval(t); res(found); }
          else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); }
        }, 30);
      }),
    }));
  });
}

async function part2() {
  console.log('\n── Part 2: server WS + 火山 TTS (dry-run 飞书 push) ──');
  const booted = await startServer();
  record('2 server boots on :' + TEST_PORT, booted, booted ? '' : 'health never came up');
  if (!booted) return;

  // 2a — PTT live board: one normal turn replies AND scribes the board.
  const PTT_DOC = `e2ePttDoc_${stamp}_cccccccccc`;
  const PTT_WB = `e2ePttWb_${stamp}_dddddddddd`;
  try {
    const c = await wsConnect();
    await c.waitFor((e) => e.type === 'ready');
    c.send({ type: 'bind-target', docToken: PTT_DOC, whiteboardToken: PTT_WB, title: '创意讨论' });
    await c.waitFor((e) => e.type === 'bind-state');
    // Conversational prompt that elicits a spoken reply WITHOUT triggering
    // doc/whiteboard tool calls (which would hit the real CLI on a fake token).
    c.send({ type: 'user-final', text: '用一两句话聊聊"边聊边画白板"这个创意好在哪，不用建文档也不用画图，就说说看法。' });
    // The board scribe should redraw (summary-pushed) live, in parallel with the reply.
    const pushed = await c.waitFor((e) => e.type === 'summary-pushed' || e.type === 'summary-error', 60000);
    record('2a PTT live board: turn redraws the board', pushed.type === 'summary-pushed',
      pushed.type === 'summary-pushed' ? `mermaid ${pushed.mermaid?.length}ch` : 'err: ' + pushed.error);
    const done = await c.waitFor((e) => e.type === 'turn-done', 90000);
    record('2a PTT live board: agent also replied (voice path)', !!done && typeof done.text === 'string' && done.text.length > 0,
      done?.text ? `"${done.text.slice(0, 40)}…"` : 'no reply');
    c.ws.close();
    try { await getWhiteboardManager().deleteOnDisk(PTT_DOC); } catch {}
  } catch (e) {
    record('2a PTT live board', false, (e as Error).message);
  }

  // 2b — 火山 TTS stream through the server.
  try {
    const res = await fetch(`${BASE}/api/tts-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '好的，我们开始吧。', format: 'mp3' }),
    });
    const text = await res.text(); // SSE body
    const mp3Chunks = (text.match(/"mp3Chunk"/g) || []).length;
    const done = /"done"\s*:\s*true/.test(text);
    record('2b 火山 TTS stream returns audio', mp3Chunks > 0 && done, `mp3 chunks=${mp3Chunks}, done=${done}`);
  } catch (e) {
    record('2b 火山 TTS stream', false, (e as Error).message);
  }
}

async function waitUntil(pred: () => boolean, ms: number) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timeout');
    await sleep(50);
  }
}

(async () => {
  console.log('=== realtime whiteboard E2E harness ===');
  if (!process.env.ARK_API_KEY) { console.error('ARK_API_KEY required'); process.exit(2); }
  try {
    await part1();
    await part2();
  } catch (e) {
    console.error('harness crash:', (e as Error).message);
    record('harness completed', false, (e as Error).message);
  } finally {
    if (server) { try { server.kill('SIGTERM'); } catch {} }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  await sleep(300);
  process.exit(passed === results.length ? 0 : 1);
})();
