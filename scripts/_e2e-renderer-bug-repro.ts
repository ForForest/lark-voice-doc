/**
 * _e2e-renderer-bug-repro.ts — Reproduce the renderer-side PTT bugs.
 *
 * Mimics the BUGGY voice-client.ts behavior:
 *   - On PTT release, sends EOS + waits for ANY currentTranscript (not specifically 'final')
 *   - First partial that arrives is taken as the "result" → premature truncation
 *   - Then immediately calls closeSttSocket() which sends another EOS + closes WS
 *     → final-after-EOS may be lost
 *
 * This script DOES NOT depend on the renderer code. It mimics the exact
 * sequence so we can show the bug exists in the protocol/state machine.
 *
 * Expected (when bug present):
 *   - The "result" is a short partial like "你好" not the full final.
 *
 * Run:
 *   npx tsx scripts/_e2e-renderer-bug-repro.ts
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { synthesizeMinimax } from '../src/lib/minimax';
import { spawn } from 'node:child_process';

const SERVER = process.env.LARK_VOICE_SERVER || 'http://localhost:3001';
const STT_WS_URL = SERVER.replace(/^http/, 'ws') + '/api/stt';

const PHRASE = '你好,我叫张超,今天天气真好,我们一起来写一份文档吧。'; // longer phrase = more partials

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

/**
 * Mimic the BUGGY renderer pttFinalizeWithWait logic:
 *   1. Stream audio in real-time chunks
 *   2. After "release", send EOS
 *   3. Wait up to 4s for *any* currentTranscript (mimicking the buggy `if (currentTranscript) break`)
 *   4. Immediately close the WS (mimicking `closeSttSocket()` after teardown)
 *   5. Compare what we get vs the true final
 */
async function buggyRendererFlow(pcm: Buffer, holdMs: number): Promise<{ buggy: string; trueFinal: string; partials: string[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(STT_WS_URL);
    const partials: string[] = [];
    let currentTranscript = ''; // mimics renderer's var
    let trueFinal = '';
    let buggyResult: string | null = null;
    let resolved = false;
    let chunkInterval: NodeJS.Timeout | null = null;
    let waitInterval: NodeJS.Timeout | null = null;

    const fail = (err: Error) => { if (!resolved) { resolved = true; try { ws.close(); } catch {} reject(err); } };
    const done = () => {
      if (resolved) return; resolved = true;
      if (chunkInterval) clearInterval(chunkInterval);
      if (waitInterval) clearInterval(waitInterval);
      try { ws.close(); } catch {}
      resolve({ buggy: buggyResult || '', trueFinal, partials });
    };

    ws.on('open', () => log('[buggy] ws open'));
    ws.on('error', (err) => fail(new Error('ws error: ' + err.message)));

    ws.on('message', (data) => {
      let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'ready') {
        log('[buggy] ready, streaming...');
        // Stream chunks at 100ms pace for `holdMs` then send EOS
        const CHUNK = 3200;
        let off = 0;
        const startTime = Date.now();
        chunkInterval = setInterval(() => {
          const elapsed = Date.now() - startTime;
          if (off >= pcm.length || elapsed >= holdMs) {
            if (chunkInterval) { clearInterval(chunkInterval); chunkInterval = null; }
            log(`[buggy] released after ${elapsed}ms (sent ${off}/${pcm.length} bytes), sending EOS`);
            ws.send(JSON.stringify({ type: 'eos' }));
            // Now mimic the renderer: wait up to 4s for any currentTranscript
            const waitStart = Date.now();
            waitInterval = setInterval(() => {
              if (currentTranscript) {
                if (waitInterval) { clearInterval(waitInterval); waitInterval = null; }
                buggyResult = currentTranscript;
                log(`[buggy] got currentTranscript after ${Date.now() - waitStart}ms: "${buggyResult}"`);
                // Mimic renderer's closeSttSocket: send another EOS + close
                try { ws.send(JSON.stringify({ type: 'eos' })); } catch {}
                // BUT wait a moment for true final to arrive before resolving so we can compare
                setTimeout(done, 2000);
              } else if (Date.now() - waitStart > 4000) {
                if (waitInterval) { clearInterval(waitInterval); waitInterval = null; }
                log('[buggy] 4s wait expired, nothing to send');
                done();
              }
            }, 50);
            return;
          }
          const chunk = pcm.subarray(off, off + CHUNK);
          off += chunk.length;
          ws.send(chunk);
        }, 100);
      } else if (m.type === 'partial') {
        partials.push(m.text);
        currentTranscript = m.text;
      } else if (m.type === 'final') {
        trueFinal = m.text || '';
        if (!currentTranscript) currentTranscript = trueFinal;
        log(`[buggy] TRUE FINAL: "${trueFinal}"`);
      }
    });

    ws.on('close', () => done());
  });
}

async function main() {
  log('Synthesizing test phrase...');
  const pcm = await pcmFrom(PHRASE);
  const durSec = (pcm.length / 32000).toFixed(2);
  log(`Audio: ${pcm.length} bytes (${durSec}s)`);

  // Run with full hold (covers all audio)
  log(`\n── Buggy flow: hold for full ${Math.ceil(pcm.length / 32000 * 1000)}ms ──`);
  const r = await buggyRendererFlow(pcm, Math.ceil(pcm.length / 32000 * 1000) + 100);
  log('Result:');
  log(`  Buggy "result"   : "${r.buggy}"`);
  log(`  True final       : "${r.trueFinal}"`);
  log(`  Partial count    : ${r.partials.length}`);
  log(`  First few partials: ${r.partials.slice(0, 3).map(s => `"${s}"`).join(' / ')}`);
  if (r.buggy && r.trueFinal && r.buggy !== r.trueFinal) {
    log(`\n🐛 BUG REPRODUCED: buggy result is truncated (${r.buggy.length}/${r.trueFinal.length} chars)`);
    process.exit(0);
  }
  if (r.buggy === r.trueFinal) {
    log('\n✓ Buggy result matched true final this time (lucky timing)');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
