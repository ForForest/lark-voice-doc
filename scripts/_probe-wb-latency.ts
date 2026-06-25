/**
 * _probe-wb-latency.ts — measure the whiteboard proposer latency with the REAL
 * transition prompt, for whichever model DOUBAO_WB_MODEL selects. 3 calls so we
 * see cold-vs-warm.
 *   Run: DOUBAO_WB_MODEL=doubao-seed-2-0-mini-260215 npx tsx scripts/_probe-wb-latency.ts
 */
import 'dotenv/config';
import { proposeTransitions } from '../src/lib/whiteboard-llm';
import { emptyState } from '../src/lib/whiteboard-state';

const TRANSCRIPT = [
  '我想做一个语音创意工具',
  '核心是边聊边在白板上记录想法',
  '用豆包做对话, 智商要高',
  '白板用飞书的, 实时更新',
].join('\n');

(async () => {
  console.log('model =', process.env.DOUBAO_WB_MODEL || '(default doubao-seed-2-0-mini-260215)');
  let state = emptyState('probeDoc', 'probeWb', 'flowchart');
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const r = await proposeTransitions({ state, transcript: TRANSCRIPT });
    console.log(`  call ${i}: ${Date.now() - t0}ms  (llm ${r.latencyMs}ms)  transitions=${r.transitions.length} skipped=${r.skipped} note="${r.changeNote}"`);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
