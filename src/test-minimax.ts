// Standalone smoke test for the MiniMax wrapper.
// Run: npx tsx src/test-minimax.ts
import 'dotenv/config';
import { synthesizeMinimax } from './lib/minimax';

(async () => {
  const r = await synthesizeMinimax({ text: 'hello world from lark voice doc' });
  console.log(
    `mp3 bytes: ${r.mp3.length} | durationMs: ${r.durationMs} | latency: ${r.latencyMs}ms`,
  );
})();
