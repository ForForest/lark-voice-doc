// Real end-to-end test: create a hello-world doc in 飞书.
// Run: npx tsx src/test-lark-create.ts
import 'dotenv/config';
import { larkCreateDoc } from './lib/lark';

(async () => {
  const title = `lark-voice-doc smoke test ${new Date().toISOString()}`;
  const md =
    '# hello world\n\nlark-voice-doc Phase 1 smoke test.\n\n' +
    '- created at: ' + new Date().toISOString() + '\n' +
    '- env: Node ' + process.version + '\n\n' +
    '如果你在飞书里看到这段, 说明 lark-cli wrapper 跑通了.\n';
  console.log(`[test] creating doc "${title}"...`);
  const res = await larkCreateDoc(title, md);
  console.log('[test] OK');
  console.log('  docToken:', res.docToken);
  console.log('  whiteboardToken:', res.whiteboardToken || '(none)');
  console.log('  raw:', JSON.stringify(res.raw).slice(0, 400));
})();
