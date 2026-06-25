/**
 * _probe-tts-warm.ts — measure first-byte latency through the REAL module with
 * the persistent connection. 3 sequential calls: call 1 = cold connect, calls
 * 2-3 = warm reuse. Then one pre-warmed call.
 *   Run: npx tsx scripts/_probe-tts-warm.ts
 */
import 'dotenv/config';
import { synthesizeVolcStream, prewarmVolcTts } from '../src/lib/volc-tts';

const TEXT = '你好，我们来聊聊这个创意吧。';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function once(label: string) {
  let firstMs = -1, bytes = 0;
  const t0 = Date.now();
  for await (const buf of synthesizeVolcStream({ text: TEXT, format: 'mp3', onFirstChunk: (ms) => (firstMs = ms) })) {
    bytes += buf.length;
  }
  console.log(`  ${label}: firstByte=${firstMs}ms total=${Date.now() - t0}ms bytes=${bytes}`);
}

(async () => {
  console.log('=== warm-connection first-byte (sequential calls share one connection) ===');
  await once('call 1 (cold connect)');
  await once('call 2 (warm)');
  await once('call 3 (warm)');

  console.log('\n=== pre-warmed: prewarm at "boot", then first call ===');
  // simulate a fresh process boot would reset the singleton; here we just show
  // that after an idle reconnect + prewarm, the first call is warm.
  prewarmVolcTts();
  await sleep(6000); // give the prewarm connect time to finish
  await once('first call after prewarm');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
