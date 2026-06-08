/**
 * volc-stt.ts
 *
 * Extracted from ai-teacher-prototype/src/server.ts:4001-4225 (handleTtsDemoStt).
 * Standalone WS handler that proxies a browser client mic → 火山 Bigmodel ASR
 * (Seed-ASR streaming, wss://openspeech.bytedance.com/api/v3/sauc/bigmodel).
 *
 * Protocol on the client side:
 *   - Client opens WS to ws(s)://<server>/api/stt
 *   - Server sends {type:'ready'} once 火山 upstream is open
 *   - Client streams 16k mono PCM Int16LE 100ms chunks as binary frames
 *   - Client sends {type:'eos'} JSON to signal end-of-audio
 *   - Server emits {type:'partial'|'final', text} as JSON, and finally
 *     {type:'closed', code} when upstream closes.
 *
 * Critical bug fix preserved: 火山 bigmodel server response frames embed a
 * 4-byte sequence number AFTER the 4-byte header when flags & 0x1/0x2 is set
 * (sequence present). Without skipping those 4 bytes, JSON parse fails on
 * every message. See offset/seq logic in `upstream.on('message')`.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import process from 'node:process';

export async function handleVolcStt(clientWs: WebSocket): Promise<void> {
  const appKey = process.env.VOLC_APP_ID;
  const accessKey = process.env.VOLC_ACCESS_TOKEN;
  if (!appKey || !accessKey) {
    clientWs.send(
      JSON.stringify({
        type: 'error',
        message: 'VOLC_APP_ID / VOLC_ACCESS_TOKEN missing in .env',
      }),
    );
    clientWs.close();
    return;
  }

  const requestId = randomUUID();
  const upstreamUrl = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  let initSent = false;
  const pendingAudio: Buffer[] = [];

  try {
    upstream = new WebSocket(upstreamUrl, {
      headers: {
        'X-Api-App-Key': appKey,
        'X-Api-Access-Key': accessKey,
        'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
      },
    });
  } catch (err) {
    clientWs.send(
      JSON.stringify({
        type: 'error',
        message: `volc connect failed: ${(err as Error).message}`,
      }),
    );
    clientWs.close();
    return;
  }

  // ── 火山 bigmodel framing ──────────────────────────────────────────────
  // Header (4 bytes):
  //   byte0: (protoVer<<4) | headerSizeInDwords  → 0x11
  //   byte1: (msgType<<4)  | flags               → flags: 0x2 = last packet
  //   byte2: (serMethod<<4)| compression          → 0x10 = json, none
  //   byte3: reserved
  // Then payload-length (uint32 BE) + payload.
  function buildFrame(msgType: number, payload: Buffer, isLast: boolean): Buffer {
    const header = Buffer.alloc(4);
    header[0] = (0x1 << 4) | 0x1; // proto v1, header size 1 dword
    const flags = isLast ? 0x2 : 0x0;
    header[1] = (msgType << 4) | flags;
    header[2] = (0x1 << 4) | 0x0; // ser=json, compress=none
    header[3] = 0;
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, lenBuf, payload]);
  }

  function sendInit(sampleRate: number) {
    if (!upstream || initSent) return;
    initSent = true;
    const initPayload = {
      user: { uid: 'lark-voice-doc-user' },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: sampleRate,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        result_type: 'single',
      },
    };
    const frame = buildFrame(0x1, Buffer.from(JSON.stringify(initPayload)), false);
    upstream.send(frame, { binary: true });
  }

  let audioChunkCount = 0;
  let upstreamMsgCount = 0;
  let eosPending = false;

  upstream.on('open', () => {
    upstreamReady = true;
    console.log('[volc-stt] ✓ upstream OPEN, reqId=' + requestId);
    sendInit(16000);
    for (const chunk of pendingAudio) {
      const frame = buildFrame(0x2, chunk, false);
      upstream!.send(frame, { binary: true });
    }
    if (pendingAudio.length) {
      console.log(`[volc-stt] flushed ${pendingAudio.length} pending audio chunks`);
    }
    pendingAudio.length = 0;
    if (eosPending) {
      const frame = buildFrame(0x2, Buffer.alloc(0), true);
      upstream!.send(frame, { binary: true });
      eosPending = false;
    }
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'ready' }));
    }
  });

  upstream.on('message', (data: Buffer) => {
    upstreamMsgCount++;
    if (!Buffer.isBuffer(data) || data.length < 4) return;
    try {
      // Frame layout for server response:
      //   bytes 0-3: header (msgType in nibble of byte 1)
      //   if flags & (0x1 | 0x2):
      //     bytes 4-7: sequence (int32 BE, negative = last frame)
      //     bytes 8-11: payload size (uint32 BE)
      //     bytes 12+: payload (JSON)
      //   else:
      //     bytes 4-7: payload size, bytes 8+: payload
      const msgType = (data[1] >> 4) & 0x0f;
      const flags = data[1] & 0x0f;
      const hasSeq = (flags & 0x1) !== 0 || (flags & 0x2) !== 0;
      let offset = 4;
      let seq: number | null = null;
      if (hasSeq) {
        seq = data.readInt32BE(4);
        offset = 8;
      }
      const len = data.readUInt32BE(offset);
      offset += 4;
      const body = data.slice(offset, offset + len).toString('utf-8');
      const isLastFlag = (flags & 0x2) !== 0 || (seq !== null && seq < 0);
      if (upstreamMsgCount === 1 || isLastFlag) {
        console.log(
          `[volc-stt] ← msg #${upstreamMsgCount} type=${msgType} flags=${flags} seq=${seq} len=${len}`,
        );
        console.log(`[volc-stt]   body=${body.slice(0, 400)}`);
      }
      const json = JSON.parse(body);
      const errCode = json?.code || json?.payload_msg?.code;
      const errMsg = json?.message || json?.payload_msg?.message;
      if (errCode && errCode !== 0 && errCode !== 1000) {
        console.warn(`[volc-stt] upstream error code=${errCode} msg=${errMsg}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({ type: 'error', message: `volc code=${errCode}: ${errMsg}` }),
          );
        }
        return;
      }
      const result = json?.result || json?.payload_msg?.result;
      const text = result?.text || '';
      const utterances = result?.utterances;
      const definiteFinal =
        Array.isArray(utterances) &&
        utterances.length > 0 &&
        utterances.some((u: any) => u?.definite === true);
      const isFinal = !!result?.is_final || definiteFinal || isLastFlag;
      if (text && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: isFinal ? 'final' : 'partial', text }));
      } else if (isLastFlag && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'final', text: '' }));
      }
    } catch (err) {
      console.warn(`[volc-stt] parse fail: ${(err as Error).message} (msg #${upstreamMsgCount})`);
    }
  });

  upstream.on('error', (err) => {
    console.warn('[volc-stt] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', message: `volc upstream: ${err.message}` }));
    }
  });

  upstream.on('close', (code) => {
    console.log(
      `[volc-stt] upstream closed code=${code} (sent ${audioChunkCount} audio chunks, got ${upstreamMsgCount} msgs)`,
    );
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'closed', code }));
      clientWs.close();
    }
  });

  clientWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString('utf-8'));
        if (msg.type === 'eos') {
          console.log(
            `[volc-stt] client EOS (after ${audioChunkCount} chunks, ready=${upstreamReady})`,
          );
          if (upstream && upstreamReady) {
            const frame = buildFrame(0x2, Buffer.alloc(0), true);
            upstream.send(frame, { binary: true });
          } else {
            eosPending = true;
          }
        }
      } catch {
        /* non-JSON text frame ignored */
      }
      return;
    }
    audioChunkCount++;
    if (audioChunkCount === 1) {
      console.log(
        `[volc-stt] first audio chunk from client (${(data as Buffer).length}B), upstreamReady=${upstreamReady}`,
      );
    }
    if (upstream && upstreamReady) {
      const frame = buildFrame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data), false);
      upstream.send(frame, { binary: true });
    } else {
      pendingAudio.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
  });

  clientWs.on('close', () => {
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}
