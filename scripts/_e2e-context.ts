/**
 * _e2e-context.ts — verify the background-import feature end to end:
 *   - paste add + list, file extract, AND that the agent actually RECEIVES the
 *     imported background (ask it a fact only present in the background).
 *   Run: npx tsx scripts/_e2e-context.ts
 */
import 'dotenv/config';
import { spawn, ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const REPO = path.resolve(__dirname, '..');
const PORT = 3096;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; pass: boolean; detail: string }[] = [];
const rec = (name: string, pass: boolean, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

let server: ChildProcess | null = null;
async function boot() {
  server = spawn(path.join(REPO, 'node_modules', '.bin', 'tsx'), ['src/server.ts'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), WHITEBOARD_PUSH_DRYRUN: '1', DOUBAO_AGENT_THINKING: 'disabled', LARK_CMD_TIMEOUT_MS: '4000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await sleep(500);
  }
  return false;
}
const post = (p: string, body: any) =>
  fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

(async () => {
  console.log('=== background-import E2E ===');
  if (!(await boot())) { rec('server boots', false); process.exit(1); }
  rec('server boots', true);

  // 1) paste add — a fact the model can't know otherwise
  const FACT_CODE = 'ZephyrQ7';
  const FACT_USER = '潜水教练';
  const add = await post('/api/context/add', { label: '测试方案', text: `我们的新产品代号叫 ${FACT_CODE}，核心目标用户是${FACT_USER}。` });
  rec('paste add', !!add.ok && add.items?.length === 1, `items=${add.items?.length}`);

  // 2) list
  const list = await (await fetch(`${BASE}/api/context/list`)).json();
  rec('list returns item', list.items?.length === 1 && list.items[0].label === '测试方案', JSON.stringify(list.items?.[0] || {}));

  // 3) file extract (md)
  const md = '/tmp/_ctx-e2e.md';
  writeFileSync(md, '# 决定\n我们选了方案 B，预算上限 20 万。');
  const buf = require('node:fs').readFileSync(md);
  const ex = await fetch(`${BASE}/api/context/extract?filename=plan.md`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf }).then((r) => r.json());
  rec('file extract (md)', !!ex.ok && /方案 B/.test(ex.text), `${ex.chars} chars`);

  // 4) THE KEY TEST: does the agent receive the background?
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/conversation`);
  const evts: any[] = [];
  ws.on('message', (d) => { try { evts.push(JSON.parse(d.toString())); } catch {} });
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const waitFor = (f: (e: any) => boolean, ms = 90000) => new Promise<any>((res, rej) => {
    const t = setInterval(() => { const e = evts.find(f); if (e) { clearInterval(t); res(e); } else if (ms-- <= 0) { clearInterval(t); rej(new Error('timeout')); } }, 50);
  });
  await waitFor((e) => e.type === 'ready');
  ws.send(JSON.stringify({ type: 'user-final', text: '我们这个产品代号叫什么？目标用户是谁？只用一句话回答。' }));
  const done = await waitFor((e) => e.type === 'turn-done', 90000);
  const reply = String(done?.text || '');
  const gotCode = reply.includes(FACT_CODE);
  const gotUser = reply.includes(FACT_USER);
  rec('agent USES imported background', gotCode && gotUser, `code=${gotCode} user=${gotUser} · "${reply.slice(0, 60)}…"`);
  ws.close();

  // cleanup
  await post('/api/context/clear', {});
  const cleared = await (await fetch(`${BASE}/api/context/list`)).json();
  rec('clear works', cleared.items?.length === 0);

  if (server) try { server.kill('SIGTERM'); } catch {}
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  await sleep(200);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('crash:', e.message); if (server) try { server.kill(); } catch {} process.exit(1); });
