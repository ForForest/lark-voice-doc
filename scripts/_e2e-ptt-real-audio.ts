/**
 * _e2e-ptt-real-audio.ts — End-to-end PTT integration test using REAL audio.
 *
 * What this does:
 *   1. Synthesize a Chinese test phrase via MiniMax TTS → mp3
 *   2. Convert mp3 → 16k mono Int16LE PCM via ffmpeg
 *   3. Open WS /api/stt, stream PCM in 100ms chunks (mimics renderer mic loop)
 *   4. Send {type:'eos'}, wait for {type:'final', text}
 *   5. Assert final.text matches expected (not truncated like the "建一" bug)
 *   6. Open WS /api/conversation, send {type:'user-final', text: final.text}
 *   7. Assert sequence: ready → turn-start → assistant-text* → turn-done
 *   8. Repeat 3x on a SINGLE conv WS (covers stale-state bug for press 2+3)
 *
 * Run with server already up:
 *   npm run server     # in another terminal (or already running via Electron)
 *   npx tsx scripts/_e2e-ptt-real-audio.ts
 *
 * Exit 0 on success, 1 on any failure. Prints PASS/FAIL summary at end.
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { synthesizeVolc } from '../src/lib/volc-tts';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SERVER = process.env.LARK_VOICE_SERVER || 'http://localhost:3001';
const STT_WS_URL = SERVER.replace(/^http/, 'ws') + '/api/stt';
const CONV_WS_URL = SERVER.replace(/^http/, 'ws') + '/api/conversation';

// Three phrases we'll test — picked to be unambiguous and short.
// Each phrase tests one PTT press on a shared conversation WS.
const TEST_PHRASES = [
  '你好,我叫张超,今天天气真好。',           // longish; tests no truncation
  '简单回答,一加一等于几?不要调用工具。',  // tests no tool call
  '帮我记一下:开会十点。',                  // tests another full sentence
];

interface PressResult {
  press: number;
  prompt: string;
  sttFinal: string;
  sttSawTruncated: boolean;
  turnStart: boolean;
  assistantTokens: number;
  assistantText: string;
  turnDone: boolean;
  durationMs: number;
  error?: string;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(line: string): void {
  console.log(`[${ts()}] ${line}`);
}

/* ─── 1. TTS → PCM ────────────────────────────────────────────────────── */
async function synthChinesePcm16k(text: string): Promise<Buffer> {
  log(`[tts] synthesizing: ${text}`);
  const { audio: mp3 } = await synthesizeVolc({ text, format: 'mp3' });
  log(`[tts]  mp3 ${mp3.length} bytes`);

  // ffmpeg: stdin mp3 → stdout pcm s16le 16k mono
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => errBuf.push(c));
    proc.on('close', (code) => {
      if (code !== 0) {
        const errMsg = Buffer.concat(errBuf).toString('utf8');
        reject(new Error(`ffmpeg exit ${code}: ${errMsg.slice(0, 300)}`));
        return;
      }
      const pcm = Buffer.concat(out);
      log(`[ffmpeg] mp3 → pcm: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(2)}s @ 16k mono)`);
      resolve(pcm);
    });
    proc.on('error', reject);
    proc.stdin.write(mp3);
    proc.stdin.end();
  });
}

/* ─── 2. STT path: stream PCM, wait for final ────────────────────────── */
interface SttResult {
  final: string;
  partials: string[];
  durationMs: number;
  closed: boolean;
}

async function streamPcmToStt(pcm: Buffer, label: string): Promise<SttResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket(STT_WS_URL);
    const partials: string[] = [];
    let final = '';
    let ready = false;
    let resolved = false;
    let timedOut = false;
    let closedSeen = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch {}
        reject(new Error(`[stt:${label}] timeout 20s waiting for final (partials=${partials.length}, last="${partials[partials.length-1] || ''}")`));
      }
    }, 20000);

    ws.on('open', () => {
      log(`[stt:${label}] ws open, waiting for ready...`);
    });

    ws.on('message', async (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'ready') {
        ready = true;
        log(`[stt:${label}] upstream ready, streaming ${pcm.length} bytes...`);
        // Stream in 100ms chunks (16k * 0.1 = 1600 samples = 3200 bytes)
        const CHUNK = 3200;
        let off = 0;
        const sendNext = () => {
          if (off >= pcm.length) {
            log(`[stt:${label}] sent all chunks, sending EOS`);
            ws.send(JSON.stringify({ type: 'eos' }));
            return;
          }
          const chunk = pcm.subarray(off, off + CHUNK);
          off += chunk.length;
          ws.send(chunk);
          setTimeout(sendNext, 100); // real-time pace
        };
        sendNext();
      } else if (msg.type === 'partial') {
        partials.push(msg.text);
      } else if (msg.type === 'final') {
        final = msg.text || '';
        log(`[stt:${label}] FINAL: "${final}"`);
        // Don't resolve yet — wait for close so we know upstream cleanly tore down.
        // But also resolve quickly if no close in 1s.
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve({ final, partials, durationMs: Date.now() - t0, closed: closedSeen });
          }
        }, 500);
      } else if (msg.type === 'closed') {
        closedSeen = true;
      } else if (msg.type === 'error') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(new Error(`[stt:${label}] server error: ${msg.message}`));
        }
      }
    });

    ws.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`[stt:${label}] ws error: ${err.message}`));
      }
    });

    ws.on('close', () => {
      closedSeen = true;
      // If we already have a final but didn't resolve, do it now.
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (final) {
          resolve({ final, partials, durationMs: Date.now() - t0, closed: true });
        } else {
          reject(new Error(`[stt:${label}] ws closed without final (partials=${partials.length})`));
        }
      }
    });
  });
}

/* ─── 3. Conv WS: send user-final on existing ws, wait turn-done ────── */
interface ConvTurnResult {
  turnStart: boolean;
  assistantTokens: number;
  assistantText: string;
  toolsUsed: string[];
  turnDone: boolean;
  aborted: boolean;
  durationMs: number;
}

async function runConvTurn(ws: WebSocket, text: string, press: number): Promise<ConvTurnResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let turnStart = false;
    let assistantTokens = 0;
    let assistantText = '';
    let toolsUsed: string[] = [];
    let turnDone = false;
    let aborted = false;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`[conv press ${press}] turn-done timeout 45s. turnStart=${turnStart} tokens=${assistantTokens} text="${assistantText.slice(0, 100)}"`));
      }
    }, 45000);

    function onMessage(data: any) {
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      switch (m.type) {
        case 'turn-start':
          turnStart = true;
          log(`[conv press ${press}] ← turn-start turn=${m.turn}`);
          break;
        case 'assistant-text':
          assistantTokens++;
          assistantText += String(m.token || '');
          if (assistantTokens === 1) log(`[conv press ${press}] ← first token`);
          break;
        case 'tool-call':
          toolsUsed.push(m.name);
          log(`[conv press ${press}] ← tool-call ${m.name}`);
          break;
        case 'tool-result':
          log(`[conv press ${press}] ← tool-result ${m.name} ok=${m.ok}`);
          break;
        case 'turn-done':
          turnDone = true;
          aborted = !!m.aborted;
          log(`[conv press ${press}] ← turn-done aborted=${aborted} chars=${assistantText.length}`);
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({ turnStart, assistantTokens, assistantText, toolsUsed, turnDone, aborted, durationMs: Date.now() - t0 });
          }
          break;
        case 'error':
          log(`[conv press ${press}] ← error: ${m.error}`);
          if (!resolved) {
            resolved = true;
            cleanup();
            reject(new Error(`[conv press ${press}] server error: ${m.error}`));
          }
          break;
      }
    }
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }

    ws.on('message', onMessage);
    log(`[conv press ${press}] → user-final: ${text}`);
    ws.send(JSON.stringify({ type: 'user-final', text }));
  });
}

async function openConvWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CONV_WS_URL);
    const timer = setTimeout(() => reject(new Error('[conv] open timeout 5s')), 5000);
    ws.once('message', (data) => {
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'ready') {
        clearTimeout(timer);
        resolve(ws);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ─── 4. Full run ─────────────────────────────────────────────────────── */
async function main(): Promise<void> {
  log('═════════════════ E2E PTT real-audio test ═════════════════');

  // Sanity: health
  try {
    const r = await fetch(`${SERVER}/api/health`);
    if (!r.ok) throw new Error('health not ok');
    log(`server health: ${r.status}`);
  } catch (err) {
    log(`SERVER NOT UP at ${SERVER} — please run npm run server first`);
    process.exit(1);
  }

  // Synth all 3 phrases first (parallel) to save time
  log('synthesizing 3 test phrases...');
  const pcms = await Promise.all(TEST_PHRASES.map((p) => synthChinesePcm16k(p)));

  // Open ONE conv WS, run all 3 turns on it (simulates pill staying open)
  log('opening conversation WS...');
  const convWs = await openConvWs();
  log('conv WS ready');

  const results: PressResult[] = [];

  for (let i = 0; i < TEST_PHRASES.length; i++) {
    const press = i + 1;
    const prompt = TEST_PHRASES[i];
    log(`\n────── Press ${press} ──────`);

    const r: PressResult = {
      press,
      prompt,
      sttFinal: '',
      sttSawTruncated: false,
      turnStart: false,
      assistantTokens: 0,
      assistantText: '',
      turnDone: false,
      durationMs: 0,
    };
    const tStart = Date.now();

    try {
      // STT round
      const stt = await streamPcmToStt(pcms[i], `press${press}`);
      r.sttFinal = stt.final;
      r.sttSawTruncated = stt.final.length < prompt.length * 0.4; // <40% chars = truncated

      if (!stt.final) {
        r.error = 'STT returned empty final';
        results.push(r);
        continue;
      }
      if (r.sttSawTruncated) {
        log(`⚠ STT truncated! got "${stt.final}" (${stt.final.length} chars) vs expected ~${prompt.length}`);
      }

      // Conv round (use the STT result, like the pill does)
      const conv = await runConvTurn(convWs, stt.final, press);
      r.turnStart = conv.turnStart;
      r.assistantTokens = conv.assistantTokens;
      r.assistantText = conv.assistantText;
      r.turnDone = conv.turnDone;
    } catch (err) {
      r.error = (err as Error).message;
    }
    r.durationMs = Date.now() - tStart;
    results.push(r);
  }

  try { convWs.close(); } catch {}

  // ─── Verdict ──────────────────────────────────────────────────────────
  log('\n═════════════════ VERDICT ═════════════════');
  let passCount = 0;
  let failCount = 0;
  for (const r of results) {
    const passed = !r.error && r.sttFinal && !r.sttSawTruncated && r.turnStart && r.turnDone && r.assistantTokens > 0;
    if (passed) passCount++; else failCount++;
    log(`Press ${r.press}: ${passed ? 'PASS' : 'FAIL'} (${r.durationMs}ms)`);
    log(`  prompt:      ${r.prompt}`);
    log(`  sttFinal:    "${r.sttFinal}"`);
    log(`  truncated:   ${r.sttSawTruncated}`);
    log(`  turnStart:   ${r.turnStart}`);
    log(`  tokens:      ${r.assistantTokens}`);
    log(`  turnDone:    ${r.turnDone}`);
    log(`  reply:       ${r.assistantText.slice(0, 100)}${r.assistantText.length > 100 ? '…' : ''}`);
    if (r.error) log(`  ERROR:       ${r.error}`);
  }
  log(`\n${passCount}/${results.length} passed, ${failCount} failed`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('CRASH:', err);
  process.exit(2);
});
