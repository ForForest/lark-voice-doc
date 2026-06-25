/**
 * volc-tts.ts — 火山引擎 (Volcengine) big-model streaming TTS (Seed-TTS 2.0,
 * 双向流式语音合成). Drop-in replacement for the MiniMax TTS layer.
 *
 * Same vendor / transport family as the ASR in `volc-stt.ts`:
 *   host  wss://openspeech.bytedance.com
 *   auth  HEADER based — X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id
 *         (reuses VOLC_APP_ID + VOLC_ACCESS_TOKEN from .env; no signing key)
 *   wire  4-byte binary header + length-prefixed fields, every frame sets the
 *         `WithEvent` flag and carries an event int + (for non-connection
 *         events) a session_id before the payload. Audio returns in
 *         AudioOnlyServer (msgType 0b1011) frames.
 *
 * ── PERSISTENT CONNECTION (the latency fix) ──────────────────────────────────
 * Measured: opening a fresh authenticated WS to the TTS endpoint costs ~3.5-5.5s
 * (火山 allocates a synthesis session/resource on the upgrade for the high-
 * quality seed-tts-2.0 model). The model's own time-to-first-audio is only
 * ~0.85s and the protocol round-trips ~1.1s. Opening a new WS per utterance
 * re-pays the 3.5-5.5s every turn.
 *
 * So we keep ONE warm connection (StartConnection done once) and run each
 * utterance as a fresh session (StartSession → TaskRequest → FinishSession) on
 * it. Verified: 2nd+ sessions on a warm connection reach first audio in ~1.2s.
 * The connection idle-closes after VOLC_TTS_IDLE_CONN_MS and auto-reconnects on
 * demand or error. Call prewarmVolcTts() at server boot so even the first turn
 * skips the cold open. Utterances are serialized on the shared connection.
 *
 * Public API is unchanged: synthesizeVolc / synthesizeVolcStream.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import process from 'node:process';

// ── Config (env-overridable, verified defaults) ──────────────────────────────
const ENDPOINT =
  process.env.VOLC_TTS_ENDPOINT || 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const DEFAULT_RESOURCE_ID = process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0';
const DEFAULT_VOICE = process.env.VOLC_TTS_VOICE || 'zh_female_vv_uranus_bigtts';
const DEFAULT_FORMAT = (process.env.VOLC_TTS_FORMAT as 'mp3' | 'pcm') || 'mp3';
const DEFAULT_SAMPLE_RATE = Number(process.env.VOLC_TTS_SAMPLE_RATE || 24000);
// Steady, composed tone for the insight-driven creative partner: 'professional'
// emotion + a touch slower than 1.0 so it sounds considered, not rushed.
// (All emotions verified to not error on the seed-tts-2.0 voice.)
const DEFAULT_EMOTION = process.env.VOLC_TTS_EMOTION || 'professional';
const DEFAULT_SPEED = process.env.VOLC_TTS_SPEED ? Number(process.env.VOLC_TTS_SPEED) : 0.95;
// Time budget to establish the connection (WS upgrade + StartConnection ack).
const CONNECT_TIMEOUT_MS = Number(process.env.VOLC_TTS_CONNECT_TIMEOUT_MS || 20000);
// Fail a session after this long with NO frames (inactivity watchdog).
const SESSION_IDLE_MS = Number(process.env.VOLC_TTS_TIMEOUT_MS || 20000);
// Close the shared connection after this long with no active sessions, to free
// the 火山 resource (and avoid server-side idle resets surprising us).
const IDLE_CONN_MS = Number(process.env.VOLC_TTS_IDLE_CONN_MS || 90000);

// ── Protocol constants ───────────────────────────────────────────────────────
const MSG = {
  FullClientRequest: 0b0001,
  AudioOnlyServer: 0b1011, // audio payload comes back here
  FullServerResponse: 0b1001,
  Error: 0b1111,
} as const;
const FLAG_EVENT = 0b0100; // WithEvent — set on every TTS frame
const SER_JSON = 0b0001;

const EV = {
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
} as const;

const CONNECTION_EVENTS = new Set<number>([
  EV.StartConnection,
  EV.FinishConnection,
  EV.ConnectionStarted,
  EV.ConnectionFailed,
  EV.ConnectionFinished,
]);

export interface VolcTtsOptions {
  text: string;
  /** 火山 speaker id (default zh_female_vv_uranus_bigtts). Mirrors minimax `voice`. */
  voice?: string;
  /** 0–2 float multiplier (minimax-style); mapped to 火山 speech_rate [-50,100]. */
  speed?: number;
  /** 'mp3' (default, matches renderer) or 'pcm' (raw PCM16 mono). */
  format?: 'mp3' | 'pcm';
  /** Output sample rate (pcm/mp3). Default 24000. */
  sampleRate?: number;
  /** Optional emotion (2.0 emo voices): happy|sad|angry|excited|neutral|… */
  emotion?: string;
  onFirstChunk?: (ms: number) => void;
  onMeta?: (meta: { sampleRate: number; format: string }) => void;
}

// ── Binary framing ───────────────────────────────────────────────────────────
function buildFrame(event: number, sessionId: string | null, payloadObj: any): Buffer {
  const header = Buffer.from([
    0x11, // proto v1, header size 1 dword
    (MSG.FullClientRequest << 4) | FLAG_EVENT,
    (SER_JSON << 4) | 0x0, // JSON, no compression
    0x00,
  ]);
  const evBuf = Buffer.alloc(4);
  evBuf.writeInt32BE(event, 0);
  const parts: Buffer[] = [header, evBuf];
  if (!CONNECTION_EVENTS.has(event)) {
    const sid = Buffer.from(sessionId || '', 'utf-8');
    const sidLen = Buffer.alloc(4);
    sidLen.writeUInt32BE(sid.length, 0);
    parts.push(sidLen, sid);
  }
  const payload = Buffer.from(JSON.stringify(payloadObj ?? {}), 'utf-8');
  const plen = Buffer.alloc(4);
  plen.writeUInt32BE(payload.length, 0);
  parts.push(plen, payload);
  return Buffer.concat(parts);
}

interface Decoded {
  msgType: number;
  event: number | null;
  sessionId: string | null;
  payload: Buffer;
  errorCode?: number;
}
function decodeFrame(data: Buffer): Decoded | null {
  if (data.length < 4) return null;
  const msgType = (data[1] >> 4) & 0xf;
  const flags = data[1] & 0xf;
  let off = 4;
  let errorCode: number | undefined;
  let event: number | null = null;
  let sessionId: string | null = null;
  if (msgType === MSG.Error && off + 4 <= data.length) {
    errorCode = data.readUInt32BE(off);
    off += 4;
  }
  if (flags & FLAG_EVENT && off + 4 <= data.length) {
    event = data.readInt32BE(off);
    off += 4;
  }
  // length-prefixed id (session_id for normal events, connect_id for conn events)
  if (event !== null && off + 4 <= data.length) {
    const idLen = data.readUInt32BE(off);
    if (idLen >= 0 && idLen < 1024 && off + 4 + idLen <= data.length) {
      const id = data.slice(off + 4, off + 4 + idLen).toString('utf-8');
      if (!CONNECTION_EVENTS.has(event)) sessionId = id; // session events carry session_id
      off += 4 + idLen;
    } else {
      // Structurally invalid id field — refuse to read a payload from
      // non-payload bytes. Header-derived fields are still valid for routing.
      return { msgType, event, sessionId, payload: Buffer.alloc(0), errorCode };
    }
  }
  let payload = Buffer.alloc(0);
  if (off + 4 <= data.length) {
    const plen = data.readUInt32BE(off);
    off += 4;
    payload = data.slice(off, off + plen);
  }
  return { msgType, event, sessionId, payload, errorCode };
}

function speedToSpeechRate(speed?: number): number {
  if (speed === undefined || speed === null) return 0;
  const v = Math.round((speed - 1.0) * 100);
  return Math.max(-50, Math.min(100, v));
}

// ── Active session (one in flight at a time on the shared connection) ─────────
interface ActiveSession {
  sessionId: string;
  push: (buf: Buffer) => void;
  done: () => void;
  fail: (e: Error) => void;
  onSessionStarted: () => void;
  touch: () => void;
}

/**
 * Persistent 火山 TTS connection. One warm WS, reused across utterances. Lazily
 * (re)connects; idle-closes after IDLE_CONN_MS; serializes utterances.
 */
class VolcTtsConnection {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private connReadyResolve: (() => void) | null = null;
  private connReadyReject: ((e: Error) => void) | null = null;
  private active: ActiveSession | null = null;
  private mutex: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;

  /** Open the connection ahead of time so the first utterance skips cold start. */
  prewarm(): void {
    this.ensureConnected().catch(() => {
      /* best effort — a real synth will retry and surface the error */
    });
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (!this.active) this.teardown();
    }, IDLE_CONN_MS);
    this.idleTimer.unref?.();
  }

  private teardown(err?: Error): void {
    const e = err || new Error('火山 TTS connection closed');
    if (this.connReadyReject) {
      const rej = this.connReadyReject;
      this.connReadyReject = null;
      this.connReadyResolve = null;
      rej(e);
    }
    if (this.active) {
      const s = this.active;
      this.active = null;
      s.fail(e);
    }
    this.connecting = null;
    this.clearIdle();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {}
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.connecting) {
      return Promise.resolve();
    }
    if (this.connecting) return this.connecting;

    const appKey = process.env.VOLC_APP_ID;
    const accessKey = process.env.VOLC_ACCESS_TOKEN;
    if (!appKey || !accessKey) {
      return Promise.reject(new Error('VOLC_APP_ID / VOLC_ACCESS_TOKEN not set in env (火山 TTS)'));
    }

    this.connecting = new Promise<void>((resolve, reject) => {
      this.connReadyResolve = resolve;
      this.connReadyReject = reject;
      let ws: WebSocket;
      try {
        ws = new WebSocket(ENDPOINT, {
          headers: {
            'X-Api-App-Id': appKey,
            'X-Api-App-Key': appKey,
            'X-Api-Access-Key': accessKey,
            'X-Api-Resource-Id': DEFAULT_RESOURCE_ID,
            'X-Api-Request-Id': randomUUID(),
            'X-Api-Connect-Id': randomUUID(),
          },
        });
      } catch (e) {
        this.connecting = null;
        this.connReadyResolve = null;
        this.connReadyReject = null;
        return reject(e as Error);
      }
      this.ws = ws;
      const connectTimer = setTimeout(
        () => this.teardown(new Error(`火山 TTS connect timeout ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
      );
      ws.on('open', () => {
        try {
          ws.send(buildFrame(EV.StartConnection, null, {}));
        } catch (e) {
          this.teardown(e as Error);
        }
      });
      ws.on('message', (data: Buffer) => {
        clearTimeout(connectTimer);
        this.onMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
      });
      ws.on('error', (e) => this.teardown(new Error(`火山 TTS ws error: ${(e as Error).message}`)));
      ws.on('unexpected-response', (_req, res) =>
        this.teardown(new Error(`火山 TTS handshake HTTP ${res.statusCode}`)),
      );
      ws.on('close', () => this.teardown());
    }).then(() => {
      // Connection is ready; subsequent ensureConnected() calls short-circuit.
      this.connecting = null;
    });
    return this.connecting;
  }

  private onMessage(data: Buffer): void {
    const d = decodeFrame(data);
    if (!d) return;
    // ── connection-level ──
    if (d.event === EV.ConnectionStarted) {
      const ok = this.connReadyResolve;
      this.connReadyResolve = null;
      this.connReadyReject = null;
      ok?.();
      return;
    }
    if (d.event === EV.ConnectionFailed) {
      return this.teardown(new Error(`火山 TTS ConnectionFailed: ${d.payload.toString('utf-8').slice(0, 200)}`));
    }
    if (d.msgType === MSG.Error && !d.sessionId) {
      return this.teardown(
        new Error(`火山 TTS error code=${d.errorCode}: ${d.payload.toString('utf-8').slice(0, 200)}`),
      );
    }
    // ── session-scoped ──
    const s = this.active;
    if (!s) return;
    if (d.sessionId && d.sessionId !== s.sessionId) return; // straggler from a finished session
    s.touch();
    if (d.msgType === MSG.AudioOnlyServer) {
      if (d.payload.length > 0) s.push(d.payload);
      return;
    }
    if (d.msgType === MSG.Error) {
      return s.fail(new Error(`火山 TTS error code=${d.errorCode}: ${d.payload.toString('utf-8').slice(0, 200)}`));
    }
    switch (d.event) {
      case EV.SessionStarted:
        s.onSessionStarted();
        break;
      case EV.SessionFailed:
        s.fail(new Error(`火山 TTS SessionFailed: ${d.payload.toString('utf-8').slice(0, 200)}`));
        break;
      case EV.SessionFinished:
      case EV.TTSEnded:
        s.done();
        break;
      default:
        break; // TTSSentenceStart/End, TTSResponse — metadata, ignore
    }
  }

  /** Synthesize one utterance, yielding audio chunks. Serialized on the connection. */
  async *synth(opts: VolcTtsOptions): AsyncGenerator<Buffer, void, void> {
    // Serialize: take the mutex so only one session runs on the shared socket.
    let release!: () => void;
    const prev = this.mutex;
    this.mutex = new Promise<void>((r) => (release = r));
    await prev;
    this.clearIdle();
    try {
      yield* this.runSession(opts);
    } finally {
      release();
      this.armIdle();
    }
  }

  private async *runSession(opts: VolcTtsOptions): AsyncGenerator<Buffer, void, void> {
    await this.ensureConnected();
    const ws = this.ws;
    if (!ws) throw new Error('火山 TTS connection unavailable');

    const format = opts.format || DEFAULT_FORMAT;
    const sampleRate = opts.sampleRate || DEFAULT_SAMPLE_RATE;
    const voice = opts.voice || DEFAULT_VOICE;
    const reqId = randomUUID();
    const sessionId = randomUUID();

    const speed = opts.speed ?? DEFAULT_SPEED;
    const emotion = opts.emotion ?? DEFAULT_EMOTION;
    const audioParams: Record<string, any> = {
      format,
      sample_rate: sampleRate,
      speech_rate: speedToSpeechRate(speed),
    };
    if (emotion && emotion !== 'auto' && emotion !== 'none') audioParams.emotion = emotion;
    const reqParams = { speaker: voice, audio_params: audioParams };

    const queue: Buffer[] = [];
    let finished = false;
    let failure: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = () => {
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    };

    const t0 = Date.now();
    let firstChunkSent = false;
    const watchdog = setTimeout(
      () => {
        if (!finished && !failure) failure = new Error(`火山 TTS idle ${SESSION_IDLE_MS}ms (no frames)`);
        finished = true;
        wake();
      },
      SESSION_IDLE_MS,
    );

    const session: ActiveSession = {
      sessionId,
      push: (b) => {
        if (!firstChunkSent) {
          firstChunkSent = true;
          try {
            opts.onFirstChunk?.(Date.now() - t0);
          } catch {}
        }
        queue.push(b);
        wake();
      },
      done: () => {
        finished = true;
        wake();
      },
      fail: (e) => {
        if (!failure) failure = e;
        finished = true;
        wake();
      },
      onSessionStarted: () => {
        try {
          ws.send(
            buildFrame(EV.TaskRequest, sessionId, {
              user: { uid: reqId },
              namespace: 'BidirectionalTTS',
              req_params: { ...reqParams, text: opts.text },
            }),
          );
          ws.send(buildFrame(EV.FinishSession, sessionId, {}));
        } catch (e) {
          session.fail(e as Error);
        }
      },
      touch: () => {
        watchdog.refresh();
      },
    };
    this.active = session;
    opts.onMeta?.({ sampleRate, format });

    try {
      ws.send(
        buildFrame(EV.StartSession, sessionId, {
          user: { uid: reqId },
          namespace: 'BidirectionalTTS',
          req_params: reqParams,
        }),
      );
    } catch (e) {
      session.fail(e as Error);
    }

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    } finally {
      clearTimeout(watchdog);
      if (this.active === session) this.active = null;
    }
  }
}

let sharedConn: VolcTtsConnection | null = null;
function getConn(): VolcTtsConnection {
  if (!sharedConn) sharedConn = new VolcTtsConnection();
  return sharedConn;
}

/** Open the shared 火山 TTS connection ahead of time (call at server boot). */
export function prewarmVolcTts(): void {
  getConn().prewarm();
}

/**
 * Streaming synth: yields audio Buffers (mp3 frames or raw PCM16 chunks) as they
 * arrive from 火山, over the shared warm connection. Mirrors
 * `synthesizeMinimaxStream`.
 */
export async function* synthesizeVolcStream(
  opts: VolcTtsOptions,
): AsyncGenerator<Buffer, void, void> {
  yield* getConn().synth(opts);
}

/**
 * One-shot synth: drains the stream into a single Buffer. Mirrors
 * `synthesizeMinimax` (returns `{ audio, durationMs, latencyMs, format }`).
 */
export async function synthesizeVolc(
  opts: VolcTtsOptions,
): Promise<{ audio: Buffer; durationMs: number; latencyMs: number; format: 'mp3' | 'pcm'; sampleRate: number }> {
  const format = opts.format || DEFAULT_FORMAT;
  const sampleRate = opts.sampleRate || DEFAULT_SAMPLE_RATE;
  const t0 = Date.now();
  let firstChunkMs = -1;
  const chunks: Buffer[] = [];
  for await (const buf of synthesizeVolcStream({
    ...opts,
    onFirstChunk: (ms) => {
      firstChunkMs = ms;
    },
  })) {
    chunks.push(buf);
  }
  const audio = Buffer.concat(chunks);
  const latencyMs = firstChunkMs >= 0 ? firstChunkMs : Date.now() - t0;
  const durationMs =
    format === 'pcm'
      ? Math.round((audio.length / 2 / sampleRate) * 1000)
      : Math.round((audio.length * 8) / 128); // ~128kbps mp3 estimate
  return { audio, durationMs, latencyMs, format, sampleRate };
}
