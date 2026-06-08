/**
 * tts-demo / minimax.ts
 *
 * Real-time MiniMax TTS synth (no pre-cache).
 * speech-2.8-turbo, voice English_Upbeat_Woman, speed 0.8, mp3.
 */

import process from 'node:process';

const MINIMAX_ENDPOINT =
  process.env.MINIMAX_ENDPOINT?.replace(/\/$/, '') || 'https://api.minimaxi.com';

// 2026-05-23 founder feedback: English_Upbeat_Woman 念中文很差.
// Switch to Chinese (Mandarin) voice + language_boost. The voice still pronounces
// embedded English as English (per MiniMax docs on code-switching).
const DEFAULT_VOICE = 'Chinese (Mandarin)_Warm_Bestie';
// 2026-05-24 founder: 换回 turbo, e2e 从 5s 降到 ~3s. 等 streaming TTS 接好后流式+turbo
// 组合可以再降到 ~1.8s. 情绪略扁但 lesson-realtime 实测可接受.
const DEFAULT_MODEL = 'speech-2.8-turbo';
const DEFAULT_SPEED = 1.0;
const DEFAULT_LANG_BOOST = 'Chinese';

export async function synthesizeMinimax(opts: {
  text: string;
  voice?: string;
  speed?: number;
  model?: string;
  emotion?: string; // happy | sad | angry | calm | fearful | disgusted | surprised | neutral
  languageBoost?: string; // Chinese | English | auto | etc.
}): Promise<{ mp3: Buffer; durationMs: number; latencyMs: number }> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY not set in env');

  const voiceSetting: Record<string, any> = {
    voice_id: opts.voice || DEFAULT_VOICE,
    speed: opts.speed ?? DEFAULT_SPEED,
    vol: 1,
    pitch: 0,
  };
  // emotion='auto' = MiniMax 默认 (从文本推断), 不能显式传 — 留空。
  if (opts.emotion && opts.emotion !== 'auto') voiceSetting.emotion = opts.emotion;

  const body: Record<string, any> = {
    model: opts.model || DEFAULT_MODEL,
    text: opts.text,
    stream: false,
    language_boost: opts.languageBoost ?? DEFAULT_LANG_BOOST,
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  };

  const t0 = Date.now();
  const res = await fetch(`${MINIMAX_ENDPOINT}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MiniMax HTTP ${res.status}: ${txt.slice(0, 240)}`);
  }
  const json: any = await res.json();
  const hex: string | undefined = json?.data?.audio || json?.audio;
  if (!hex || typeof hex !== 'string') {
    throw new Error(`MiniMax response missing audio hex: ${JSON.stringify(json).slice(0, 240)}`);
  }
  const mp3 = Buffer.from(hex, 'hex');
  const durationMs =
    json?.extra_info?.audio_length ||
    json?.extra_info?.duration ||
    json?.data?.duration ||
    Math.round((mp3.length * 8) / 128);

  return { mp3, durationMs, latencyMs };
}

/**
 * Streaming MiniMax TTS (SSE).
 *
 * Hits the same /v1/t2a_v2 endpoint with stream:true. Server pushes
 *   data: {"data":{"audio":"<hex>"},...}\n\n
 * events as mp3 bytes are encoded, with a final event carrying extra_info.
 *
 * Returns an async iterable yielding raw mp3 Buffer chunks as they arrive.
 * First chunk arrives ~200-500ms after request start (vs ~1.5s for REST).
 *
 * Caller is responsible for stitching chunks (mp3 is concatenable) and
 * decoding incrementally.
 */
export interface MinimaxStreamMeta {
  audio_length?: number;
  duration?: number;
  [k: string]: any;
}

export async function* synthesizeMinimaxStream(opts: {
  text: string;
  voice?: string;
  speed?: number;
  model?: string;
  emotion?: string;
  languageBoost?: string;
  /**
   * 'pcm' (default) → raw little-endian Int16 PCM @ 32kHz mono. Each chunk
   *   is independently playable; browser can pipe straight into AudioBuffer.
   *   First chunk arrives ~300-800ms after request. Best for true streaming.
   * 'mp3' → mp3 frames @ 128kbps. Chunks can NOT be decoded independently
   *   (decodeAudioData fails on mid-frame cuts) so consumer must concat
   *   then decode at end. Kept for backwards compat.
   */
  format?: 'pcm' | 'mp3';
  onMeta?: (meta: MinimaxStreamMeta) => void;
  onFirstChunk?: (ms: number) => void;
}): AsyncGenerator<Buffer, void, void> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error('MINIMAX_API_KEY not set in env');

  const voiceSetting: Record<string, any> = {
    voice_id: opts.voice || DEFAULT_VOICE,
    speed: opts.speed ?? DEFAULT_SPEED,
    vol: 1,
    pitch: 0,
  };
  if (opts.emotion && opts.emotion !== 'auto') voiceSetting.emotion = opts.emotion;

  const audioFormat = opts.format === 'mp3' ? 'mp3' : 'pcm';
  const audioSetting: Record<string, any> = {
    sample_rate: 32000,
    format: audioFormat,
    channel: 1,
  };
  // bitrate only meaningful for mp3; MiniMax accepts it on pcm too but it
  // has no effect. Keep mp3 behaviour identical to pre-PCM version.
  if (audioFormat === 'mp3') audioSetting.bitrate = 128000;

  const body: Record<string, any> = {
    model: opts.model || DEFAULT_MODEL,
    text: opts.text,
    stream: true,
    language_boost: opts.languageBoost ?? DEFAULT_LANG_BOOST,
    voice_setting: voiceSetting,
    audio_setting: audioSetting,
  };

  const t0 = Date.now();
  const res = await fetch(`${MINIMAX_ENDPOINT}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error(`MiniMax stream HTTP ${res.status}: ${txt.slice(0, 240)}`);
  }

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let firstChunkEmitted = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE events separated by blank lines (\n\n or \r\n\r\n).
      let sepIdx: number;
      while ((sepIdx = indexOfDoubleNewline(buf)) !== -1) {
        const rawEvent = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + (buf[sepIdx] === '\r' ? 4 : 2));
        const parsed = parseSseEvent(rawEvent);
        if (!parsed) continue;
        // {data:{audio:'<hex>'}, extra_info?} OR top-level audio
        const hex: string | undefined =
          parsed?.data?.audio || parsed?.audio;
        if (hex && typeof hex === 'string' && hex.length > 0) {
          const buffer = Buffer.from(hex, 'hex');
          if (buffer.length > 0) {
            if (!firstChunkEmitted) {
              firstChunkEmitted = true;
              try { opts.onFirstChunk?.(Date.now() - t0); } catch {}
            }
            yield buffer;
          }
        }
        if (parsed?.extra_info) {
          try { opts.onMeta?.(parsed.extra_info); } catch {}
        }
        // MiniMax sometimes sends a base_resp on error.
        if (parsed?.base_resp && parsed.base_resp.status_code && parsed.base_resp.status_code !== 0) {
          throw new Error(
            `MiniMax stream error ${parsed.base_resp.status_code}: ${parsed.base_resp.status_msg || ''}`,
          );
        }
      }
    }
    // Flush any trailing event without a separator.
    if (buf.trim().length > 0) {
      const parsed = parseSseEvent(buf);
      if (parsed) {
        const hex: string | undefined = parsed?.data?.audio || parsed?.audio;
        if (hex && typeof hex === 'string' && hex.length > 0) {
          const buffer = Buffer.from(hex, 'hex');
          if (buffer.length > 0) {
            if (!firstChunkEmitted) {
              firstChunkEmitted = true;
              try { opts.onFirstChunk?.(Date.now() - t0); } catch {}
            }
            yield buffer;
          }
        }
        if (parsed?.extra_info) {
          try { opts.onMeta?.(parsed.extra_info); } catch {}
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function indexOfDoubleNewline(s: string): number {
  const a = s.indexOf('\n\n');
  const b = s.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

// Parse one SSE event block. SSE is a series of "field: value" lines;
// MiniMax only uses the `data:` field. Multiple `data:` lines are joined
// with \n per spec. We then JSON.parse the joined payload.
function parseSseEvent(raw: string): any | null {
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // ignore event:/id:/retry: for now
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// Fixed short acks for VAD-end fallback when contextual filler isn't ready.
// Synth happens on-demand (no pre-cache). Picked randomly per request.
export const FIXED_ACK_POOL: string[] = [
  '嗯,',
  '对,',
  'OK so,',
  'Right,',
  'Yeah,',
  'Mm-hm,',
];

export function pickRandomFixedAck(): string {
  return FIXED_ACK_POOL[Math.floor(Math.random() * FIXED_ACK_POOL.length)];
}
