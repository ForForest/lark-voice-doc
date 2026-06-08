/**
 * _phase4-multi-doc-bind.ts — Verify the new multi-doc bind protocol.
 *
 * Walks through:
 *   1) Connect
 *   2) bind-target → expect bind-state with target only
 *   3) bind-reference-add (x2) → expect bind-state with target + 2 refs
 *   4) bind-reference-remove → expect bind-state with target + 1 ref
 *   5) bind-clear → expect bind-state empty
 *   6) mode-set recording (without target rebind) → still works; mode-ok
 *   7) recording-transcript → no error
 *   8) mode-set ptt → mode-ok
 *
 * Run while server is up:
 *   npx tsx scripts/_phase4-multi-doc-bind.ts
 */

import WebSocket from 'ws';

const WS_URL = (process.env.LARK_VOICE_SERVER || 'http://localhost:3001').replace(
  /^http/,
  'ws',
) + '/api/conversation';

const FAKE_DOC_TOK_TARGET = 'DocTokenTGT123456789';
const FAKE_DOC_TOK_REF1 = 'DocTokenREF111111111';
const FAKE_DOC_TOK_REF2 = 'DocTokenREF222222222';
const FAKE_WB_TOK = 'WbTokenABC987654321';

interface SrvEvt {
  type: string;
  [k: string]: any;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function log(s: string) { console.log(`[${ts()}] ${s}`); }

async function main() {
  log(`connecting to ${WS_URL}`);
  const ws = new WebSocket(WS_URL);
  const failures: string[] = [];
  const events: SrvEvt[] = [];

  await new Promise<void>((res, rej) => {
    ws.on('open', () => { log('ws open'); res(); });
    ws.on('error', (e) => rej(e));
  });

  ws.on('message', (data) => {
    let evt: SrvEvt;
    try { evt = JSON.parse(data.toString()); } catch { return; }
    events.push(evt);
    if (evt.type === 'bind-state' || evt.type === 'mode-ok' || evt.type === 'bind-doc-ok' || evt.type === 'ready' || evt.type === 'error') {
      log(`← ${evt.type} ${JSON.stringify(evt).slice(0, 240)}`);
    }
  });

  function send(obj: any) { ws.send(JSON.stringify(obj)); }
  function waitFor(typeFn: (e: SrvEvt) => boolean, ms = 3000): Promise<SrvEvt> {
    return new Promise((res, rej) => {
      const start = Date.now();
      const t = setInterval(() => {
        const found = events.find(typeFn);
        if (found) { clearInterval(t); res(found); }
        else if (Date.now() - start > ms) {
          clearInterval(t);
          rej(new Error('timed out waiting for event'));
        }
      }, 30);
    });
  }
  function lastBindState(): any {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'bind-state') return events[i];
    }
    return null;
  }

  // 0) ready
  await waitFor((e) => e.type === 'ready');

  // 1) bind-target
  events.length = 0;
  send({ type: 'bind-target', docToken: FAKE_DOC_TOK_TARGET, whiteboardToken: FAKE_WB_TOK, title: 'TestTarget' });
  await waitFor((e) => e.type === 'bind-state');
  {
    const bs = lastBindState();
    if (!bs?.target || bs.target.docToken !== FAKE_DOC_TOK_TARGET) {
      failures.push(`bind-target target mismatch: ${JSON.stringify(bs)}`);
    }
    if ((bs?.references || []).length !== 0) {
      failures.push('bind-target references should be empty');
    }
  }

  // 2) bind-reference-add #1
  events.length = 0;
  send({ type: 'bind-reference-add', docToken: FAKE_DOC_TOK_REF1, title: 'Ref1' });
  await waitFor((e) => e.type === 'bind-state');
  // #2
  events.length = 0;
  send({ type: 'bind-reference-add', docToken: FAKE_DOC_TOK_REF2, title: 'Ref2' });
  await waitFor((e) => e.type === 'bind-state');
  {
    const bs = lastBindState();
    if ((bs?.references || []).length !== 2) {
      failures.push(`expected 2 references, got ${bs?.references?.length}`);
    }
  }

  // 3) bind-reference-remove
  events.length = 0;
  send({ type: 'bind-reference-remove', docToken: FAKE_DOC_TOK_REF1 });
  await waitFor((e) => e.type === 'bind-state');
  {
    const bs = lastBindState();
    if ((bs?.references || []).length !== 1) {
      failures.push(`after remove, expected 1 ref, got ${bs?.references?.length}`);
    }
    if (bs?.references?.[0]?.docToken !== FAKE_DOC_TOK_REF2) {
      failures.push(`expected REF2 to remain, got ${bs?.references?.[0]?.docToken}`);
    }
  }

  // 4) bind-clear
  events.length = 0;
  send({ type: 'bind-clear' });
  await waitFor((e) => e.type === 'bind-state');
  {
    const bs = lastBindState();
    if (bs?.target) failures.push(`bind-clear should null target, got ${JSON.stringify(bs.target)}`);
    if ((bs?.references || []).length !== 0) failures.push('bind-clear should empty refs');
  }

  // 5) mode-set recording
  events.length = 0;
  send({ type: 'bind-target', docToken: FAKE_DOC_TOK_TARGET, whiteboardToken: FAKE_WB_TOK });
  await waitFor((e) => e.type === 'bind-state');
  send({ type: 'mode-set', mode: 'recording' });
  await waitFor((e) => e.type === 'mode-ok');
  await waitFor((e) => e.type === 'recording-status');

  // 6) recording-transcript (no error expected)
  send({ type: 'recording-transcript', ts: Date.now(), text: '测试一段转录文字' });
  await new Promise((r) => setTimeout(r, 200));

  // 7) mode-set ptt
  events.length = 0;
  send({ type: 'mode-set', mode: 'ptt' });
  await waitFor((e) => e.type === 'mode-ok');

  ws.close();
  await new Promise((r) => setTimeout(r, 300));

  if (failures.length === 0) {
    console.log('\nOK — multi-doc bind + mode protocol passed.');
    process.exit(0);
  } else {
    console.error('\nFAIL:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('test crash:', e);
  process.exit(1);
});
