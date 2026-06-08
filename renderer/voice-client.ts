/**
 * voice-client.ts — Renderer-side voice loop for the Beeni pill.
 *
 * Modes (Phase 4):
 *   - PTT (push-to-talk): hold Control / tap pill to talk one turn at a time.
 *     Default. Beeni replies with voice. Like Wispr Flow.
 *   - Recording: mic stays open, VAD-segmented, transcripts stream to server
 *     where they accumulate in RecordingSession. Beeni stays SILENT (no TTS)
 *     and pushes structured whiteboard summaries every 90s. User can briefly
 *     press Control + say "总结一下" to force a summary.
 *
 * Multi-doc binding (Phase 4):
 *   - 1 Target doc (writes route here) + N Reference docs (Beeni can fetch).
 *   - LocalStorage persists across pill restarts.
 *
 * State machine (PTT path): IDLE → LISTENING → HEARING → THINKING → SPEAKING → LISTENING/IDLE
 * State machine (Recording path): IDLE → LISTENING (perpetual) → HEARING segments → back to LISTENING
 *
 * Audio capture pipeline (unchanged):
 *   getUserMedia → AudioContext (48k) → ScriptProcessor → downsample to 16k
 *   → Int16LE 100ms chunks → WebSocket /api/stt (binary frames)
 *
 * Fallback: if conversation WS fails to connect after 3s, fall back to
 * single-shot `window.beeni.agentRun()` IPC path (the v1 behavior).
 */

type PillState = 'IDLE' | 'LISTENING' | 'HEARING' | 'THINKING' | 'SPEAKING' | 'ERROR';

type ToolStatus = '' | 'DOC' | 'BOARD' | 'CODE' | 'WEB';

type AppMode = 'ptt' | 'recording';

interface BoundDocRef {
  docToken: string;
  whiteboardToken: string | null;
  title: string | null;
}

interface BeeniTtsChunk {
  meta?: { format: 'pcm' | 'mp3'; sampleRate?: number; channels?: number };
  mp3Chunk?: string;
  pcmChunk?: string;
  sampleRate?: number;
  done?: boolean;
  error?: string;
}

interface BeeniAgentResult {
  ok: boolean;
  finalText?: string;
  rounds?: number;
  error?: string;
}

type PttMode = 'uiohook' | 'toggle' | 'none';

interface BeeniBridge {
  agentRun: (prompt: string) => Promise<BeeniAgentResult>;
  ttsStream: (text: string) => Promise<{ ok: boolean; error?: string }>;
  onTtsChunk: (cb: (chunk: BeeniTtsChunk) => void) => () => void;
  onStartListening: (cb: () => void) => () => void;
  onPttStart: (cb: () => void) => () => void;
  onPttStop: (cb: () => void) => () => void;
  onPttToggle: (cb: () => void) => () => void;
  getPttMode: () => Promise<PttMode>;
  getServer: () => Promise<string>;
  hidePill: () => void;
  showPill: () => void;
  setIdle: (isIdle: boolean) => void;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  setPillExpanded: (expanded: boolean) => void;
  setPillRecording: (active: boolean) => void;
}

interface Window {
  beeni: BeeniBridge;
}

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const SILENCE_FINALIZE_MS = 1500;
const IDLE_AUTOHIDE_GUARD_MS = 30000;
const TTS_FLUSH_CHARS = 80;
const TTS_SENTENCE_END_RE = /[。！？；…\n!?;]/;
const BARGEIN_RMS_THRESHOLD = 0.03;
const BARGEIN_SUSTAINED_FRAMES = 3;
const LS_KEY_BINDINGS = 'beeni.bindings.v1';
const LS_KEY_MODE = 'beeni.mode.v1';

const pillEl = document.getElementById('pill') as HTMLDivElement;
const textEl = document.getElementById('text') as HTMLDivElement;
const shellEl = document.getElementById('shell') as HTMLDivElement;
const bindToggleEl = document.getElementById('bindToggle') as HTMLButtonElement | null;
const modeToggleEl = document.getElementById('modeToggle') as HTMLButtonElement | null;
const targetInputEl = document.getElementById('targetInput') as HTMLInputElement | null;
const targetBtnEl = document.getElementById('targetBtn') as HTMLButtonElement | null;
const referenceInputEl = document.getElementById('referenceInput') as HTMLInputElement | null;
const referenceAddBtnEl = document.getElementById('referenceAddBtn') as HTMLButtonElement | null;
const boundChipsEl = document.getElementById('boundChips') as HTMLDivElement | null;
const bindStatusEl = document.getElementById('bindStatus') as HTMLSpanElement | null;
const bindClearAllBtnEl = document.getElementById('bindClearAllBtn') as HTMLButtonElement | null;
const recordingStatusTextEl = document.getElementById('recordingStatusText') as HTMLSpanElement | null;

// Bound doc state (mirrors server-side ConversationSession.boundTarget / .boundReferences).
let boundTarget: BoundDocRef | null = null;
let boundReferences: BoundDocRef[] = [];

let state: PillState = 'IDLE';
let toolStatus: ToolStatus = '';
let appMode: AppMode = 'ptt';
let sttWs: WebSocket | null = null;
let convWs: WebSocket | null = null;
let convWsReady = false;
let convFallbackActive = false;
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let sttReady = false;
let lastPartialAt = 0;
let silenceTimer: number | null = null;
let currentTranscript = '';
// 2026-05-24 critical fix: track whether STT has emitted its `final` event for
// the current utterance. The OLD pttFinalizeWithWait broke out of its wait loop
// the moment ANY currentTranscript appeared — which meant the LAST partial
// (often truncated, e.g. "建一" mid-utterance) got forwarded as the user's
// turn, before 火山 actually returned its full final. Now we wait for `final`
// specifically.
let gotSttFinal = false;
// 2026-05-24: guard so finalizeUtterance() (silence-timer path) doesn't race
// with pttFinalizeWithWait() (PTT-release path) and double-fire user-final.
let pttFinalizeInFlight = false;
// 2026-05-24: dedupe — once we close STT cleanly, ignore late `final` messages
// that arrive after we've moved on (otherwise a stale final from press N can
// contaminate press N+1).
let sttCloseRequested = false;
let idleAutoHideTimer: number | null = null;

// TTS playback queue (PTT only — recording mode is silent).
let speakingAudio: HTMLAudioElement | null = null;
const ttsQueue: string[] = [];
let ttsBuffer = '';
let activeTtsListenerUnbind: (() => void) | null = null;
let activeTtsChunks: Uint8Array[] = [];
let activeTtsMime = 'audio/mpeg';
let isFetchingTts = false;

// Barge-in detection
let bargeInArmed = false;
let bargeInFrames = 0;

// Push-to-talk runtime state
let pttMode: PttMode = 'none';
let pttHolding = false;
let pttToggleActive = false;

// Recording mode status (server-pushed)
let recordingStatusState = {
  listening: false,
  listeningMs: 0,
  lastSummaryAt: 0,
  bufferChunks: 0,
  pendingSummary: false,
};

// ── UI helpers ──────────────────────────────────────────────────────────
function setState(next: PillState, line?: string): void {
  state = next;
  pillEl.dataset.state = next;
  if (line !== undefined) setText(line);

  if (next === 'IDLE') {
    window.beeni.setIdle(true);
    if (idleAutoHideTimer) clearTimeout(idleAutoHideTimer);
    idleAutoHideTimer = window.setTimeout(() => {
      window.beeni.setIdle(true);
    }, IDLE_AUTOHIDE_GUARD_MS);
  } else {
    window.beeni.setIdle(false);
    if (idleAutoHideTimer) {
      clearTimeout(idleAutoHideTimer);
      idleAutoHideTimer = null;
    }
  }
}

function setText(s: string): void {
  const icon = toolStatus === 'DOC' ? '📄 ' :
               toolStatus === 'BOARD' ? '🖼 ' :
               toolStatus === 'CODE' ? '🔍 ' :
               toolStatus === 'WEB' ? '🌐 ' : '';
  textEl.textContent = icon + s;
}

function setToolStatus(s: ToolStatus, text?: string): void {
  toolStatus = s;
  if (text !== undefined) setText(text);
  else setText(textEl.textContent?.replace(/^[📄🖼🔍🌐]\s*/, '') || '');
}

function setIdleHint(): void {
  toolStatus = '';
  setState('IDLE', idleHintText());
}

function idleHintText(): string {
  if (appMode === 'recording') {
    if (recordingStatusState.bufferChunks > 0) {
      const mins = Math.floor(recordingStatusState.listeningMs / 60000);
      const secs = Math.floor((recordingStatusState.listeningMs % 60000) / 1000);
      return `🎙 录音中 · 已听 ${mins ? mins + '分' : ''}${secs}秒`;
    }
    return '🎙 录音中 · 等说话';
  }
  if (pttMode === 'toggle') return '按 ⌃Space 切换';
  if (pttMode === 'none') return '⌘⌥B 显隐 · 点我说话';
  return '按住 ⌃ 说话';
}

function setError(msg: string): void {
  toolStatus = '';
  setState('ERROR', msg.slice(0, 120));
  setTimeout(() => {
    if (state === 'ERROR') {
      setIdleHint();
    }
  }, 3500);
}

// ── audio capture + downsample ──────────────────────────────────────────
function downsampleTo16k(input: Float32Array, fromRate: number): Int16Array {
  if (fromRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const newLen = Math.round(input.length / ratio);
  const out = new Int16Array(newLen);
  let pos = 0;
  let i = 0;
  while (i < newLen) {
    const nextPos = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = pos; j < nextPos && j < input.length; j++) {
      sum += input[j];
      count++;
    }
    const avg = count > 0 ? sum / count : 0;
    const s = Math.max(-1, Math.min(1, avg));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    pos = nextPos;
    i++;
  }
  return out;
}

function computeRms(int16: Int16Array): number {
  let sumSq = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 0x8000;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / int16.length);
}

async function startMic(): Promise<void> {
  if (mediaStream) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
    video: false,
  });
  audioContext = new AudioContext();
  // 2026-05-24 fix: AudioContext starts SUSPENDED in Electron when created from
  // a non-user-gesture context. Without resume(), onaudioprocess fires but with
  // ZERO buffers — mic appears to capture silence even though permission granted.
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch (e) {
      console.warn('[mic] audioContext.resume() failed:', e);
    }
  }
  console.log('[mic] started, audioContext.state=' + audioContext.state + ' sampleRate=' + audioContext.sampleRate);
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const bufferSize = 4096;
  scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  let chunkBuffer: number[] = [];
  let chunkLogCount = 0;
  const samplesPerChunk = Math.floor((TARGET_SAMPLE_RATE * CHUNK_MS) / 1000);

  scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, audioContext!.sampleRate);
    // Log RMS on first 5 chunks per session — diagnose silent mic
    if (chunkLogCount < 5) {
      const rms = computeRms(downsampled);
      console.log('[mic] chunk#' + chunkLogCount + ' rms=' + rms.toFixed(4) + ' samples=' + downsampled.length);
      chunkLogCount++;
    }
    for (let i = 0; i < downsampled.length; i++) {
      chunkBuffer.push(downsampled[i]);
    }
    while (chunkBuffer.length >= samplesPerChunk) {
      const slice = chunkBuffer.splice(0, samplesPerChunk);
      const int16 = new Int16Array(slice);

      if (bargeInArmed && state === 'SPEAKING') {
        const rms = computeRms(int16);
        if (rms > BARGEIN_RMS_THRESHOLD) {
          bargeInFrames++;
          if (bargeInFrames >= BARGEIN_SUSTAINED_FRAMES) {
            handleBargeIn();
            bargeInFrames = 0;
          }
        } else {
          bargeInFrames = 0;
        }
      } else {
        bargeInFrames = 0;
      }

      sendPcmChunk(int16);
    }
  };

  sourceNode.connect(scriptNode);
  scriptNode.connect(audioContext.destination);
}

function stopMic(): void {
  if (scriptNode) {
    try { scriptNode.disconnect(); } catch {}
    scriptNode.onaudioprocess = null as any;
    scriptNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch {}
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) {
      try { t.stop(); } catch {}
    }
    mediaStream = null;
  }
  bargeInArmed = false;
  bargeInFrames = 0;
}

// ── Conversation WebSocket (long-lived) ──────────────────────────────────
// 2026-05-24 fix: server is spawned as child of Electron main; on first launch
// it can take 2-5s to bind port 3001. Renderer was failing immediately + falling
// back to IPC (= single-shot, no multi-turn). Now we retry every 1.5s up to 10
// tries (= 15s total) before giving up.
async function openConversationSocket(): Promise<void> {
  if (convWs && convWs.readyState === WebSocket.OPEN) return;

  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ok = await tryOpenOnce();
    if (ok) {
      console.log(`[conv] WS connected on attempt ${attempt}`);
      return;
    }
    if (attempt < MAX_RETRIES) {
      console.log(`[conv] connect attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise<void>((r) => window.setTimeout(r, RETRY_DELAY_MS));
    }
  }
  console.warn('[conv] giving up after', MAX_RETRIES, 'attempts — falling back to IPC');
  convFallbackActive = true;
}

async function tryOpenOnce(): Promise<boolean> {
  const serverBase = await window.beeni.getServer();
  const wsUrl = serverBase.replace(/^http/, 'ws') + '/api/conversation';

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    convWs = ws;
    convWsReady = false;

    const failTimer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch {}
        resolve(false);
      }
    }, 2500);

    ws.addEventListener('message', (evt: MessageEvent) => {
      if (typeof evt.data !== 'string') return;
      let m: any;
      try { m = JSON.parse(evt.data); } catch { return; }
      handleConvMessage(m);
      if (m.type === 'ready' && !settled) {
        settled = true;
        clearTimeout(failTimer);
        convWsReady = true;
        convFallbackActive = false;
        restoreBindingsToServer();
        if (appMode === 'recording') {
          sendConv({ type: 'mode-set', mode: 'recording' });
        }
        resolve(true);
      }
    });

    ws.addEventListener('close', () => {
      convWsReady = false;
      convWs = null;
    });

    ws.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(failTimer);
        resolve(false);
      }
    });
  });
}

function sendConv(obj: any): boolean {
  if (!convWs || convWs.readyState !== WebSocket.OPEN || !convWsReady) return false;
  try {
    convWs.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function handleConvMessage(m: any): void {
  switch (m.type) {
    case 'ready':
      break;
    case 'turn-start':
      setState('THINKING', '在想…');
      break;
    case 'assistant-text': {
      const tok = String(m.token || '');
      if (!tok) break;
      // In recording mode, Beeni stays silent — do NOT switch to SPEAKING or
      // play TTS. Just show the text inline for transparency.
      if (appMode === 'recording') {
        ttsBuffer += tok;
        const visible = ttsBuffer.length > 60 ? '…' + ttsBuffer.slice(-60) : ttsBuffer;
        setText(visible);
        break;
      }
      if (state !== 'SPEAKING') {
        setState('SPEAKING', '');
        bargeInArmed = true;
        bargeInFrames = 0;
      }
      ttsBuffer += tok;
      const visible = ttsBuffer.length > 60 ? '…' + ttsBuffer.slice(-60) : ttsBuffer;
      setText(visible);
      maybeFlushTtsBuffer(false);
      break;
    }
    case 'tool-call': {
      const name = String(m.name || '');
      if (name === 'create_doc' || name === 'update_doc') {
        setToolStatus('DOC', '写文档…');
      } else if (name === 'update_whiteboard') {
        setToolStatus('BOARD', '更新白板…');
      } else if (name === 'fetch_whiteboard') {
        setToolStatus('BOARD', '看白板…');
      } else if (name === 'search_repo' || name === 'read_file' || name === 'fetch_doc') {
        setToolStatus('CODE', '查文档…');
      } else if (name === 'web_search') {
        setToolStatus('WEB', '查资料…');
      }
      break;
    }
    case 'tool-result': {
      if (m.ok) {
        setToolStatus(toolStatus, `✓ ${m.summary || '完成'}`);
        setTimeout(() => {
          if (toolStatus !== '') {
            toolStatus = '';
          }
        }, 1500);
      } else {
        setToolStatus(toolStatus, `✗ ${m.summary || '失败'}`);
        setTimeout(() => { toolStatus = ''; }, 2000);
      }
      break;
    }
    case 'turn-done':
      if (appMode !== 'recording') {
        maybeFlushTtsBuffer(true);
        if (ttsQueue.length === 0 && !speakingAudio && !isFetchingTts) {
          onTtsAllDone();
        }
      } else {
        // In recording mode, no TTS — just settle back to IDLE-ish.
        ttsBuffer = '';
        setIdleHint();
      }
      break;
    case 'open-url': {
      const url = String(m.url || '');
      if (url) {
        window.beeni.openExternal(url).catch((err) => {
          console.warn('[conv] openExternal failed:', err);
        });
      }
      break;
    }
    case 'bind-state': {
      // Authoritative server state — overwrite ours.
      const t = m.target;
      if (t && t.docToken) {
        boundTarget = {
          docToken: String(t.docToken),
          whiteboardToken: t.whiteboardToken ? String(t.whiteboardToken) : null,
          title: t.title ? String(t.title) : null,
        };
      } else {
        boundTarget = null;
      }
      const refs = Array.isArray(m.references) ? m.references : [];
      boundReferences = refs
        .filter((r: any) => r && r.docToken)
        .map((r: any) => ({
          docToken: String(r.docToken),
          whiteboardToken: r.whiteboardToken ? String(r.whiteboardToken) : null,
          title: r.title ? String(r.title) : null,
        }));
      persistBindings();
      renderBoundChips();
      updateBoundFlag();
      break;
    }
    case 'bind-doc-ok': {
      // Legacy ack — server already sent bind-state too; nothing to do.
      break;
    }
    case 'mode-ok': {
      const m2 = m.mode === 'recording' ? 'recording' : 'ptt';
      setAppMode(m2, /*sendToServer*/ false);
      break;
    }
    case 'recording-status': {
      recordingStatusState = {
        listening: !!m.listening,
        listeningMs: Number(m.listeningMs || 0),
        lastSummaryAt: Number(m.lastSummaryAt || 0),
        bufferChunks: Number(m.bufferChunks || 0),
        pendingSummary: !!m.pendingSummary,
      };
      renderRecordingStatus();
      if (state === 'IDLE') setText(idleHintText());
      break;
    }
    case 'summary-pushed': {
      const note = String(m.changeNote || '已更新白板');
      const modelUsed = String(m.modelUsed || '');
      setBindStatus(`🖼 ${note} (${modelUsed} · ${m.latencyMs}ms)`, 'ok');
      break;
    }
    case 'summary-skipped': {
      const reason = String(m.reason || '无结构');
      setBindStatus(`⏭ 跳过: ${reason}`, '');
      break;
    }
    case 'summary-error': {
      setBindStatus(`⚠ 白板: ${String(m.error || 'error').slice(0, 40)}`, 'err');
      break;
    }
    case 'error':
      setError(`server: ${m.error || 'unknown'}`);
      break;
    case 'pong':
      break;
  }
}

// ── STT WebSocket (per-utterance for PTT, continuous segments for recording) ──
function sendPcmChunk(int16: Int16Array): void {
  // Only do anything if we're actively listening / hearing — recording mode is
  // continuous, PTT mode brackets each press. If WS isn't ready yet, BUFFER
  // (don't drop) — flushed by flushPendingPcm() once 'ready' arrives.
  if (state !== 'LISTENING' && state !== 'HEARING' && state !== 'SPEAKING') return;
  if (!sttWs || sttWs.readyState !== WebSocket.OPEN) return;
  if (!sttReady) {
    // Buffer. Cap at ~5 seconds of audio (50 chunks) to avoid runaway.
    if (pendingPcm.length < 50) pendingPcm.push(new Int16Array(int16));
    return;
  }
  sttWs.send(int16.buffer);
}

async function openSttSocket(): Promise<void> {
  const serverBase = await window.beeni.getServer();
  const wsUrl = serverBase.replace(/^http/, 'ws') + '/api/stt';
  return new Promise<void>((resolve, reject) => {
    let opened = false;
    const ws = new WebSocket(wsUrl);
    sttWs = ws;
    sttReady = false;
    currentTranscript = '';
    // 2026-05-24: reset per-utterance STT flags. Without this, a stale
    // gotSttFinal=true from press N would let press N+1's pttFinalizeWithWait
    // wait-loop exit instantly with empty/stale text.
    gotSttFinal = false;
    sttCloseRequested = false;
    pttFinalizeInFlight = false;
    sttEosAlreadySent = false;
    pendingPcm = []; // drop any stale audio from a prior aborted press

    ws.addEventListener('open', () => {
      opened = true;
    });

    ws.addEventListener('message', (evt: MessageEvent) => {
      if (typeof evt.data !== 'string') return;
      let parsed: any;
      try { parsed = JSON.parse(evt.data); } catch { return; }
      if (parsed.type === 'ready') {
        sttReady = true;
        resolve();
      } else if (parsed.type === 'partial' && typeof parsed.text === 'string') {
        // 2026-05-24: drop late partials after we've closed this STT session.
        if (sttCloseRequested) return;
        currentTranscript = parsed.text;
        lastPartialAt = Date.now();
        if (state === 'LISTENING' || state === 'HEARING') {
          setState('HEARING', parsed.text);
        }
        armSilenceTimer();
      } else if (parsed.type === 'final' && typeof parsed.text === 'string') {
        // 2026-05-24: drop late finals from a prior turn (e.g. arrived after
        // we already advanced via timeout). pttFinalizeWithWait sets
        // sttCloseRequested only AFTER it's consumed the final, so a legitimate
        // final still flows through.
        if (sttCloseRequested) return;
        // 2026-05-24: prefer the longer of (last partial, final). 火山 sometimes
        // emits an empty final after EOS even though partials accumulated text.
        const finalText = parsed.text || '';
        if (finalText.length >= currentTranscript.length) {
          currentTranscript = finalText;
        }
        gotSttFinal = true;
        // The silence-timer path (non-PTT or recording-mode segmentation) still
        // wants finalizeUtterance() to fire. The PTT-release path sets
        // pttFinalizeInFlight so we DON'T double-fire user-final here.
        if (!pttFinalizeInFlight) {
          finalizeUtterance();
        }
      } else if (parsed.type === 'error') {
        setError(`STT: ${parsed.message || 'unknown'}`);
        closeSttSocket();
      }
    });

    ws.addEventListener('error', () => {
      if (!opened) reject(new Error('STT WS error before open'));
    });

    ws.addEventListener('close', () => {
      sttReady = false;
      sttWs = null;
    });
  });
}

function closeSttSocket(): void {
  // 2026-05-24: mark close intent BEFORE sending EOS so any late `final` /
  // `partial` from the upstream we just told to wrap up gets ignored (those
  // would otherwise contaminate the NEXT press's currentTranscript).
  sttCloseRequested = true;
  if (sttWs) {
    try {
      if (sttWs.readyState === WebSocket.OPEN) {
        // Only send EOS if we haven't already (pttFinalizeWithWait sends it
        // explicitly before waiting; this avoids a redundant second EOS).
        if (!sttEosAlreadySent) {
          sttWs.send(JSON.stringify({ type: 'eos' }));
          sttEosAlreadySent = true;
        }
      }
      sttWs.close();
    } catch {}
    sttWs = null;
  }
  sttReady = false;
}

// 2026-05-24: track whether THIS STT session has already had EOS sent so
// closeSttSocket() doesn't double-send (which 火山 may treat as a malformed
// 2nd terminator and abandon the in-flight final response).
let sttEosAlreadySent = false;
function sendSttEos(): void {
  if (!sttWs || sttWs.readyState !== WebSocket.OPEN) return;
  if (sttEosAlreadySent) return;
  try {
    sttWs.send(JSON.stringify({ type: 'eos' }));
    sttEosAlreadySent = true;
  } catch {}
}

function armSilenceTimer(): void {
  if (silenceTimer) clearTimeout(silenceTimer);
  silenceTimer = window.setTimeout(() => {
    if (state === 'HEARING' && currentTranscript) {
      finalizeUtterance();
    }
  }, SILENCE_FINALIZE_MS);
}

// ── Barge-in ────────────────────────────────────────────────────────────
function handleBargeIn(): void {
  if (state !== 'SPEAKING') return;
  console.log('[conv] barge-in detected → interrupt');
  sendConv({ type: 'interrupt' });
  stopAllTts();
  setState('HEARING', '在听…');
  bargeInArmed = false;
}

// ── round orchestration ─────────────────────────────────────────────────
async function startListening(): Promise<void> {
  if (state === 'LISTENING' || state === 'HEARING' || state === 'THINKING') {
    return;
  }
  if (state === 'SPEAKING') {
    sendConv({ type: 'interrupt' });
    stopAllTts();
  }
  try {
    setState('LISTENING', appMode === 'recording' ? '🎙 在听…' : '在听…');
    if (!convWsReady && !convFallbackActive) {
      await openConversationSocket();
    }
    // 2026-05-24 fix: parallel mic init + STT WS. Previously serial — STT
    // upstream open took 600-1500ms during which mic wasn't capturing yet, so
    // short PTT presses ended with 0 PCM chunks sent.
    // PCM that arrives before sttReady=true is buffered + flushed on ready.
    const [_mic, _stt] = await Promise.all([
      startMic(),
      openSttSocket(),
    ]);
    // Flush any buffered PCM that arrived before STT ready.
    flushPendingPcm();
  } catch (err) {
    setError(`mic: ${(err as Error).message}`);
    stopMic();
    closeSttSocket();
  }
}

// Buffer PCM that arrived before STT WS is ready.
let pendingPcm: Int16Array[] = [];
function flushPendingPcm(): void {
  if (!sttWs || sttWs.readyState !== WebSocket.OPEN || !sttReady) return;
  for (const buf of pendingPcm) {
    try { sttWs.send(buf.buffer); } catch {}
  }
  if (pendingPcm.length > 0) {
    console.log(`[stt] flushed ${pendingPcm.length} buffered PCM chunks`);
  }
  pendingPcm = [];
}

async function finalizeUtterance(): Promise<void> {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  const text = currentTranscript.trim();
  if (!text) {
    if (appMode === 'recording') {
      // Stay listening in recording mode.
      currentTranscript = '';
      return;
    }
    setIdleHint();
    stopMic();
    closeSttSocket();
    return;
  }

  // Recording mode path: send transcript to RecordingSession, keep mic open.
  if (appMode === 'recording') {
    sendConv({
      type: 'recording-transcript',
      ts: Date.now(),
      text,
    });
    currentTranscript = '';
    // Stay in LISTENING — don't tear down mic.
    setState('LISTENING', '🎙 在听…');
    return;
  }

  // PTT path: tear down mic, fire user-final.
  stopMic();
  if (sttWs && sttWs.readyState === WebSocket.OPEN) {
    try { sttWs.send(JSON.stringify({ type: 'eos' })); } catch {}
  }
  setTimeout(() => closeSttSocket(), 300);

  setState('THINKING', '在想…');

  if (convWsReady && sendConv({ type: 'user-final', text })) {
    return;
  }

  // Fallback IPC path.
  try {
    const result = await window.beeni.agentRun(text);
    if (!result.ok) {
      setError(`agent: ${result.error || 'unknown'}`);
      return;
    }
    const reply = (result.finalText || '').trim();
    if (!reply) {
      setIdleHint();
      return;
    }
    await speakReplyLegacyMp3(reply);
    setIdleHint();
  } catch (err) {
    setError(`agent: ${(err as Error).message}`);
  }
}

// ── Streaming TTS (PTT only) ────────────────────────────────────────────
function maybeFlushTtsBuffer(force: boolean): void {
  if (!ttsBuffer) return;
  if (force) {
    enqueueTtsSentence(ttsBuffer);
    ttsBuffer = '';
    return;
  }
  const m = ttsBuffer.match(TTS_SENTENCE_END_RE);
  if (m && m.index !== undefined) {
    const end = m.index + m[0].length;
    const sentence = ttsBuffer.slice(0, end);
    ttsBuffer = ttsBuffer.slice(end);
    enqueueTtsSentence(sentence);
    return;
  }
  if (ttsBuffer.length >= TTS_FLUSH_CHARS) {
    enqueueTtsSentence(ttsBuffer);
    ttsBuffer = '';
  }
}

function enqueueTtsSentence(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  ttsQueue.push(trimmed);
  drainTtsQueue();
}

function drainTtsQueue(): void {
  if (isFetchingTts) return;
  if (speakingAudio) return;
  const next = ttsQueue.shift();
  if (!next) return;
  fetchAndPlayTts(next);
}

function fetchAndPlayTts(sentence: string): void {
  isFetchingTts = true;
  activeTtsChunks = [];
  activeTtsMime = 'audio/mpeg';

  if (activeTtsListenerUnbind) {
    activeTtsListenerUnbind();
    activeTtsListenerUnbind = null;
  }

  activeTtsListenerUnbind = window.beeni.onTtsChunk((chunk) => {
    if (chunk.error) {
      console.warn('[tts] chunk error:', chunk.error);
      finishCurrentTtsFetch();
      return;
    }
    if (chunk.meta) {
      if (chunk.meta.format === 'mp3') activeTtsMime = 'audio/mpeg';
      return;
    }
    if (chunk.mp3Chunk) {
      activeTtsChunks.push(base64ToBytes(chunk.mp3Chunk));
    }
    if (chunk.done) {
      playCurrentTtsAccumulated();
    }
  });

  window.beeni.ttsStream(sentence).then((r) => {
    if (!r.ok) {
      console.warn('[tts] stream failed:', r.error);
      finishCurrentTtsFetch();
    }
  });
}

function playCurrentTtsAccumulated(): void {
  if (activeTtsListenerUnbind) {
    activeTtsListenerUnbind();
    activeTtsListenerUnbind = null;
  }
  isFetchingTts = false;

  if (activeTtsChunks.length === 0) {
    drainTtsQueue();
    return;
  }
  const totalLen = activeTtsChunks.reduce((a, b) => a + b.length, 0);
  const combined = new Uint8Array(totalLen);
  let off = 0;
  for (const c of activeTtsChunks) { combined.set(c, off); off += c.length; }
  const blob = new Blob([combined], { type: activeTtsMime });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  speakingAudio = audio;
  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(url);
    speakingAudio = null;
    if (ttsQueue.length > 0) {
      drainTtsQueue();
    }
  });
  audio.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    speakingAudio = null;
    drainTtsQueue();
  });
  audio.play().catch((err) => {
    console.warn('[tts] play error:', err.message);
    speakingAudio = null;
    drainTtsQueue();
  });
}

function finishCurrentTtsFetch(): void {
  if (activeTtsListenerUnbind) {
    activeTtsListenerUnbind();
    activeTtsListenerUnbind = null;
  }
  activeTtsChunks = [];
  isFetchingTts = false;
  drainTtsQueue();
}

function stopAllTts(): void {
  if (speakingAudio) {
    try { speakingAudio.pause(); } catch {}
    speakingAudio = null;
  }
  ttsQueue.length = 0;
  ttsBuffer = '';
  if (activeTtsListenerUnbind) {
    activeTtsListenerUnbind();
    activeTtsListenerUnbind = null;
  }
  activeTtsChunks = [];
  isFetchingTts = false;
}

function onTtsAllDone(): void {
  if (pttMode === 'uiohook' && pttHolding) {
    startListening();
    return;
  }
  if (pttMode === 'toggle' && pttToggleActive) {
    startListening();
    return;
  }
  setIdleHint();
}

// ── Legacy single-shot speakReply ──────────────────────────────────────
async function speakReplyLegacyMp3(text: string): Promise<void> {
  setState('SPEAKING', text);
  let chunks: Uint8Array[] = [];
  let mime = 'audio/mpeg';
  return new Promise<void>((resolve) => {
    let unbind: (() => void) | null = null;
    unbind = window.beeni.onTtsChunk((chunk) => {
      if (chunk.error) {
        setError(`tts: ${chunk.error}`);
        if (unbind) unbind();
        resolve();
        return;
      }
      if (chunk.meta) {
        if (chunk.meta.format === 'mp3') mime = 'audio/mpeg';
        return;
      }
      if (chunk.mp3Chunk) chunks.push(base64ToBytes(chunk.mp3Chunk));
      if (chunk.done) {
        if (unbind) { unbind(); unbind = null; }
        if (chunks.length === 0) { resolve(); return; }
        const totalLen = chunks.reduce((a, b) => a + b.length, 0);
        const combined = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) { combined.set(c, off); off += c.length; }
        const blob = new Blob([combined], { type: mime });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        speakingAudio = audio;
        audio.addEventListener('ended', () => {
          URL.revokeObjectURL(url);
          speakingAudio = null;
          resolve();
        });
        audio.addEventListener('error', () => {
          URL.revokeObjectURL(url);
          speakingAudio = null;
          resolve();
        });
        audio.play().catch(() => resolve());
      }
    });
    window.beeni.ttsStream(text).then((r) => {
      if (!r.ok) {
        if (unbind) unbind();
        setError(`tts: ${r.error || 'failed'}`);
        resolve();
      }
    });
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Push-to-talk handlers ───────────────────────────────────────────────
async function handlePttStart(): Promise<void> {
  pttHolding = true;
  if (state === 'SPEAKING') {
    sendConv({ type: 'interrupt' });
    stopAllTts();
  }
  // In recording mode, PTT means "I want to say something with priority" —
  // recording is still going; user-final will get routed to summary trigger
  // or normal turn (server's heuristic).
  await startListening();
}

async function handlePttStop(): Promise<void> {
  pttHolding = false;
  // 2026-05-24 fix: 火山 STT 不发 partial, 只发 final on EOS. State stays
  // LISTENING (no partial = no HEARING transition) but we MUST still send EOS,
  // wait for final, then forward to conversation WS. Old code dropped the
  // utterance entirely on LISTENING release.
  if (state === 'HEARING' || state === 'LISTENING') {
    if (appMode === 'recording' && state === 'LISTENING') {
      return; // recording keeps mic open
    }
    await pttFinalizeWithWait();
  }
}

async function pttFinalizeWithWait(): Promise<void> {
  // 2026-05-24 critical fix series — the previous version had THREE bugs:
  //  (a) it broke out of the wait loop the moment ANY currentTranscript
  //      appeared (typically a mid-utterance partial like "建一"), so the
  //      truncated partial got sent as the user's turn instead of the full
  //      final. → wait specifically for `gotSttFinal`.
  //  (b) it called closeSttSocket() BEFORE waiting for final, which
  //      forcibly closed the upstream WS (and double-sent EOS) → the real
  //      final never made it back. → close AFTER we have final / timed out.
  //  (c) the silence-timer path's finalizeUtterance() could race with this
  //      function on long PTT presses. → guard with pttFinalizeInFlight.
  pttFinalizeInFlight = true;
  // Stop the silence timer — its finalizeUtterance() path would double-fire.
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  // 1. Send EOS to STT so volc closes upstream + returns final.
  sendSttEos();
  setState('THINKING', '…想一下');

  // 2. Stop mic capture immediately on release (no more PCM to feed). We do
  //    NOT close the STT WS yet — we need it open to receive the final.
  stopMic();

  // 3. Wait up to 5s for `final` to land (sets gotSttFinal). 火山 typically
  //    returns final within 300-1500ms after EOS for a few-second utterance;
  //    5s is a generous buffer for network hiccups.
  const start = Date.now();
  const FINAL_TIMEOUT_MS = 5000;
  while (Date.now() - start < FINAL_TIMEOUT_MS) {
    if (gotSttFinal) break;
    await new Promise<void>((r) => window.setTimeout(r, 25));
  }

  // 4. NOW tear down STT (sets sttCloseRequested → late messages ignored).
  const waitedMs = Date.now() - start;
  if (!gotSttFinal) {
    console.warn(`[ptt] no STT final after ${waitedMs}ms — falling back to last partial (may be truncated)`);
  } else {
    console.log(`[ptt] STT final received after ${waitedMs}ms`);
  }
  closeSttSocket();

  // 5. If we got text, forward to conversation.
  const text = currentTranscript.trim();
  currentTranscript = '';
  pttFinalizeInFlight = false;
  if (!text) {
    console.warn('[ptt] STT returned empty — nothing to send');
    setIdleHint();
    return;
  }
  console.log('[ptt] forwarding to conv:', text);
  if (convWsReady) {
    const ok = sendConv({ type: 'user-final', text });
    if (!ok) {
      console.warn('[ptt] sendConv failed despite convWsReady=true');
      setError('对话未连上');
    }
    return;
  }
  if (convFallbackActive) {
    // Single-shot IPC fallback path (no multi-turn context)
    try {
      const r = await window.beeni.agentRun(text);
      if (r.ok && r.finalText) {
        await speakReplyLegacyMp3(r.finalText);
      }
      setIdleHint();
    } catch (e) {
      console.warn('[ptt] fallback agentRun failed', e);
      setError('对话未连上');
    }
    return;
  }
  console.warn('[ptt] conv WS not ready and no fallback — text lost:', text);
  setIdleHint();
}

async function handlePttToggle(): Promise<void> {
  if (state === 'IDLE' || state === 'ERROR') {
    pttToggleActive = true;
    await startListening();
  } else if (state === 'HEARING' || state === 'LISTENING') {
    pttToggleActive = false;
    await handlePttStop();
  } else if (state === 'SPEAKING') {
    pttToggleActive = true;
    sendConv({ type: 'interrupt' });
    stopAllTts();
    await startListening();
  }
}

// ── App mode toggle (PTT ↔ recording) ───────────────────────────────────
function setAppMode(next: AppMode, sendToServer: boolean): void {
  if (appMode === next) return;
  appMode = next;
  if (shellEl) shellEl.dataset.mode = next;
  if (modeToggleEl) {
    modeToggleEl.textContent = next === 'recording' ? '●' : '⌃';
    modeToggleEl.title = next === 'recording'
      ? '当前: 录音模式 (点切换为按住说话)'
      : '当前: 按住说话 (点切换为录音)';
  }
  try { localStorage.setItem(LS_KEY_MODE, next); } catch {}
  try { window.beeni.setPillRecording(next === 'recording'); } catch {}

  if (next === 'recording') {
    // Auto-start mic on switch.
    if (sendToServer) sendConv({ type: 'mode-set', mode: 'recording' });
    void startListening();
    setBindStatus('已切换录音模式 — 我会每 90 秒尝试总结白板', 'ok');
  } else {
    if (sendToServer) sendConv({ type: 'mode-set', mode: 'ptt' });
    // Stop mic if it's running.
    stopMic();
    closeSttSocket();
    setIdleHint();
    setBindStatus('已切换按住说话模式', 'ok');
  }
}

async function handleModeToggleClick(): Promise<void> {
  const next: AppMode = appMode === 'recording' ? 'ptt' : 'recording';
  if (next === 'recording') {
    if (!boundTarget) {
      setBindStatus('请先绑定 🎯 目标文档 (录音总结要写到白板)', 'err');
      return;
    }
    if (!boundTarget.whiteboardToken) {
      setBindStatus('目标文档没绑白板 — 白板总结无法 push', 'err');
      // Still let them turn it on — they may want to test STT capture.
    }
  }
  setAppMode(next, true);
}

// ── Bindings UI ─────────────────────────────────────────────────────────
function parseFeishuDocUrl(
  raw: string,
): { docToken: string; whiteboardToken: string | null } | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9]{18,32}$/.test(s)) {
    return { docToken: s, whiteboardToken: null };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/(?:docx|docs|wiki)\/([A-Za-z0-9]{6,})/);
  if (!m) return null;
  const docToken = m[1];
  const wb =
    u.searchParams.get('bid') ||
    u.searchParams.get('whiteboard_id') ||
    u.searchParams.get('wb') ||
    null;
  return { docToken, whiteboardToken: wb };
}

function setBindStatus(text: string, kind: '' | 'ok' | 'err' = ''): void {
  if (!bindStatusEl) return;
  bindStatusEl.textContent = text;
  if (kind) bindStatusEl.dataset.kind = kind;
  else bindStatusEl.removeAttribute('data-kind');
}

function updateBoundFlag(): void {
  if (!shellEl) return;
  shellEl.dataset.bound = boundTarget ? 'true' : 'false';
}

function renderBoundChips(): void {
  if (!boundChipsEl) return;
  boundChipsEl.innerHTML = '';
  if (boundTarget) {
    const chip = document.createElement('span');
    chip.className = 'bound-chip bound-chip--target';
    const label = document.createElement('span');
    label.textContent = `🎯 ${boundTarget.docToken.slice(0, 8)}…`;
    chip.appendChild(label);
    const rm = document.createElement('button');
    rm.className = 'bound-chip__remove';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = '清除目标';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      sendConv({ type: 'bind-target', docToken: '' });
    });
    chip.appendChild(rm);
    boundChipsEl.appendChild(chip);
  }
  for (const ref of boundReferences) {
    const chip = document.createElement('span');
    chip.className = 'bound-chip';
    const label = document.createElement('span');
    label.textContent = `📄 ${ref.docToken.slice(0, 8)}…`;
    chip.appendChild(label);
    const rm = document.createElement('button');
    rm.className = 'bound-chip__remove';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = '移除参考';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      sendConv({ type: 'bind-reference-remove', docToken: ref.docToken });
    });
    chip.appendChild(rm);
    boundChipsEl.appendChild(chip);
  }
}

function renderRecordingStatus(): void {
  if (!recordingStatusTextEl) return;
  const s = recordingStatusState;
  const mins = Math.floor(s.listeningMs / 60000);
  const secs = Math.floor((s.listeningMs % 60000) / 1000);
  const durStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
  const lastSummary = s.lastSummaryAt > 0
    ? ` · 上次总结 ${Math.max(0, Math.floor((Date.now() - s.lastSummaryAt) / 1000))}秒前`
    : ' · 还没总结';
  const pending = s.pendingSummary ? ' · 总结中…' : '';
  recordingStatusTextEl.textContent =
    `🎙 已听 ${durStr} · 缓 ${s.bufferChunks} 段${lastSummary}${pending}`;
}

function setBindPanelOpen(open: boolean): void {
  if (!shellEl) return;
  shellEl.dataset.bindOpen = open ? 'true' : 'false';
  try {
    window.beeni.setPillExpanded(open);
  } catch {}
  if (open && targetInputEl) {
    setTimeout(() => targetInputEl.focus(), 50);
  }
}

function submitTarget(): void {
  if (!targetInputEl) return;
  const raw = targetInputEl.value.trim();
  if (!raw) {
    setBindStatus('请粘贴目标文档 URL', 'err');
    return;
  }
  const parsed = parseFeishuDocUrl(raw);
  if (!parsed) {
    setBindStatus('解析失败 — 不是飞书文档 URL', 'err');
    return;
  }
  setBindStatus('设置目标中…', '');
  const ok = sendConv({
    type: 'bind-target',
    docToken: parsed.docToken,
    whiteboardToken: parsed.whiteboardToken,
  });
  if (!ok) {
    setBindStatus('未连接服务器', 'err');
  } else {
    targetInputEl.value = '';
  }
}

function submitReference(): void {
  if (!referenceInputEl) return;
  const raw = referenceInputEl.value.trim();
  if (!raw) {
    setBindStatus('请粘贴参考文档 URL', 'err');
    return;
  }
  const parsed = parseFeishuDocUrl(raw);
  if (!parsed) {
    setBindStatus('解析失败', 'err');
    return;
  }
  setBindStatus('添加参考中…', '');
  const ok = sendConv({
    type: 'bind-reference-add',
    docToken: parsed.docToken,
    whiteboardToken: parsed.whiteboardToken,
  });
  if (!ok) {
    setBindStatus('未连接服务器', 'err');
  } else {
    referenceInputEl.value = '';
  }
}

function clearAllBindings(): void {
  sendConv({ type: 'bind-clear' });
  setBindStatus('已清空所有绑定', 'ok');
}

// ── LocalStorage persistence ────────────────────────────────────────────
function persistBindings(): void {
  try {
    const payload = JSON.stringify({
      target: boundTarget,
      references: boundReferences,
    });
    localStorage.setItem(LS_KEY_BINDINGS, payload);
  } catch {}
}

function loadPersistedBindings(): void {
  try {
    const raw = localStorage.getItem(LS_KEY_BINDINGS);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.target && parsed.target.docToken) {
      boundTarget = parsed.target;
    }
    if (Array.isArray(parsed.references)) {
      boundReferences = parsed.references.filter(
        (r: any) => r && r.docToken,
      );
    }
  } catch {}
}

function loadPersistedMode(): void {
  try {
    const raw = localStorage.getItem(LS_KEY_MODE);
    if (raw === 'recording' || raw === 'ptt') {
      appMode = raw;
      if (shellEl) shellEl.dataset.mode = raw;
      if (modeToggleEl) {
        modeToggleEl.textContent = raw === 'recording' ? '●' : '⌃';
      }
      try { window.beeni.setPillRecording(raw === 'recording'); } catch {}
    }
  } catch {}
}

/**
 * After WS connect, send the persisted bindings back to the server so it's
 * in sync. Server is fresh per WS connect (no persistence on server side).
 */
function restoreBindingsToServer(): void {
  if (boundTarget) {
    sendConv({
      type: 'bind-target',
      docToken: boundTarget.docToken,
      whiteboardToken: boundTarget.whiteboardToken,
      title: boundTarget.title,
    });
  }
  for (const ref of boundReferences) {
    sendConv({
      type: 'bind-reference-add',
      docToken: ref.docToken,
      whiteboardToken: ref.whiteboardToken,
      title: ref.title,
    });
  }
}

// ── Event wiring ────────────────────────────────────────────────────────
if (bindToggleEl) {
  bindToggleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = shellEl?.dataset.bindOpen !== 'true';
    setBindPanelOpen(open);
  });
}
if (modeToggleEl) {
  modeToggleEl.addEventListener('click', (e) => {
    e.stopPropagation();
    void handleModeToggleClick();
  });
}
if (targetBtnEl) {
  targetBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    submitTarget();
  });
}
if (referenceAddBtnEl) {
  referenceAddBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    submitReference();
  });
}
if (bindClearAllBtnEl) {
  bindClearAllBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    clearAllBindings();
  });
}
if (targetInputEl) {
  targetInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submitTarget();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setBindPanelOpen(false);
    }
  });
  targetInputEl.addEventListener('click', (e) => e.stopPropagation());
}
if (referenceInputEl) {
  referenceInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submitReference();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setBindPanelOpen(false);
    }
  });
  referenceInputEl.addEventListener('click', (e) => e.stopPropagation());
}

pillEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('#bindToggle') || target.closest('#modeToggle')) return;
  handlePttToggle();
});

pillEl.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pillEl.click();
  }
});

window.beeni.onStartListening(() => {
  handlePttStart();
});

window.beeni.onPttStart(() => {
  handlePttStart();
});

window.beeni.onPttStop(() => {
  handlePttStop();
});

window.beeni.onPttToggle(() => {
  handlePttToggle();
});

// Resolve PTT mode from main process so we can set the right idle hint text.
window.beeni.getPttMode().then((mode) => {
  pttMode = mode;
  if (state === 'IDLE') setIdleHint();
}).catch(() => {
  pttMode = 'none';
});

// Load persisted state first, then open WS (which restores bindings to server).
loadPersistedBindings();
loadPersistedMode();
renderBoundChips();
updateBoundFlag();

openConversationSocket().catch((err) => {
  console.warn('[conv] pre-warm failed:', (err as Error).message);
});

setIdleHint();

// Periodic UI tick to keep "已听 N 秒" fresh between server pushes.
setInterval(() => {
  if (appMode === 'recording') {
    if (recordingStatusState.listening) {
      recordingStatusState.listeningMs += 1000;
    }
    renderRecordingStatus();
    if (state === 'IDLE') setText(idleHintText());
  }
}, 1000);

// ── DEBUG hooks (Playwright e2e harness) ────────────────────────────────
// Exposed unconditionally on window so the Playwright/Electron test harness
// can drive the state machine without the OS keyboard hook / real mic.
// In production usage these are dormant — nothing touches them.
//
// Usage from Playwright `page.evaluate`:
//   await window.beeniDebug.waitForConvReady(15000);
//   await window.beeniDebug.sendUserFinalDirect("建一个画板"); // bypass STT
//   const events = await window.beeniDebug.collectConvEvents(60000, "turn-done");
//
// Or to exercise the FULL mic+ptt path with injected PCM:
//   await window.beeniDebug.pttStart();
//   window.beeniDebug.injectPcm(int16Array);
//   await window.beeniDebug.pttStop();
//
// Notes:
//   - sendUserFinalDirect skips STT entirely (proves agent loop + tools work).
//   - injectPcm requires pttStart() to have already opened the mic+STT pipeline.
//     Injected samples are pushed through the same downsample / sendPcmChunk
//     path as real mic chunks (so STT WS receives them like real audio).
(window as any).beeniDebug = {
  // === Direct state-machine drivers (bypass keyboard / mic / STT) ===
  pttStart: async (): Promise<void> => {
    console.log('[debug] pttStart()');
    await handlePttStart();
  },
  pttStop: async (): Promise<void> => {
    console.log('[debug] pttStop()');
    await handlePttStop();
  },
  pttToggle: async (): Promise<void> => {
    console.log('[debug] pttToggle()');
    await handlePttToggle();
  },
  /**
   * Force-feed an STT final without touching the WS. Drives the same code
   * path finalizeUtterance() would (sets currentTranscript + gotSttFinal +
   * fires user-final via convWs).
   */
  forceSttFinal: async (text: string): Promise<void> => {
    console.log('[debug] forceSttFinal:', text);
    currentTranscript = text;
    gotSttFinal = true;
    // If we're currently in a PTT release wait loop, that will pick it up.
    // Otherwise fire finalizeUtterance directly.
    if (!pttFinalizeInFlight && state !== 'IDLE' && state !== 'ERROR') {
      await finalizeUtterance();
    }
  },
  /**
   * Bypass the whole STT layer and inject a user-final straight into the
   * conversation WS. This is the FAST path for verifying "say 建一个画板 →
   * server creates飞书画板". Doesn't validate mic / STT / WebSocket framing
   * but DOES exercise renderer state machine + agent loop + tool exec +
   * lark-cli spawn end-to-end.
   */
  sendUserFinalDirect: async (text: string): Promise<boolean> => {
    console.log('[debug] sendUserFinalDirect:', text);
    // Ensure conv WS is open.
    if (!convWsReady) {
      await openConversationSocket();
    }
    if (!convWsReady) {
      console.warn('[debug] conv WS still not ready — cannot send');
      return false;
    }
    setState('THINKING', '在想…');
    const ok = sendConv({ type: 'user-final', text });
    if (!ok) {
      console.warn('[debug] sendConv returned false');
    }
    return ok;
  },
  /**
   * Push a fake PCM chunk through the same path as real mic audio. Triggers
   * the ScriptProcessor onaudioprocess pipeline indirectly: we encode the
   * Int16 buffer and shove it through sendPcmChunk so STT WS sees it.
   * Requires pttStart() to have brought up mic + STT first.
   */
  injectPcm: (samples: number[] | Int16Array): boolean => {
    const arr = samples instanceof Int16Array ? samples : new Int16Array(samples);
    sendPcmChunk(arr);
    return true;
  },
  /** Wait until the conversation WS has fired its 'ready' message. */
  waitForConvReady: (timeoutMs: number = 15000): Promise<boolean> => {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (convWsReady) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  },
  /**
   * Capture all conv WS messages from now until either `untilType` is seen
   * or `timeoutMs` elapses. Returns the parsed array of messages.
   * Uses a piggyback handler installed temporarily.
   */
  collectConvEvents: (timeoutMs: number, untilType?: string): Promise<any[]> => {
    return new Promise((resolve) => {
      const events: any[] = [];
      if (!convWs) {
        resolve(events);
        return;
      }
      const ws = convWs;
      const handler = (evt: MessageEvent) => {
        if (typeof evt.data !== 'string') return;
        let m: any;
        try { m = JSON.parse(evt.data); } catch { return; }
        events.push(m);
        if (untilType && m.type === untilType) {
          cleanup();
          resolve(events);
        }
      };
      const cleanup = () => {
        try { ws.removeEventListener('message', handler); } catch {}
      };
      ws.addEventListener('message', handler);
      setTimeout(() => {
        cleanup();
        resolve(events);
      }, timeoutMs);
    });
  },
  /** Snapshot the current state machine — for assertions. */
  getState: (): { state: string; convWsReady: boolean; pttMode: string; boundTarget: any } => ({
    state,
    convWsReady,
    pttMode,
    boundTarget,
  }),
};
console.log('[debug] window.beeniDebug installed');
