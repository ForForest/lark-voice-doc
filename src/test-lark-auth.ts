// npx tsx src/test-lark-auth.ts
import 'dotenv/config';
import { larkAuthStatus } from './lib/lark';

(async () => {
  const r = await larkAuthStatus();
  console.log('ok:', r.ok);
  console.log('raw:\n' + r.raw);
})();
