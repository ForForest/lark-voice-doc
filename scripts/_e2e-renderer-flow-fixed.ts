/**
 * _e2e-renderer-flow-fixed.ts — Mimic the FIXED voice-client.ts protocol and
 * verify it produces non-truncated transcripts + works on consecutive presses.
 *
 * Mimics:
 *   - openSttSocket → wait `ready` → stream PCM real-time → send EOS
 *   - On release: wait specifically for `final` (NOT just any partial)
 *   - After final: close WS cleanly
 *   - Forward final.text to conv WS (reused across presses)
 *   - Assert: 3 presses on shared conv WS, each one returns turn-done with
 *     non-empty assistant text + non-truncated STT result
 *   - Run the ENTIRE test 3 times in a row (no flakes)
 *
 * Run:
 *   npx tsx scripts/_e2e-renderer-flow-fixed.ts
 *
 * Exit 0 if all 3 runs pass cleanly; 1 otherwise.
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { synthesizeMinimax } from '../src/lib/minimax';
import { spawn } from 'node:child_process';

const SERVER = process.env.LARK_VOICE_SERVER || 'http://localhost:3001';
const STT_WS_URL = SERVER.replace(/^http/, 'ws') + '/api/stt';
const CONV_WS_URL = SERVER.replace(/^http/, 'ws') + '/api/conversation';

// 3 distinct, longer phrases so partials are clearly truncated vs final.
const PHRASES = [
  '你好,我叫张超,今天天气真好,我们一起来写一份文档吧。',
  '帮我查一下这个项目里关于飞书的代码,简单回答。',
  '我想记一下,明天上午十点开会,主题是讨论新方案。',
];

function log(s: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);
}

async function pcmFrom(text: string): Promise<Buffer> {
  const { mp3 } = await synthesizeMinimax({ text });
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg fail')));
    proc.on('error', reject);
    proc.stdin.write(mp3); proc.stdin.end();
  });
}

interface FixedPressResult {
  press: number;
  prompt: string;
  sttFinal: string;
  sttPartialCount: number;
  sttTruncated: boolean;
  sttWaitMs: number;
  turnDone: boolean;
  assistantTokens: number;
  assistantText: string;
  error?: string;
}

/**
 * FIXED PTT-release flow:
 *   open WS → ready → stream → EOS → wait for `final` → consume final → close.
 */
async function fixedSttRound(pcm: Buffer, label: string): Promise<{ final: string; partials: string[]; waitMs: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(STT_WS_URL);
    const partials: string[] = [];
    let final = '';
    let gotFinal = false;
    let waitStart = 0;
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    let chunkTimer: NodeJS.Timeout | null = null;

    const fail = (err: Error) => {
      if (resolved) return; resolved = true;
      if (timer) clearTimeout(timer);
      if (chunkTimer) clearInterval(chunkTimer);
      try { ws.close(); } catch {}
      reject(err);
    };
    const done = () => {
      if (resolved) return; resolved = true;
      if (timer) clearTimeout(timer);
      if (chunkTimer) clearInterval(chunkTimer);
      try { ws.close(); } catch {}
      resolve({ final, partials, waitMs: gotFinal ? Date.now() - waitStart : 0 });
    };

    ws.on('open', () => log(`[${label}] ws open`));
    ws.on('error', (err) => fail(new Error(`ws error: ${err.message}`)));

    ws.on('message', (data) => {
      let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'ready') {
        log(`[${label}] ready, streaming ${pcm.length} bytes`);
        const CHUNK = 3200;
        let off = 0;
        chunkTimer = setInterval(() => {
          if (off >= pcm.length) {
            if (chunkTimer) { clearInterval(chunkTimer); chunkTimer = null; }
            // Send EOS (PTT release)
            log(`[${label}] release → EOS, waiting for FINAL`);
            ws.send(JSON.stringify({ type: 'eos' }));
            waitStart = Date.now();
            // 5s timeout for final (matches new pttFinalizeWithWait)
            timer = setTimeout(() => {
              log(`[${label}] FINAL timeout after 5s — falling back to last partial`);
              if (!final && partials.length) final = partials[partials.length - 1];
              done();
            }, 5000);
            return;
          }
          ws.send(pcm.subarray(off, off + CHUNK));
          off += CHUNK;
        }, 100);
      } else if (m.type === 'partial') {
        partials.push(m.text);
      } else if (m.type === 'final') {
        final = m.text || '';
        gotFinal = true;
        log(`[${label}] FINAL "${final}" (after ${Date.now() - waitStart}ms wait)`);
        done();
      }
    });

    ws.on('close', () => done());
  });
}

async function openConvWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CONV_WS_URL);
    const timer = setTimeout(() => reject(new Error('conv ws open timeout')), 5000);
    ws.once('message', (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve(ws);
        }
      } catch {}
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function runConvTurn(ws: WebSocket, text: string, label: string): Promise<{ assistantText: string; tokens: number; turnDone: boolean }> {
  return new Promise((resolve, reject) => {
    let tokens = 0;
    let assistantText = '';
    let turnDone = false;
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.off('message', onMessage);
        reject(new Error(`${label} turn-done timeout after 90s`));
      }
    }, 90000);
    function onMessage(data: any) {
      let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
      switch (m.type) {
        case 'assistant-text':
          tokens++;
          assistantText += String(m.token || '');
          break;
        case 'turn-done':
          turnDone = true;
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            ws.off('message', onMessage);
            resolve({ assistantText, tokens, turnDone });
          }
          break;
        case 'error':
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            ws.off('message', onMessage);
            reject(new Error(`${label} server error: ${m.error}`));
          }
          break;
      }
    }
    ws.on('message', onMessage);
    log(`[${label}] → user-final: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`);
    ws.send(JSON.stringify({ type: 'user-final', text }));
  });
}

async function runOneFullSession(runId: number, pcms: Buffer[]): Promise<FixedPressResult[]> {
  log(`\n══════════ RUN ${runId} ══════════`);
  const convWs = await openConvWs();
  log(`[run${runId}] conv WS ready`);
  const results: FixedPressResult[] = [];
  for (let i = 0; i < PHRASES.length; i++) {
    const press = i + 1;
    const prompt = PHRASES[i];
    const label = `run${runId}.press${press}`;
    log(`\n────── ${label} ──────`);
    const r: FixedPressResult = {
      press, prompt,
      sttFinal: '', sttPartialCount: 0, sttTruncated: false, sttWaitMs: 0,
      turnDone: false, assistantTokens: 0, assistantText: '',
    };
    try {
      const stt = await fixedSttRound(pcms[i], label + '.stt');
      r.sttFinal = stt.final;
      r.sttPartialCount = stt.partials.length;
      r.sttWaitMs = stt.waitMs;
      // Truncation: stt.final.length < 60% of prompt length
      r.sttTruncated = stt.final.length < prompt.length * 0.6;
      if (!stt.final) {
        r.error = 'STT returned empty final';
        results.push(r);
        continue;
      }
      if (r.sttTruncated) {
        r.error = `STT truncated: got "${stt.final}" (${stt.final.length}/${prompt.length})`;
      }
      const conv = await runConvTurn(convWs, stt.final, label + '.conv');
      r.assistantTokens = conv.tokens;
      r.assistantText = conv.assistantText;
      r.turnDone = conv.turnDone;
    } catch (err) {
      r.error = (err as Error).message;
    }
    results.push(r);
  }
  try { convWs.close(); } catch {}
  return results;
}

async function main() {
  log('═════════════ FIXED PROTOCOL E2E TEST ═════════════');

  // Sanity health
  try {
    const r = await fetch(`${SERVER}/api/health`);
    if (!r.ok) throw new Error('health not 200');
  } catch (err) {
    log(`SERVER NOT UP at ${SERVER}`);
    process.exit(1);
  }

  // Synth all phrases once
  log('synthesizing test phrases...');
  const pcms = await Promise.all(PHRASES.map(pcmFrom));
  for (let i = 0; i < pcms.length; i++) {
    log(`  ${i + 1}: ${pcms[i].length} bytes (${(pcms[i].length / 32000).toFixed(2)}s)`);
  }

  const allResults: FixedPressResult[][] = [];
  for (let runId = 1; runId <= 3; runId++) {
    const r = await runOneFullSession(runId, pcms);
    allResults.push(r);
  }

  // ─── Verdict ──────────────────────────────────────────────────────────
  log('\n═════════════ FINAL VERDICT ═════════════');
  let totalPasses = 0, totalFails = 0;
  for (let i = 0; i < allResults.length; i++) {
    const runId = i + 1;
    const run = allResults[i];
    let runPasses = 0, runFails = 0;
    for (const r of run) {
      const passed = !r.error && r.sttFinal && !r.sttTruncated && r.turnDone && r.assistantTokens > 0;
      if (passed) { runPasses++; totalPasses++; } else { runFails++; totalFails++; }
      log(`Run ${runId} Press ${r.press}: ${passed ? '✅ PASS' : '❌ FAIL'}`);
      log(`  STT: "${r.sttFinal}" (${r.sttFinal.length}c, ${r.sttPartialCount}partials, ${r.sttWaitMs}ms wait)`);
      log(`  Assist: ${r.assistantTokens}tok → "${r.assistantText.slice(0, 80)}${r.assistantText.length > 80 ? '…' : ''}"`);
      if (r.error) log(`  ERROR: ${r.error}`);
    }
    log(`  Run ${runId}: ${runPasses}/${run.length} pass`);
  }
  log(`\nGRAND TOTAL: ${totalPasses}/${totalPasses + totalFails} passed`);
  process.exit(totalFails === 0 ? 0 : 1);
}

main().catch((err) => { console.error('CRASH:', err); process.exit(2); });
