/**
 * server.ts — Express + WS host for lark-voice-doc.
 *
 * Endpoints:
 *   POST /api/tts          — body {text, voice?, format?} → mp3 base64 (火山 TTS)
 *   POST /api/tts-stream   — SSE stream of mp3/pcm chunks (火山 big-model TTS)
 *   WS   /api/stt          — browser PCM → 火山 ASR partial/final transcripts
 *   POST /api/lark/create-doc            — body {title, markdown} → {docToken}
 *   POST /api/lark/update-doc            — body {docToken, markdown} → ok
 *   POST /api/lark/update-whiteboard     — body {whiteboardToken, mermaid} → ok
 *   POST /api/lark/fetch-doc             — body {docToken} → {markdown}
 *   POST /api/agent/run                  — body {prompt, model?} → tool-loop result
 *   GET  /api/health                     — { ok: true }
 *
 * Port: process.env.PORT or 3001.
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { synthesizeVolc, synthesizeVolcStream, prewarmVolcTts } from './lib/volc-tts';
import { handleVolcStt } from './lib/volc-stt';
import {
  larkCreateDoc,
  larkUpdateDoc,
  larkUpdateWhiteboard,
  larkFetchDoc,
  larkAuthStatus,
} from './lib/lark';
import { runAgent, ConversationSession, RecordingSession } from './lib/agent-loop';
import { getSetupStatus, saveEnv, testArk, testVolc } from './lib/setup';
import { addContext, listContexts, removeContext, clearContexts, extractFile, getContextText } from './lib/context-store';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WebSocket as WSConn } from 'ws';

const PORT = Number(process.env.PORT || 3001);

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, port: PORT, time: new Date().toISOString() });
});

// ── First-run setup wizard ───────────────────────────────────────────────────
// Serves a local page where a fresh clone fills in their OWN API keys (no keys
// ship in this repo). Status reports presence only — never the values.
app.get('/setup', async (_req, res) => {
  try {
    const html = await readFile(path.join(process.cwd(), 'public', 'setup.html'), 'utf-8');
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(`setup page missing: ${(err as Error).message}`);
  }
});

app.get('/api/setup/status', (_req, res) => {
  res.json(getSetupStatus());
});

app.post('/api/setup/save', async (req, res) => {
  try {
    await saveEnv(req.body || {});
    res.json({ ok: true, status: getSetupStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/setup/test', async (req, res) => {
  const { service, ARK_API_KEY, VOLC_APP_ID, VOLC_ACCESS_TOKEN } = req.body || {};
  try {
    if (service === 'ark') return res.json(await testArk(ARK_API_KEY ?? process.env.ARK_API_KEY ?? ''));
    if (service === 'volc')
      return res.json(
        await testVolc(VOLC_APP_ID ?? process.env.VOLC_APP_ID ?? '', VOLC_ACCESS_TOKEN ?? process.env.VOLC_ACCESS_TOKEN ?? ''),
      );
    return res.status(400).json({ ok: false, detail: 'service must be ark | volc' });
  } catch (err) {
    res.status(500).json({ ok: false, detail: (err as Error).message });
  }
});

// ── Background material import (paste text / upload docs) ─────────────────────
// The user loads background (an AI chat export, a spec, notes) in the 背景资料
// window; the conversation agent injects it so Beeni discusses with it in mind.
app.get('/context', async (_req, res) => {
  try {
    const html = await readFile(path.join(process.cwd(), 'public', 'context.html'), 'utf-8');
    res.type('html').send(html);
  } catch (err) {
    res.status(500).send(`context page missing: ${(err as Error).message}`);
  }
});

app.get('/api/context/list', (_req, res) => {
  res.json({ items: listContexts() });
});

app.post('/api/context/add', (req, res) => {
  try {
    const { label, text, source } = req.body || {};
    const item = addContext(label, text, source === 'file' ? 'file' : 'paste');
    res.json({ ok: true, item, items: listContexts() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/context/remove', (req, res) => {
  removeContext(String((req.body || {}).id || ''));
  res.json({ ok: true, items: listContexts() });
});

app.post('/api/context/clear', (_req, res) => {
  clearContexts();
  res.json({ ok: true, items: [] });
});

// Raw file upload → extracted text (the page then POSTs it to /add).
app.post('/api/context/extract', express.raw({ type: '*/*', limit: '40mb' }), async (req, res) => {
  try {
    const filename = String((req.query.filename as string) || 'file.txt');
    const buf = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from([]);
    if (buf.length === 0) return res.status(400).json({ ok: false, error: '空文件' });
    const text = await extractFile(filename, buf);
    res.json({ ok: true, filename, text, chars: text.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: `解析失败：${(err as Error).message}` });
  }
});

// ── TTS ────────────────────────────────────────────────────────────────────
app.post('/api/tts', async (req: Request, res: Response) => {
  const { text, voice, format } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required (string)' });
  }
  const fmt: 'pcm' | 'mp3' = format === 'pcm' ? 'pcm' : 'mp3';
  try {
    const { audio, durationMs, latencyMs } = await synthesizeVolc({
      text,
      voice,
      format: fmt,
    });
    const audioBase64 = audio.toString('base64');
    return res.json({
      ok: true,
      format: fmt, // the ACTUAL synthesized format
      audioBase64,
      // back-compat: only populate mp3Base64 when the bytes are really mp3
      mp3Base64: fmt === 'mp3' ? audioBase64 : undefined,
      durationMs,
      latencyMs,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/tts-stream', async (req: Request, res: Response) => {
  const {
    text,
    voice, // 火山 speaker id; undefined → module default (zh_female_vv_uranus_bigtts)
    speed, // undefined → module default (steady 0.95)
    emotion, // undefined → module default ('professional')
    format: requestedFormat,
  } = req.body || {};

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required (string)' });
  }

  // Default to mp3 — the renderer accumulates mp3 chunks and plays them as one
  // audio/mpeg blob. pcm is opt-in for callers that decode raw PCM16 themselves.
  const format: 'pcm' | 'mp3' = requestedFormat === 'pcm' ? 'pcm' : 'mp3';
  const sampleRate = 24000; // 火山 seed-tts output rate

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    (res as any).flushHeaders?.();
  } catch {}

  res.write(
    `data: ${JSON.stringify({ meta: { format, sampleRate, channels: 1 } })}\n\n`,
  );

  const t0 = Date.now();
  let chunkCount = 0;
  let firstChunkMs = -1;
  let extraInfo: any = null;
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });

  try {
    const stream = synthesizeVolcStream({
      text,
      voice,
      speed,
      emotion,
      format,
      sampleRate,
      onFirstChunk: (ms) => {
        firstChunkMs = ms;
      },
      onMeta: (m) => {
        extraInfo = m;
      },
    });
    for await (const buf of stream) {
      if (aborted) break;
      chunkCount++;
      const b64 = buf.toString('base64');
      const payload =
        format === 'pcm'
          ? JSON.stringify({ pcmChunk: b64, sampleRate })
          : JSON.stringify({ mp3Chunk: b64 });
      res.write(`data: ${payload}\n\n`);
    }
    if (!aborted) {
      const totalMs = Date.now() - t0;
      res.write(
        `data: ${JSON.stringify({
          done: true,
          format,
          sampleRate,
          chunks: chunkCount,
          firstChunkMs,
          totalMs,
          extra: extraInfo,
        })}\n\n`,
      );
      res.end();
    }
  } catch (err) {
    const msg = (err as Error).message;
    try {
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
    } catch {}
  }
});

// ── lark wrappers ──────────────────────────────────────────────────────────
app.post('/api/lark/create-doc', async (req, res) => {
  const { title, markdown } = req.body || {};
  if (!title || !markdown) return res.status(400).json({ error: 'title + markdown required' });
  try {
    const out = await larkCreateDoc(title, markdown);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/lark/update-doc', async (req, res) => {
  const { docToken, markdown } = req.body || {};
  if (!docToken || !markdown) return res.status(400).json({ error: 'docToken + markdown required' });
  try {
    await larkUpdateDoc(docToken, markdown);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/lark/update-whiteboard', async (req, res) => {
  const { whiteboardToken, mermaid } = req.body || {};
  if (!whiteboardToken || !mermaid) {
    return res.status(400).json({ error: 'whiteboardToken + mermaid required' });
  }
  try {
    await larkUpdateWhiteboard(whiteboardToken, mermaid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.post('/api/lark/fetch-doc', async (req, res) => {
  const { docToken } = req.body || {};
  if (!docToken) return res.status(400).json({ error: 'docToken required' });
  try {
    const markdown = await larkFetchDoc(docToken);
    res.json({ ok: true, markdown });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/lark/auth-status', async (_req, res) => {
  try {
    const out = await larkAuthStatus();
    res.json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── agent loop ─────────────────────────────────────────────────────────────
app.post('/api/agent/run', async (req, res) => {
  const { prompt, model, systemPrompt, maxRounds } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt required (string)' });
  }
  try {
    const result = await runAgent({ prompt, model, systemPrompt, maxRounds });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── HTTP server + WS upgrade for STT + conversation ───────────────────────
const server = http.createServer(app);
const wssStt = new WebSocketServer({ noServer: true });
const wssConv = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname === '/api/stt') {
    console.log('[server] /api/stt WS upgrade');
    wssStt.handleUpgrade(req, socket, head, (clientWs) => {
      handleVolcStt(clientWs).catch((err) =>
        console.error('[server] STT handler error:', (err as Error).message),
      );
    });
    return;
  }
  if (url.pathname === '/api/conversation') {
    console.log('[server] /api/conversation WS upgrade');
    wssConv.handleUpgrade(req, socket, head, (clientWs) => {
      handleConversation(clientWs as unknown as WSConn).catch((err) =>
        console.error('[server] conversation handler error:', (err as Error).message),
      );
    });
    return;
  }
  socket.destroy();
});

/**
 * /api/conversation — stateful multi-turn voice conversation + recording mode.
 *
 * Client → server messages (JSON):
 *   { type: 'user-final', text: string }                            // submit a user turn (PTT)
 *   { type: 'interrupt' }                                           // abort current turn
 *   { type: 'reset' }                                               // wipe history
 *   // multi-doc binding (Phase 4):
 *   { type: 'bind-target', docToken, whiteboardToken?, title? }     // set THE target doc
 *   { type: 'bind-reference-add', docToken, whiteboardToken?, title? }
 *   { type: 'bind-reference-remove', docToken }
 *   { type: 'bind-clear' }                                          // clear all bindings
 *   // legacy bind-doc (kept for back-compat — same as bind-target)
 *   { type: 'bind-doc', docToken, whiteboardToken? }
 *   // recording mode (Phase 4):
 *   { type: 'mode-set', mode: 'recording' | 'ptt' }
 *   { type: 'recording-transcript', ts: number, text: string }      // VAD chunk from client
 *   { type: 'recording-trigger-summary', userPrompt? }              // user-initiated summary
 *   { type: 'ping' }
 *
 * Server → client messages (JSON):
 *   { type: 'ready' }
 *   { type: 'turn-start', turn }
 *   { type: 'assistant-text', token }
 *   { type: 'tool-call', name, args }
 *   { type: 'tool-result', name, ok, summary }
 *   { type: 'open-url', url }
 *   { type: 'bind-state', target, references }                      // full binding state after any change
 *   { type: 'bind-doc-ok', docToken, whiteboardToken }              // legacy
 *   { type: 'turn-done', text, toolsUsed, aborted }
 *   { type: 'mode-ok', mode }
 *   { type: 'recording-status', listening, listeningMs, lastSummaryAt, bufferChunks, bufferChars, pendingSummary }
 *   { type: 'summary-pushed', whiteboardToken, changeNote, modelUsed, latencyMs, mermaid }
 *   { type: 'summary-skipped', reason, modelUsed }
 *   { type: 'summary-error', error }
 *   { type: 'error', error }
 *   { type: 'pong' }
 */
async function handleConversation(ws: WSConn): Promise<void> {
  const session = new ConversationSession();
  let mode: 'ptt' | 'recording' = 'ptt';
  let alive = true;

  const send = (obj: any) => {
    if (!alive) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      console.error('[conversation] send error:', (err as Error).message);
    }
  };

  // Recording session — instantiated lazily on first mode-set 'recording'.
  let recording: RecordingSession | null = null;
  const ensureRecording = (): RecordingSession => {
    if (recording) return recording;
    recording = new RecordingSession({
      onSummaryPushed: (evt) => {
        send({
          type: 'summary-pushed',
          whiteboardToken: evt.whiteboardToken,
          changeNote: evt.changeNote,
          modelUsed: evt.modelUsed,
          latencyMs: evt.latencyMs,
          mermaid: evt.mermaid,
        });
      },
      onSummarySkipped: (reason, modelUsed) => {
        send({ type: 'summary-skipped', reason, modelUsed });
      },
      onSummaryError: (err) => {
        send({ type: 'summary-error', error: err.message });
      },
      onStatus: (status) => {
        send({ type: 'recording-status', ...status });
      },
      // Dry-run mode (WHITEBOARD_PUSH_DRYRUN=1): skip the real 飞书 CLI push so
      // the full pipeline can be exercised without 飞书 OAuth (used by the
      // realtime harness, and handy for a no-board demo). When unset, the
      // RecordingSession falls back to the real larkUpdateWhiteboard.
      pushWhiteboard: process.env.WHITEBOARD_PUSH_DRYRUN
        ? async (wbToken: string, mermaid: string) => {
            console.log(`[dryrun] whiteboard push skipped — ${mermaid.length} chars → ${wbToken}`);
          }
        : undefined,
    });
    return recording;
  };

  // PTT live board: ensure a scribe exists and is pointed at the bound board,
  // WITHOUT entering recording mode (no mic-silence, no start()). The debounce
  // inside addTranscript drives the redraws. No-op effect if no board is bound.
  const ensureBoardScribe = (): RecordingSession => {
    const rec = ensureRecording();
    rec.setTarget(session.boundTarget);
    return rec;
  };

  // Push the current binding state to the client (keeps UI honest).
  const sendBindState = () => {
    send({
      type: 'bind-state',
      target: session.boundTarget,
      references: session.boundReferences,
    });
  };

  ws.on('close', () => {
    alive = false;
    session.interrupt();
    if (recording) recording.dispose(); // cancel armed redraws; block future ones
    console.log(
      '[conversation] WS closed, session discarded (turns=' + session.turnCount + ')',
    );
  });
  ws.on('error', (err) => {
    console.error('[conversation] WS error:', (err as Error).message);
  });

  send({ type: 'ready' });

  ws.on('message', async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send({ type: 'error', error: 'invalid JSON' });
      return;
    }

    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }

    if (msg.type === 'interrupt') {
      session.interrupt();
      return;
    }

    if (msg.type === 'reset') {
      session.reset();
      if (recording) recording.stop();
      send({ type: 'ready' });
      sendBindState();
      return;
    }

    // ── multi-doc binding (Phase 4) ────────────────────────────────────
    if (msg.type === 'bind-target' || msg.type === 'bind-doc') {
      const docToken = String(msg.docToken || '').trim();
      const wbToken =
        typeof msg.whiteboardToken === 'string' ? msg.whiteboardToken.trim() : '';
      const title = typeof msg.title === 'string' ? msg.title.trim() : '';
      if (!docToken) {
        // empty → clear
        session.setBoundTarget(null);
        if (recording) recording.setTarget(null);
        sendBindState();
        return;
      }
      try {
        session.setBoundTarget({
          docToken,
          whiteboardToken: wbToken || null,
          title: title || null,
        });
        if (recording) {
          recording.setTarget(session.boundTarget);
        }
        // Back-compat: legacy clients still expect bind-doc-ok.
        send({
          type: 'bind-doc-ok',
          docToken,
          whiteboardToken: wbToken || null,
        });
        sendBindState();
      } catch (err) {
        send({ type: 'error', error: (err as Error).message });
      }
      return;
    }

    if (msg.type === 'bind-reference-add') {
      const docToken = String(msg.docToken || '').trim();
      const wbToken =
        typeof msg.whiteboardToken === 'string' ? msg.whiteboardToken.trim() : '';
      const title = typeof msg.title === 'string' ? msg.title.trim() : '';
      if (!docToken) {
        send({ type: 'error', error: 'bind-reference-add missing docToken' });
        return;
      }
      session.addBoundReference({
        docToken,
        whiteboardToken: wbToken || null,
        title: title || null,
      });
      sendBindState();
      return;
    }

    if (msg.type === 'bind-reference-remove') {
      const docToken = String(msg.docToken || '').trim();
      if (!docToken) {
        send({ type: 'error', error: 'bind-reference-remove missing docToken' });
        return;
      }
      session.removeBoundReference(docToken);
      sendBindState();
      return;
    }

    if (msg.type === 'bind-clear') {
      session.setBoundTarget(null);
      // Reset references too.
      for (const r of [...session.boundReferences]) {
        session.removeBoundReference(r.docToken);
      }
      if (recording) recording.setTarget(null);
      sendBindState();
      return;
    }

    // ── recording mode (Phase 4) ────────────────────────────────────────
    if (msg.type === 'mode-set') {
      const requested = msg.mode === 'recording' ? 'recording' : 'ptt';
      if (requested === mode) {
        send({ type: 'mode-ok', mode });
        return;
      }
      mode = requested;
      if (mode === 'recording') {
        const rec = ensureRecording();
        rec.setTarget(session.boundTarget);
        rec.start();
      } else {
        if (recording) recording.stop();
      }
      send({ type: 'mode-ok', mode });
      return;
    }

    if (msg.type === 'recording-transcript') {
      if (!recording || !recording.isListening()) {
        // Quiet drop — client may not have set mode yet.
        return;
      }
      const ts = typeof msg.ts === 'number' ? msg.ts : Date.now();
      const text = String(msg.text || '').trim();
      if (text) recording.addTranscript(ts, text);
      return;
    }

    if (msg.type === 'recording-trigger-summary') {
      if (!recording) {
        send({ type: 'summary-error', error: 'not in recording mode' });
        return;
      }
      const userPrompt =
        typeof msg.userPrompt === 'string' ? msg.userPrompt : undefined;
      // Fire-and-forget; status updates come via onStatus / onSummary*.
      recording.triggerSummary({ force: true, userPrompt }).catch((err) => {
        send({ type: 'summary-error', error: (err as Error).message });
      });
      return;
    }

    if (msg.type === 'user-final') {
      const text = String(msg.text || '').trim();
      if (!text) {
        send({ type: 'error', error: 'user-final missing text' });
        return;
      }
      if (session.isBusy) {
        // New user turn while previous still streaming — interrupt prior, then start fresh.
        session.interrupt();
        // small yield so the abort propagates
        await new Promise((r) => setTimeout(r, 20));
      }
      // If we're in recording mode and the user did a PTT, treat it as a
      // "trigger summary with hint" rather than a new chat turn — that's the
      // founder's mental model (e.g. "总结一下"). Only do this if it looks like
      // a summary request, otherwise route as a normal chat turn.
      if (mode === 'recording' && recording && looksLikeSummaryRequest(text)) {
        send({ type: 'turn-start', turn: session.turnCount + 1 });
        try {
          await recording.triggerSummary({ force: true, userPrompt: text });
          send({ type: 'turn-done', text: '(已触发白板总结)', toolsUsed: ['update_whiteboard'], aborted: false });
        } catch (err) {
          send({ type: 'error', error: (err as Error).message });
        }
        return;
      }

      // Live whiteboard scribe (part 1/2): feed the user's words NOW so the
      // board fills in WHILE Beeni thinks/replies — "someone writing as you
      // talk". The debounce coalesces this with Beeni's reply (fed below) into
      // one redraw for fast turns, or draws live-then-enriches for slow ones.
      // The proposer is incremental, so the later reply-draw adds to this one
      // rather than redrawing from scratch. No-op if no board bound.
      if (session.boundTarget?.whiteboardToken) {
        ensureBoardScribe().addTranscript(Date.now(), text);
      }

      // Keep the agent's background material current (paste/docs the user
      // imported in the 背景资料 window) before each turn.
      session.setBackground(getContextText());

      send({ type: 'turn-start', turn: session.turnCount + 1 });
      try {
        const result = await session.sendUserTurn(text, {
          onAssistantToken: (token) => send({ type: 'assistant-text', token }),
          onToolCall: (name, args) => send({ type: 'tool-call', name, args }),
          onToolResult: (name, ok, summary) => send({ type: 'tool-result', name, ok, summary }),
          onDocCreated: (_docToken, url) => send({ type: 'open-url', url }),
        });
        // If a new target doc was just auto-bound (via create_doc), inform the recording
        // session and refresh client.
        if (session.boundTarget && recording) {
          recording.setTarget(session.boundTarget);
        }
        // Live whiteboard scribe (part 2/2): feed Beeni's reply — it often
        // states the conclusions / next steps that belong on the board. The
        // proposer skips chatter and applies this as an incremental delta on top
        // of the live user-draw above.
        if (session.boundTarget?.whiteboardToken && result.text) {
          ensureBoardScribe().addTranscript(Date.now(), result.text);
        }
        sendBindState();
        send({
          type: 'turn-done',
          text: result.text,
          toolsUsed: result.toolsUsed,
          aborted: result.aborted,
        });
      } catch (err) {
        send({ type: 'error', error: (err as Error).message });
      }
      return;
    }

    send({ type: 'error', error: `unknown message type: ${msg.type}` });
  });
}

/**
 * Heuristic: in recording mode, when the user pushes Control briefly and says
 * something, did they likely mean "summarize what I just heard"?
 * - Short utterances (<25 chars) containing 总结/画/白板/记一下 keywords → yes
 * - Otherwise treat as a regular chat turn (e.g. they want Beeni to actually
 *   chat about something).
 */
function looksLikeSummaryRequest(text: string): boolean {
  if (text.length > 40) return false;
  return /总结|画(出)?|画图|白板|记一下|梳理|整理|画到|更新白板/.test(text);
}

server.listen(PORT, () => {
  console.log(`[server] lark-voice-doc listening on http://localhost:${PORT}`);
  console.log('[server] endpoints: /api/health, /api/tts, /api/tts-stream, /api/stt (WS),');
  console.log('         /api/lark/*, /api/agent/run, /api/conversation (WS)');
  // Pre-open the warm 火山 TTS connection so the FIRST spoken reply skips the
  // ~3.5-5.5s cold-connect (first audio then comes in ~1.2s).
  prewarmVolcTts();
});
