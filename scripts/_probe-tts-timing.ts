/**
 * _probe-tts-timing.ts — decompose 火山 TTS first-byte latency into stages:
 *   WS open → ConnectionStarted(50) → SessionStarted(150) → first audio frame.
 * Tells us whether the ~5-6s is connection setup, session setup, or the model's
 * own time-to-first-audio. Runs twice to show cold vs warm(ish).
 *   Run: npx tsx scripts/_probe-tts-timing.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const APP = process.env.VOLC_APP_ID!, ACC = process.env.VOLC_ACCESS_TOKEN!;
const RID = process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0';
const VOICE = process.env.VOLC_TTS_VOICE || 'zh_female_vv_uranus_bigtts';
const EP = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const EV = { StartConnection: 1, StartSession: 100, FinishSession: 102, TaskRequest: 200, ConnectionStarted: 50, SessionStarted: 150, SessionFinished: 152, TTSEnded: 359 };
const MSG = { FullClientRequest: 1, AudioOnlyServer: 0b1011 };
const FLAG = 0b0100;
const CONN = new Set([1, 2, 50, 51, 52]);

function frame(ev: number, sid: string | null, p: any): Buffer {
  const h = Buffer.from([0x11, (MSG.FullClientRequest << 4) | FLAG, (1 << 4) | 0, 0]);
  const e = Buffer.alloc(4); e.writeInt32BE(ev, 0);
  const parts = [h, e];
  if (!CONN.has(ev)) { const s = Buffer.from(sid || '', 'utf8'); const l = Buffer.alloc(4); l.writeUInt32BE(s.length, 0); parts.push(l, s); }
  const pl = Buffer.from(JSON.stringify(p ?? {}), 'utf8'); const pll = Buffer.alloc(4); pll.writeUInt32BE(pl.length, 0); parts.push(pll, pl);
  return Buffer.concat(parts);
}
function decode(d: Buffer) {
  const msgType = (d[1] >> 4) & 0xf, flags = d[1] & 0xf; let off = 4; let ev: number | null = null;
  if (flags & FLAG) { ev = d.readInt32BE(off); off += 4; }
  if (ev !== null && off + 4 <= d.length) { const il = d.readUInt32BE(off); if (il < 1024 && off + 4 + il <= d.length) off += 4 + il; }
  let payloadLen = 0; if (off + 4 <= d.length) payloadLen = d.readUInt32BE(off);
  return { msgType, ev, payloadLen };
}

function run(label: string): Promise<void> {
  return new Promise((resolve) => {
    const reqId = randomUUID(), sid = randomUUID();
    const rp = { speaker: VOICE, audio_params: { format: 'pcm', sample_rate: 24000, speech_rate: 0 } };
    const t0 = Date.now(); const mark: Record<string, number> = {};
    const ws = new WebSocket(EP, { headers: { 'X-Api-App-Id': APP, 'X-Api-App-Key': APP, 'X-Api-Access-Key': ACC, 'X-Api-Resource-Id': RID, 'X-Api-Request-Id': reqId, 'X-Api-Connect-Id': randomUUID() } });
    ws.on('open', () => { mark.open = Date.now() - t0; ws.send(frame(EV.StartConnection, null, {})); });
    ws.on('message', (d: Buffer) => {
      const x = decode(d);
      if (x.msgType === MSG.AudioOnlyServer && x.payloadLen > 0) {
        if (!mark.firstAudio) {
          mark.firstAudio = Date.now() - t0;
          console.log(`${label}:`);
          console.log(`   WS open            ${mark.open}ms`);
          console.log(`   → ConnectionStarted ${mark.conn}ms  (+${mark.conn - mark.open}ms handshake)`);
          console.log(`   → SessionStarted    ${mark.sess}ms  (+${mark.sess - mark.conn}ms session setup)`);
          console.log(`   → FIRST AUDIO       ${mark.firstAudio}ms  (+${mark.firstAudio - mark.sess}ms model TTFB)\n`);
          try { ws.close(); } catch {}
          resolve();
        }
        return;
      }
      if (x.ev === EV.ConnectionStarted) { mark.conn = Date.now() - t0; ws.send(frame(EV.StartSession, sid, { user: { uid: reqId }, namespace: 'BidirectionalTTS', req_params: rp })); }
      else if (x.ev === EV.SessionStarted) { mark.sess = Date.now() - t0; ws.send(frame(EV.TaskRequest, sid, { user: { uid: reqId }, namespace: 'BidirectionalTTS', req_params: { ...rp, text: '你好，我们开始头脑风暴吧。' } })); ws.send(frame(EV.FinishSession, sid, {})); }
    });
    ws.on('error', (e) => { console.log(`${label}: ERR ${(e as Error).message}`); resolve(); });
    setTimeout(() => { if (!mark.firstAudio) { console.log(`${label}: no audio in 15s (marks: ${JSON.stringify(mark)})`); try { ws.close(); } catch {} resolve(); } }, 15000);
  });
}

(async () => {
  console.log(`=== 火山 TTS first-byte breakdown (resource=${RID}, voice=${VOICE}) ===\n`);
  await run('run 1 (cold)');
  await run('run 2 (warm-ish, same process)');
})();
