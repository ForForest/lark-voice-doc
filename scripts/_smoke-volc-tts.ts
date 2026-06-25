/**
 * _smoke-volc-tts.ts — exercise the real volc-tts module (stream + one-shot)
 * for both mp3 and pcm. Verifies audio bytes + first-chunk latency, and writes
 * the mp3 to /tmp so you can listen.
 *   Run: npx tsx scripts/_smoke-volc-tts.ts
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { synthesizeVolc, synthesizeVolcStream } from '../src/lib/volc-tts';

const TEXT = '你好，我是 Beeni。我们一起把这个创意理清楚，好不好？';

async function testStream(format: 'mp3' | 'pcm') {
  let chunks = 0;
  let bytes = 0;
  let firstMs = -1;
  const t0 = Date.now();
  for await (const buf of synthesizeVolcStream({ text: TEXT, format, onFirstChunk: (ms) => (firstMs = ms) })) {
    chunks++;
    bytes += buf.length;
  }
  console.log(`  stream[${format}]: chunks=${chunks} bytes=${bytes} firstChunk=${firstMs}ms total=${Date.now() - t0}ms`);
  return bytes;
}

(async () => {
  console.log('=== volc-tts smoke ===');
  try {
    const mp3Bytes = await testStream('mp3');
    const pcmBytes = await testStream('pcm');

    const one = await synthesizeVolc({ text: TEXT, format: 'mp3' });
    writeFileSync('/tmp/volc-tts-smoke.mp3', one.audio);
    console.log(`  oneShot[mp3]: bytes=${one.audio.length} durationMs=${one.durationMs} latencyMs=${one.latencyMs} -> /tmp/volc-tts-smoke.mp3`);

    const pass = mp3Bytes > 1000 && pcmBytes > 1000 && one.audio.length > 1000;
    console.log(pass ? '\n✅ PASS — both mp3 & pcm produce audio' : '\n❌ FAIL — insufficient audio');
    process.exit(pass ? 0 : 1);
  } catch (e) {
    console.error('\n❌ FAIL:', (e as Error).message);
    process.exit(1);
  }
})();
