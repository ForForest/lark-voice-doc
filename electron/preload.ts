/**
 * preload.ts — exposes a minimal `window.beeni` API to the pill renderer.
 *
 * No nodeIntegration in the renderer; everything crosses the IPC bridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

export interface AgentRunResult {
  ok: boolean;
  finalText?: string;
  rounds?: number;
  error?: string;
}

export interface TtsChunk {
  meta?: { format: 'pcm' | 'mp3'; sampleRate?: number; channels?: number };
  mp3Chunk?: string; // base64
  pcmChunk?: string; // base64
  sampleRate?: number;
  done?: boolean;
  error?: string;
}

export type PttMode = 'uiohook' | 'toggle' | 'none';

contextBridge.exposeInMainWorld('beeni', {
  agentRun: (prompt: string): Promise<AgentRunResult> =>
    ipcRenderer.invoke('beeni:agent-run', prompt),

  ttsStream: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('beeni:tts-stream', text),

  onTtsChunk: (cb: (chunk: TtsChunk) => void): (() => void) => {
    const listener = (_evt: unknown, chunk: TtsChunk) => cb(chunk);
    ipcRenderer.on('beeni:tts-chunk', listener);
    return () => ipcRenderer.removeListener('beeni:tts-chunk', listener);
  },

  onStartListening: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('beeni:start-listening', listener);
    return () => ipcRenderer.removeListener('beeni:start-listening', listener);
  },

  onPttStart: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('beeni:ptt-start', listener);
    return () => ipcRenderer.removeListener('beeni:ptt-start', listener);
  },

  onPttStop: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('beeni:ptt-stop', listener);
    return () => ipcRenderer.removeListener('beeni:ptt-stop', listener);
  },

  onPttToggle: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('beeni:ptt-toggle', listener);
    return () => ipcRenderer.removeListener('beeni:ptt-toggle', listener);
  },

  getPttMode: (): Promise<PttMode> => ipcRenderer.invoke('beeni:get-ptt-mode'),

  getServer: (): Promise<string> => ipcRenderer.invoke('beeni:get-server'),

  hidePill: (): void => ipcRenderer.send('beeni:hide-pill'),
  showPill: (): void => ipcRenderer.send('beeni:show-pill'),
  setIdle: (isIdle: boolean): void => ipcRenderer.send('beeni:set-idle', isIdle),

  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('beeni:open-external', url),

  setPillExpanded: (expanded: boolean): void =>
    ipcRenderer.send('beeni:set-pill-expanded', expanded),

  setPillRecording: (active: boolean): void =>
    ipcRenderer.send('beeni:set-pill-recording', active),
});

// Type augmentation for renderer-side TypeScript (consumed by renderer/pill.ts).
declare global {
  interface Window {
    beeni: {
      agentRun: (prompt: string) => Promise<AgentRunResult>;
      ttsStream: (text: string) => Promise<{ ok: boolean; error?: string }>;
      onTtsChunk: (cb: (chunk: TtsChunk) => void) => () => void;
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
    };
  }
}
