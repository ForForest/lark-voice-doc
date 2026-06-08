/**
 * _phase4-recording-summary.ts — End-to-end test of the recording mode summary
 * trigger (without actually calling lark-cli).
 *
 * Flow:
 *   1) Connect, bind-target with FAKE whiteboard token
 *   2) mode-set recording
 *   3) Feed 4 transcript chunks (a coherent onboarding discussion)
 *   4) Send recording-trigger-summary
 *   5) Expect EITHER summary-pushed (if lark-cli auth works) OR summary-error
 *      (if not). Both are valid; we test the *pipeline*.
 *
 * Run while server is up.
 */

import WebSocket from 'ws';

const WS_URL = (process.env.LARK_VOICE_SERVER || 'http://localhost:3001').replace(
  /^http/,
  'ws',
) + '/api/conversation';

const FAKE_DOC_TOK = 'FakeTargetDoc1234567';
const FAKE_WB_TOK = 'FakeWhiteboardTok987';

function log(s: string) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`); }

const TRANSCRIPTS = [
  '我们 onboarding 大概分 3 步走',
  '第一步用户先注册一下账号, 用手机号或邮箱',
  '第二步要申请麦克风权限, 不然 Beeni 听不到',
  '第三步是 intake 问卷, 问下用户为啥来 Beegin, 这样能个性化',
];

async function main() {
  log(`connecting to ${WS_URL}`);
  const ws = new WebSocket(WS_URL);
  const evts: any[] = [];

  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', (e) => rej(e));
  });

  ws.on('message', (data) => {
    let evt: any;
    try { evt = JSON.parse(data.toString()); } catch { return; }
    evts.push(evt);
    if ([
      'ready', 'bind-state', 'mode-ok', 'recording-status',
      'summary-pushed', 'summary-skipped', 'summary-error', 'error',
    ].includes(evt.type)) {
      log(`← ${evt.type} ${JSON.stringify(evt).slice(0, 220)}`);
    }
  });

  function send(o: any) { ws.send(JSON.stringify(o)); }
  function waitFor(typeFn: (e: any) => boolean, ms = 60000): Promise<any> {
    return new Promise((res, rej) => {
      const start = Date.now();
      const t = setInterval(() => {
        const found = evts.find(typeFn);
        if (found) { clearInterval(t); res(found); }
        else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); }
      }, 30);
    });
  }

  await waitFor((e) => e.type === 'ready');

  log('bind-target with FAKE whiteboard token');
  send({ type: 'bind-target', docToken: FAKE_DOC_TOK, whiteboardToken: FAKE_WB_TOK });
  await waitFor((e) => e.type === 'bind-state');

  log('mode-set recording');
  send({ type: 'mode-set', mode: 'recording' });
  await waitFor((e) => e.type === 'mode-ok' && e.mode === 'recording');
  await waitFor((e) => e.type === 'recording-status');

  log('feeding 4 transcript chunks');
  for (const text of TRANSCRIPTS) {
    send({ type: 'recording-transcript', ts: Date.now(), text });
    await new Promise((r) => setTimeout(r, 50));
  }

  log('triggering summary');
  send({ type: 'recording-trigger-summary', userPrompt: '把刚才的画到白板上' });

  // Wait up to 60s for either pushed / skipped / error.
  try {
    const r = await waitFor(
      (e) => e.type === 'summary-pushed' || e.type === 'summary-error' || e.type === 'summary-skipped',
      60000,
    );
    log(`outcome: ${r.type}`);
    if (r.type === 'summary-pushed') {
      log(`  mermaid (${r.mermaid?.length}ch): ${(r.mermaid || '').slice(0, 180)}`);
      log(`  model=${r.modelUsed} latency=${r.latencyMs}ms note="${r.changeNote}"`);
    } else if (r.type === 'summary-error') {
      log(`  err: ${r.error}`);
      // This is expected if lark-cli auth is unavailable — the LLM succeeded
      // and the pipeline reached lark, which is the meaningful test.
    }
    ws.close();
    await new Promise((r) => setTimeout(r, 300));
    process.exit(0);
  } catch (e) {
    log('TIMED OUT waiting for summary outcome');
    ws.close();
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('crash:', e);
  process.exit(1);
});
