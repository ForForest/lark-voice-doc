/**
 * main.ts — Electron main process for Beegin Beeni voice pill.
 *
 * Design (Wispr Flow-style):
 *   - Single frameless, transparent, always-on-top BrowserWindow (the "pill")
 *   - ~360×50 px, bottom-center of primary display, ~80 px above the dock
 *   - Cmd+Opt+B global hotkey to start listening (also tap pill to start manually)
 *   - Menubar Tray icon as a secondary show/hide toggle
 *   - Auto-hide when IDLE for 30+ seconds (extended for multi-turn convo)
 *
 * v2 architecture (continuous conversation):
 *   - Primary turn path = renderer opens WebSocket to /api/conversation directly
 *     (no IPC), persists across turns, supports streaming tokens + interrupt.
 *   - IPC `beeni:agent-run` is retained as a FALLBACK for when the WS fails to
 *     open (renderer detects after 3s and switches paths).
 *
 * IPC bridge (renderer ↔ main):
 *   beeni.agentRun(prompt)          → POST {SERVER}/api/agent/run (FALLBACK only)
 *   beeni.ttsStream(text)           → POST {SERVER}/api/tts-stream (SSE), forwarded as 'tts-chunk' events
 *   beeni.getServer()               → returns SERVER base URL (so renderer can open /api/stt + /api/conversation WS itself)
 *   beeni.hidePill() / showPill()   → window control
 *   beeni.setIdle(isIdle: boolean)  → main schedules/cancels auto-hide
 *
 * The /api/stt and /api/conversation WS are opened directly from the renderer.
 * /api/stt carries 100ms PCM binary frames; /api/conversation carries JSON for
 * user-final / interrupt / reset (client → server) and turn-start /
 * assistant-text / tool-call / tool-result / turn-done (server → client).
 */

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  nativeImage,
  systemPreferences,
  shell,
  dialog,
} from 'electron';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, ChildProcess } from 'node:child_process';

// uIOhook-napi: cross-platform global keyboard hook (for push-to-talk on Control).
// Requires macOS Accessibility permission on first run.
// eslint-disable-next-line @typescript-eslint/no-var-requires
let uIOhook: any = null;
let UiohookKey: any = null;
let uIOhookAvailable = false;
try {
  // Dynamically require so an install/load failure doesn't crash the app —
  // we'll fall back to globalShortcut toggle in that case.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('uiohook-napi');
  uIOhook = mod.uIOhook;
  UiohookKey = mod.UiohookKey;
  uIOhookAvailable = !!uIOhook && !!UiohookKey;
} catch (err) {
  console.warn('[beeni-main] uiohook-napi unavailable:', (err as Error).message);
  uIOhookAvailable = false;
}

const SERVER_BASE = process.env.LARK_VOICE_SERVER || 'http://localhost:3001';
const PILL_WIDTH = 380;
// Phase 4: pill can grow into 3 zones — pill row + bind panel + recording status.
// Heights are upper bounds; renderer doesn't trigger growth dynamically beyond
// the 'expanded' flag, but recording-status bar also takes space when active.
const PILL_HEIGHT = 50;             // collapsed: just the pill
const PILL_HEIGHT_REC = 86;         // pill + recording-status bar
const PILL_HEIGHT_EXPANDED = 200;   // pill + bind panel (target + reference + chips + status)
const PILL_HEIGHT_FULL = 230;       // pill + bind panel + recording status
const PILL_BOTTOM_MARGIN = 80;
const IDLE_AUTO_HIDE_MS = 30000;

let pillExpandedBind = false;
let pillRecordingMode = false;

let pillWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let idleHideTimer: NodeJS.Timeout | null = null;

// Push-to-talk state. We use a "currently held" flag to dedupe key-down spam
// (uiohook fires repeat events while the key is held).
let pttKeyHeld = false;
let pttMode: 'uiohook' | 'toggle' | 'none' = 'none';
let pttToggleActive = false; // for fallback toggle mode

function getPillPosition(heightOverride?: number): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
  const h = heightOverride ?? PILL_HEIGHT;
  const x = Math.round(dx + (dw - PILL_WIDTH) / 2);
  const y = Math.round(dy + dh - h - PILL_BOTTOM_MARGIN);
  return { x, y };
}

/**
 * Compute the right pill height for the current combination of:
 * - bind panel expanded (or not)
 * - recording mode active (or not)
 *
 * Pill never shrinks during a state change while bind panel is open.
 */
function computePillHeight(): number {
  if (pillExpandedBind && pillRecordingMode) return PILL_HEIGHT_FULL;
  if (pillExpandedBind) return PILL_HEIGHT_EXPANDED;
  if (pillRecordingMode) return PILL_HEIGHT_REC;
  return PILL_HEIGHT;
}

function applyPillHeight(): void {
  if (!pillWindow) return;
  const h = computePillHeight();
  const { x, y } = getPillPosition(h);
  pillWindow.setBounds({ x, y, width: PILL_WIDTH, height: h }, false);
}

function setPillExpanded(expanded: boolean): void {
  pillExpandedBind = !!expanded;
  applyPillHeight();
}

function setPillRecordingMode(active: boolean): void {
  pillRecordingMode = !!active;
  applyPillHeight();
}

function createPillWindow(): void {
  if (pillWindow) return;
  const { x, y } = getPillPosition();
  pillWindow = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Float above full-screen apps on macOS.
  pillWindow.setAlwaysOnTop(true, 'floating');
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  pillWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 2026-05-24: dev-mode auto-open devtools so founder can see renderer console
  // without right-click (pill window is frameless, no context menu).
  // Set BEENI_DEVTOOLS=0 in env to disable.
  if (process.env.BEENI_DEVTOOLS !== '0') {
    pillWindow.webContents.openDevTools({ mode: 'detach' });
  }

  pillWindow.on('closed', () => {
    pillWindow = null;
  });
}

function showPill(forceListen: boolean): void {
  if (!pillWindow) createPillWindow();
  if (!pillWindow) return;
  const { x, y } = getPillPosition();
  pillWindow.setPosition(x, y, false);
  pillWindow.showInactive(); // Don't steal focus from the user's current app.
  cancelIdleHide();
  if (forceListen) {
    pillWindow.webContents.send('beeni:start-listening');
  }
}

function hidePill(): void {
  if (pillWindow && pillWindow.isVisible()) {
    pillWindow.hide();
  }
}

function scheduleIdleHide(): void {
  // 2026-05-24 founder feedback: auto-hide is annoying when user is going off
  // to look up a doc URL etc. Pill should stay visible until user explicitly
  // hides it via hotkey (Cmd+Opt+B) or Tray menu. No timer.
  cancelIdleHide();
  // (intentionally do nothing — pill stays put)
}

function cancelIdleHide(): void {
  if (idleHideTimer) {
    clearTimeout(idleHideTimer);
    idleHideTimer = null;
  }
}

function createTray(): void {
  // Tiny 16x16 transparent icon placeholder (a filled circle in the
  // Beegin sage color). nativeImage.createFromDataURL accepts a PNG.
  // Minimal solid-fill PNG (16x16, sage #5F7A5C). Generated once, inlined.
  const sageDotPng =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVQ4T2NkoBAwUqif' +
    'YdQAhtEwGA2D/4D/QwowKqDIBYy0coGRJgYwjvph1ANGw2A0DEZsGAAA42cD/Wj42z4A' +
    'AAAASUVORK5CYII=';
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${sageDotPng}`);
  tray = new Tray(icon);
  tray.setToolTip('Beeni voice pill');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show pill (Cmd+Opt+B toggles)',
      click: () => showPill(false),
    },
    {
      label: 'Hide pill',
      click: () => hidePill(),
    },
    { type: 'separator' },
    { label: '背景资料…', click: () => openContextWindow() },
    { label: '设置 (API key)…', click: () => createSetupWindow() },
    { type: 'separator' },
    { label: 'Quit Beeni', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (pillWindow && pillWindow.isVisible()) {
      hidePill();
    } else {
      showPill(false);
    }
  });
}

function registerHotkey(): void {
  // Cmd+Opt+B → toggle pill visibility (does NOT start listening — PTT does that).
  const accelerator = 'Command+Alt+B';
  const ok = globalShortcut.register(accelerator, () => {
    if (pillWindow && pillWindow.isVisible()) {
      hidePill();
    } else {
      showPill(false);
    }
  });
  if (!ok) {
    console.warn('[beeni-main] failed to register hotkey', accelerator);
  } else {
    console.log('[beeni-main] hotkey registered (toggle visibility):', accelerator);
  }
}

// ── Push-to-talk (Option A: uiohook-napi global Control key listener) ───
function showPillForPtt(): void {
  // Make sure the pill is visible when PTT starts (even if user had hidden it).
  if (!pillWindow) createPillWindow();
  if (pillWindow && !pillWindow.isVisible()) {
    const { x, y } = getPillPosition();
    pillWindow.setPosition(x, y, false);
    pillWindow.showInactive();
  }
  cancelIdleHide();
}

function sendPttStart(): void {
  showPillForPtt();
  pillWindow?.webContents.send('beeni:ptt-start');
}

function sendPttStop(): void {
  pillWindow?.webContents.send('beeni:ptt-stop');
}

function sendPttToggle(): void {
  showPillForPtt();
  pillWindow?.webContents.send('beeni:ptt-toggle');
}

function setupPushToTalkUiohook(): boolean {
  if (!uIOhookAvailable) return false;
  try {
    // macOS Accessibility permission is required. systemPreferences gives us
    // a non-prompting check; we surface a dialog if it's missing.
    if (process.platform === 'darwin') {
      const trusted = systemPreferences.isTrustedAccessibilityClient(false);
      if (!trusted) {
        console.warn(
          '[beeni-main] macOS Accessibility permission missing — prompting user',
        );
        // Trigger the system prompt + open Preferences pane.
        systemPreferences.isTrustedAccessibilityClient(true);
        // Show our own dialog with clear instructions.
        const r = dialog.showMessageBoxSync({
          type: 'info',
          title: 'Beeni 需要辅助功能权限',
          message: '请在 系统设置 → 隐私与安全 → 辅助功能 中勾选 "Beeni" (或 Electron)，然后重启应用。',
          detail:
            '这是为了让 Beeni 能在任何应用中监听你按住 Control 键说话。\n\n如果列表里没看到 Beeni，点击下方"打开系统设置"按钮，再拖入或选择 Electron / Beeni。',
          buttons: ['打开系统设置', '稍后'],
          defaultId: 0,
        });
        if (r === 0) {
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
          );
        }
        // We still try to start the hook — it may work in this session if the
        // user grants permission immediately. If not, events simply won't fire
        // and we'll log nothing.
      }
    }

    const CTRL = UiohookKey.Ctrl;
    const CTRL_RIGHT = UiohookKey.CtrlRight;

    uIOhook.on('keydown', (e: { keycode: number }) => {
      if (e.keycode !== CTRL && e.keycode !== CTRL_RIGHT) return;
      // Dedup: uiohook fires repeat keydown events while held.
      if (pttKeyHeld) return;
      pttKeyHeld = true;
      sendPttStart();
    });

    uIOhook.on('keyup', (e: { keycode: number }) => {
      if (e.keycode !== CTRL && e.keycode !== CTRL_RIGHT) return;
      if (!pttKeyHeld) return;
      pttKeyHeld = false;
      sendPttStop();
    });

    uIOhook.start();
    pttMode = 'uiohook';
    console.log('[beeni-main] PTT mode: uiohook (hold Control)');
    return true;
  } catch (err) {
    console.warn('[beeni-main] uiohook setup failed:', (err as Error).message);
    return false;
  }
}

function setupPushToTalkFallbackToggle(): void {
  // Option C: Ctrl+Space global toggle (start/stop recording).
  const accel = 'Control+Space';
  const ok = globalShortcut.register(accel, () => {
    pttToggleActive = !pttToggleActive;
    sendPttToggle();
  });
  if (ok) {
    pttMode = 'toggle';
    console.log('[beeni-main] PTT mode: fallback toggle (Ctrl+Space)');
  } else {
    pttMode = 'none';
    console.warn('[beeni-main] PTT fallback Ctrl+Space registration failed');
  }
}

function setupPushToTalk(): void {
  const ok = setupPushToTalkUiohook();
  if (!ok) {
    console.warn(
      '[beeni-main] uiohook unavailable — falling back to Ctrl+Space toggle',
    );
    setupPushToTalkFallbackToggle();
  }
}

// ── IPC: agent run (POST /api/agent/run, JSON) ───────────────────────────
ipcMain.handle('beeni:agent-run', async (_evt, prompt: string) => {
  try {
    const res = await fetch(`${SERVER_BASE}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, maxRounds: 4 }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
    }
    const json = (await res.json()) as any;
    return json;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// ── IPC: TTS streaming (SSE → forwarded chunks) ──────────────────────────
ipcMain.handle('beeni:tts-stream', async (evt, text: string) => {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const url = new URL(`${SERVER_BASE}/api/tts-stream`);
    const body = JSON.stringify({ text, format: 'mp3' });
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          res.resume();
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of raw.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload) continue;
              try {
                const parsed = JSON.parse(payload);
                evt.sender.send('beeni:tts-chunk', parsed);
              } catch {
                /* ignore parse errors */
              }
            }
          }
        });
        res.on('end', () => {
          evt.sender.send('beeni:tts-chunk', { done: true });
          resolve({ ok: true });
        });
        res.on('error', (err) => {
          resolve({ ok: false, error: err.message });
        });
      },
    );
    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    req.write(body);
    req.end();
  });
});

ipcMain.handle('beeni:get-server', () => SERVER_BASE);

ipcMain.handle('beeni:get-ptt-mode', () => pttMode);

ipcMain.on('beeni:hide-pill', () => hidePill());
ipcMain.on('beeni:show-pill', () => showPill(false));
ipcMain.on('beeni:set-idle', (_evt, isIdle: boolean) => {
  if (isIdle) scheduleIdleHide();
  else cancelIdleHide();
});
ipcMain.on('beeni:set-pill-expanded', (_evt, expanded: boolean) => {
  setPillExpanded(!!expanded);
});

ipcMain.on('beeni:set-pill-recording', (_evt, active: boolean) => {
  setPillRecordingMode(!!active);
});

// Open URL in user's default browser (or 飞书 app if registered for the URL).
// Used when create_doc succeeds → renderer auto-opens the new doc.
ipcMain.handle('beeni:open-external', async (_evt, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid url' };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// ── Backend server child process (spawned on app start, killed on quit) ──
// One-command UX: `npm start` launches Electron, Electron spawns the backend
// server as a child process. User doesn't open 2 terminals.
let serverProc: ChildProcess | null = null;
function startBackendServer() {
  if (serverProc) return;
  const projectRoot = path.resolve(__dirname, '..');
  console.log('[main] spawning backend: cd', projectRoot, '&& npx tsx src/server.ts');
  serverProc = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
  serverProc.on('exit', (code) => {
    console.log(`[main] backend server exited code=${code}`);
    serverProc = null;
  });
}
function stopBackendServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch {}
  serverProc = null;
}

// ── First-run setup gate ──────────────────────────────────────────────────
// If .env is missing keys, show the setup wizard (served by the backend at
// /setup) instead of the pill, then switch to the pill once keys are saved.
let setupWindow: BrowserWindow | null = null;

async function waitForServerHealth(timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${SERVER_BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
async function fetchSetupStatus(): Promise<{ allReady: boolean } | null> {
  try {
    return (await (await fetch(`${SERVER_BASE}/api/setup/status`)).json()) as any;
  } catch {
    return null;
  }
}
function createSetupWindow(): void {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 760,
    height: 820,
    title: 'Beeni · 首次配置',
    backgroundColor: '#f5f3ee',
  });
  setupWindow.loadURL(`${SERVER_BASE}/setup`);
  setupWindow.on('closed', () => { setupWindow = null; });
}
let contextWindow: BrowserWindow | null = null;
function openContextWindow(): void {
  if (contextWindow) { contextWindow.focus(); return; }
  contextWindow = new BrowserWindow({
    width: 720,
    height: 780,
    title: 'Beeni · 背景资料',
    backgroundColor: '#f5f3ee',
  });
  contextWindow.loadURL(`${SERVER_BASE}/context`);
  contextWindow.on('closed', () => { contextWindow = null; });
}
function launchPill(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  createPillWindow();
  showPill(false);
  scheduleIdleHide();
}
async function isServerHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${SERVER_BASE}/api/health`)).ok;
  } catch {
    return false;
  }
}
async function bootUI(): Promise<void> {
  // Reuse an already-running backend (a leftover server from a prior run, or a
  // second pill launch) instead of spawning another one that would crash with
  // EADDRINUSE on :3001.
  let healthy = await isServerHealthy();
  if (healthy) {
    console.log(`[main] backend already running on ${SERVER_BASE} — reusing it`);
  } else {
    startBackendServer();
    healthy = await waitForServerHealth();
  }
  const status = healthy ? await fetchSetupStatus() : null;
  if (!healthy || (status && status.allReady)) {
    // Keys present (or we can't tell) — go straight to the pill.
    launchPill();
    return;
  }
  // Missing keys → setup wizard. Show dock so the window is easy to find.
  if (process.platform === 'darwin') app.dock?.show();
  createSetupWindow();
  const poll = setInterval(async () => {
    const s = await fetchSetupStatus();
    if (s && s.allReady) {
      clearInterval(poll);
      if (setupWindow) { try { setupWindow.close(); } catch {} setupWindow = null; }
      launchPill();
    }
  }, 2000);
}

// ── App lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // macOS: hide from dock — pill is a tray/utility app, not a window app.
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
  createTray();
  registerHotkey();
  setupPushToTalk();
  // bootUI reuses an existing backend or spawns one, then shows setup/pill.
  void bootUI();
});

app.on('window-all-closed', () => {
  // Keep app alive in tray; don't quit when pill is hidden/closed.
  // (No e.preventDefault needed — we just don't call app.quit().)
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pttMode === 'uiohook' && uIOhookAvailable) {
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
  }
  stopBackendServer();
});
