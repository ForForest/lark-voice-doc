/**
 * _pill-ws-smoke.ts — Smoke test for the pill's conversation WS contract.
 *
 * Opens ws://localhost:3001/api/conversation, sends a small user-final, and
 * asserts the expected event sequence arrives:
 *   ready → turn-start → (zero or more tool-call/tool-result/assistant-text)
 *   → turn-done
 *
 * Run with the server already up:
 *   npm run server
 *   # in another shell:
 *   npx tsx scripts/_pill-ws-smoke.ts
 *
 * Exits 0 on success, 1 on any contract violation or timeout.
 */

import WebSocket from 'ws';

const SERVER = process.env.LARK_VOICE_SERVER || 'http://localhost:3001';
const WS_URL = SERVER.replace(/^http/, 'ws') + '/api/conversation';
const TURN_TIMEOUT_MS = 60_000; // tool-loop turns can take a while
const PROMPT =
  process.env.SMOKE_PROMPT ||
  '简单回答: 用一句话告诉我今天是星期几, 不要调用任何工具';

interface ServerEvent {
  type: string;
  [k: string]: any;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(line: string): void {
  console.log(`[${ts()}] ${line}`);
}

async function main(): Promise<void> {
  log(`connecting to ${WS_URL}`);
  const ws = new WebSocket(WS_URL);

  const events: ServerEvent[] = [];
  let readyReceived = false;
  let turnStartReceived = false;
  let turnDoneReceived = false;
  let tokenCount = 0;
  let assistantText = '';
  let toolsSeen: string[] = [];

  const failures: string[] = [];

  const timer = setTimeout(() => {
    failures.push(`turn-done not received within ${TURN_TIMEOUT_MS}ms`);
    cleanup();
  }, TURN_TIMEOUT_MS);

  function cleanup(): void {
    clearTimeout(timer);
    try { ws.close(); } catch {}
    setTimeout(() => report(), 200);
  }

  function report(): void {
    log('───── result ─────');
    log(`events received: ${events.length}`);
    log(`ready=${readyReceived} turn-start=${turnStartReceived} turn-done=${turnDoneReceived}`);
    log(`tokens=${tokenCount} chars=${assistantText.length} tools=[${toolsSeen.join(',')}]`);
    if (assistantText) log(`reply: ${assistantText.slice(0, 200)}${assistantText.length > 200 ? '…' : ''}`);

    if (!readyReceived) failures.push('no `ready` event');
    if (!turnStartReceived) failures.push('no `turn-start` event');
    if (!turnDoneReceived) failures.push('no `turn-done` event');
    if (turnDoneReceived && tokenCount === 0 && assistantText.length === 0) {
      failures.push('turn-done but zero assistant tokens (likely tool-only abort)');
    }

    if (failures.length === 0) {
      log('OK — contract satisfied');
      process.exit(0);
    } else {
      log('FAIL — contract violations:');
      for (const f of failures) log(`  - ${f}`);
      process.exit(1);
    }
  }

  ws.on('open', () => {
    log('ws open');
  });

  ws.on('message', (data) => {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(data.toString());
    } catch {
      failures.push('non-JSON message: ' + data.toString().slice(0, 60));
      return;
    }
    events.push(evt);
    switch (evt.type) {
      case 'ready':
        readyReceived = true;
        log('← ready');
        // Send the test turn.
        log(`→ user-final: ${PROMPT}`);
        ws.send(JSON.stringify({ type: 'user-final', text: PROMPT }));
        break;
      case 'turn-start':
        turnStartReceived = true;
        log(`← turn-start (turn=${evt.turn})`);
        break;
      case 'assistant-text':
        tokenCount++;
        assistantText += String(evt.token || '');
        if (tokenCount === 1) log('← assistant-text (first token)');
        break;
      case 'tool-call':
        toolsSeen.push(String(evt.name));
        log(`← tool-call name=${evt.name} args=${JSON.stringify(evt.args).slice(0, 100)}`);
        break;
      case 'tool-result':
        log(`← tool-result name=${evt.name} ok=${evt.ok} summary=${String(evt.summary || '').slice(0, 80)}`);
        break;
      case 'turn-done':
        turnDoneReceived = true;
        log(`← turn-done aborted=${evt.aborted} tools=[${(evt.toolsUsed || []).join(',')}]`);
        cleanup();
        break;
      case 'error':
        failures.push('server error: ' + evt.error);
        log(`← error: ${evt.error}`);
        cleanup();
        break;
      case 'pong':
        log('← pong');
        break;
      default:
        log(`← unknown type: ${evt.type}`);
    }
  });

  ws.on('error', (err) => {
    failures.push('ws error: ' + (err as Error).message);
    log(`ws error: ${(err as Error).message}`);
    cleanup();
  });

  ws.on('close', (code, reason) => {
    log(`ws close code=${code} reason=${reason.toString()}`);
  });
}

main().catch((err) => {
  console.error('smoke crash:', err);
  process.exit(1);
});
