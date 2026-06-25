/**
 * setup.ts — first-run credential setup. Reads/writes .env (preserving its
 * structure), reports which credentials are present (NEVER their values), and
 * live-tests posted credentials before the user commits them.
 *
 * Used by the setup wizard (/setup) so a fresh clone of this PUBLIC repo can be
 * configured by filling in the user's own keys — no keys ship in the repo.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import process from 'node:process';

const ENV_PATH = path.join(process.cwd(), '.env');

/** Credential env vars the wizard manages. */
export const MANAGED_KEYS = [
  'VOLC_APP_ID',
  'VOLC_ACCESS_TOKEN',
  'VOLC_SECRET_KEY',
  'ARK_API_KEY',
] as const;

function isSet(v?: string): boolean {
  if (!v) return false;
  const t = v.trim();
  if (!t) return false;
  // reject leftover placeholders from .env.example
  if (/^your-|-here$|placeholder|^xxx/i.test(t)) return false;
  return true;
}

export interface SetupStatus {
  volc: boolean; // 火山 ASR + TTS (App ID + Access Token)
  ark: boolean; // 豆包 Ark
  allReady: boolean;
  present: Record<string, boolean>;
  envPath: string;
}

export function getSetupStatus(): SetupStatus {
  const present: Record<string, boolean> = {};
  for (const k of MANAGED_KEYS) present[k] = isSet(process.env[k]);
  const volc = present.VOLC_APP_ID && present.VOLC_ACCESS_TOKEN;
  const ark = present.ARK_API_KEY;
  return { volc, ark, allReady: volc && ark, present, envPath: ENV_PATH };
}

function quoteIfNeeded(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/**
 * Upsert the given key→value pairs into .env, preserving existing lines and
 * comments. Creates .env if missing. Also hot-reloads them into process.env so
 * the running server picks them up without a restart (the credential reads in
 * the volc and agent-loop modules happen at call time).
 */
export async function saveEnv(values: Record<string, string>): Promise<void> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim() && MANAGED_KEYS.includes(k as any)) {
      clean[k] = v.trim();
    }
  }
  if (Object.keys(clean).length === 0) return;

  let lines: string[];
  try {
    lines = (await fs.readFile(ENV_PATH, 'utf-8')).split(/\r?\n/);
  } catch {
    lines = ['# lark-voice-doc credentials — written by the setup wizard. NEVER commit.'];
  }

  const seen = new Set<string>();
  lines = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && clean[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${quoteIfNeeded(clean[m[1]])}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(clean)) {
    if (!seen.has(k)) lines.push(`${k}=${quoteIfNeeded(v)}`);
  }

  await fs.writeFile(ENV_PATH, lines.join('\n'), 'utf-8');
  for (const [k, v] of Object.entries(clean)) process.env[k] = v;
}

// ── Live credential tests ────────────────────────────────────────────────────

/** Test a 豆包 Ark key with a tiny non-thinking completion. */
export async function testArk(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  if (!isSet(apiKey)) return { ok: false, detail: '请先填 ARK_API_KEY' };
  try {
    const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.DOUBAO_WB_MODEL || 'doubao-seed-2-0-mini-260215',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4,
        thinking: { type: 'disabled' },
      }),
    });
    if (res.ok) return { ok: true, detail: '✓ 豆包 key 有效，模型可调用' };
    const t = await res.text();
    let code = '';
    try { code = JSON.parse(t)?.error?.code || ''; } catch {}
    if (/NotFound|access/i.test(code)) {
      return { ok: false, detail: `key 能用但模型没开通：到方舟「开通管理」开通 doubao-seed-2-0-mini/pro（${code}）` };
    }
    return { ok: false, detail: `豆包返回 ${res.status} ${code}: ${t.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Test 火山 speech credentials by opening the big-model TTS WebSocket and
 * waiting for ConnectionStarted (auth + resource entitlement OK) — the cheapest
 * real signal that the App ID / Access Token work AND TTS is enabled.
 */
export function testVolc(appId: string, accessToken: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    if (!isSet(appId) || !isSet(accessToken)) {
      return resolve({ ok: false, detail: '请先填 VOLC_APP_ID 和 VOLC_ACCESS_TOKEN' });
    }
    const resourceId = process.env.VOLC_TTS_RESOURCE_ID || 'seed-tts-2.0';
    let settled = false;
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(r);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/tts/bidirection', {
        headers: {
          'X-Api-App-Id': appId,
          'X-Api-App-Key': appId,
          'X-Api-Access-Key': accessToken,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Request-Id': randomUUID(),
          'X-Api-Connect-Id': randomUUID(),
        },
      });
    } catch (e) {
      return resolve({ ok: false, detail: (e as Error).message });
    }
    const timer = setTimeout(() => done({ ok: false, detail: '连接超时（检查网络/凭据）' }), 15000);
    ws.on('open', () => {
      // StartConnection frame (WithEvent, event=1, empty payload)
      const header = Buffer.from([0x11, (0b0001 << 4) | 0b0100, (0b0001 << 4) | 0, 0]);
      const ev = Buffer.alloc(4); ev.writeInt32BE(1, 0);
      const plen = Buffer.alloc(4); plen.writeUInt32BE(2, 0);
      ws.send(Buffer.concat([header, ev, plen, Buffer.from('{}')]));
    });
    ws.on('message', (data: Buffer) => {
      clearTimeout(timer);
      // event int sits at bytes 4-7 when WithEvent flag set
      if (data.length >= 8) {
        const event = data.readInt32BE(4);
        if (event === 50) return done({ ok: true, detail: '✓ 火山凭据有效，TTS 已开通' }); // ConnectionStarted
        if (event === 51) return done({ ok: false, detail: '凭据/资源被拒（ConnectionFailed）— 检查 Access Token 或是否开通了大模型语音合成' });
      }
      const msgType = (data[1] >> 4) & 0xf;
      if (msgType === 0b1111) {
        const code = data.length >= 8 ? data.readUInt32BE(4) : 0;
        return done({ ok: false, detail: `火山报错 code=${code}（多半是没开通 TTS 或 Access Token 不对）` });
      }
    });
    ws.on('unexpected-response', (_req, res) => done({ ok: false, detail: `握手失败 HTTP ${res.statusCode}（凭据不对）` }));
    ws.on('error', (e) => done({ ok: false, detail: `连接失败：${(e as Error).message}` }));
  });
}
