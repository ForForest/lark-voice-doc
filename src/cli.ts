/**
 * cli.ts — quick CLI to drive the agent loop from the terminal.
 *
 * Two modes:
 *
 *   1) Single-shot (legacy, kept for back-compat):
 *      npx tsx src/cli.ts "your prompt here"
 *      npx tsx src/cli.ts --model=hard "harder prompt"
 *
 *   2) REPL multi-turn (new, mirrors what the Electron pill will do):
 *      npx tsx src/cli.ts --repl
 *      > 帮我画一个 mermaid 流程图
 *      < Beeni: ...
 *      > 改一下第 2 步
 *      < Beeni: ...
 *      ^C to quit
 *      /reset to wipe history mid-session
 *      /history to dump message log
 *
 * Note: lark-cli tool calls will fail until founder runs OAuth
 *   (see /tmp/lark-voice-doc-handoff.md). search_repo / read_file work today.
 */

import 'dotenv/config';
import * as readline from 'node:readline';
import { runAgent, AgentRunStep, ConversationSession } from './lib/agent-loop';

function parseArgs(): {
  prompt: string;
  model: 'flash' | 'hard';
  maxRounds: number;
  repl: boolean;
} {
  const argv = process.argv.slice(2);
  let model: 'flash' | 'hard' = 'flash';
  let maxRounds = 10;
  let repl = false;
  const promptParts: string[] = [];
  for (const a of argv) {
    if (a === '--hard' || a === '--model=hard') {
      model = 'hard';
    } else if (a === '--flash' || a === '--model=flash') {
      model = 'flash';
    } else if (a === '--repl') {
      repl = true;
    } else if (a.startsWith('--max-rounds=')) {
      maxRounds = Math.max(1, Math.min(20, Number(a.slice('--max-rounds='.length)) || 10));
    } else {
      promptParts.push(a);
    }
  }
  return { prompt: promptParts.join(' ').trim(), model, maxRounds, repl };
}

function fmtStep(s: AgentRunStep): string {
  if (s.type === 'assistant_message') {
    return `\n── round ${s.round} · assistant ──\n${s.content || '(no text — tool call only)'}`;
  }
  if (s.type === 'tool_call') {
    const argsStr = JSON.stringify(s.tool_args).slice(0, 240);
    return `  → tool ${s.tool_name}(${argsStr})`;
  }
  if (s.type === 'tool_result') {
    const r = s.tool_result;
    let summary: string;
    if (r && r.error) {
      summary = `error: ${r.error}`;
    } else if (r && typeof r === 'object') {
      const keys = Object.keys(r).slice(0, 5).join(',');
      summary = `ok (${keys})`;
    } else {
      summary = String(r).slice(0, 200);
    }
    return `  ← ${s.tool_name}: ${summary}`;
  }
  return '';
}

async function runSingleShot(prompt: string, model: 'flash' | 'hard', maxRounds: number) {
  console.log(`[cli] model=${model} maxRounds=${maxRounds}`);
  console.log(`[cli] prompt: ${prompt}`);
  try {
    const result = await runAgent({
      prompt,
      model,
      maxRounds,
      onStep: (s) => {
        const line = fmtStep(s);
        if (line) console.log(line);
      },
    });
    console.log('\n========== FINAL ==========');
    console.log(result.finalText);
    console.log(`\n[cli] done in ${result.rounds} round(s)`);
  } catch (err) {
    console.error('[cli] error:', (err as Error).message);
    process.exit(1);
  }
}

async function runRepl(model: 'flash' | 'hard') {
  console.log(`[cli] REPL mode · model=${model}`);
  console.log('[cli] commands: /reset (wipe history), /history (dump), /quit, Ctrl+C to exit');
  console.log('[cli] type your message and press enter. multi-line not supported.\n');

  const session = new ConversationSession({ model });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  // Track whether we just printed a streamed token line (so we know if we need a leading \n)
  let inAssistantStream = false;

  const handleSigint = () => {
    if (session.isBusy) {
      console.log('\n[cli] ^C → interrupting current turn (press again to quit)');
      session.interrupt();
    } else {
      console.log('\n[cli] bye');
      process.exit(0);
    }
  };
  process.on('SIGINT', handleSigint);

  rl.prompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    if (line === '/quit' || line === '/exit') {
      console.log('[cli] bye');
      rl.close();
      process.exit(0);
    }
    if (line === '/reset') {
      session.reset();
      console.log('[cli] session reset (history wiped)');
      rl.prompt();
      return;
    }
    if (line === '/history') {
      const msgs = session.getMessages();
      console.log(`[cli] ${msgs.length} messages in history:`);
      for (const m of msgs) {
        const head = m.role.padEnd(10);
        if (m.tool_calls && m.tool_calls.length) {
          const names = m.tool_calls.map((t) => t.function.name).join(',');
          console.log(`  ${head} (tool_calls: ${names})`);
        } else {
          const txt = (m.content || '').replace(/\s+/g, ' ').slice(0, 120);
          console.log(`  ${head} ${txt}`);
        }
      }
      rl.prompt();
      return;
    }

    if (session.isBusy) {
      console.log('[cli] (interrupting in-flight turn first)');
      session.interrupt();
      await new Promise((r) => setTimeout(r, 50));
    }

    process.stdout.write('< Beeni: ');
    inAssistantStream = true;
    try {
      const result = await session.sendUserTurn(line, {
        onAssistantToken: (tok) => {
          process.stdout.write(tok);
        },
        onToolCall: (name, args) => {
          if (inAssistantStream) {
            process.stdout.write('\n');
            inAssistantStream = false;
          }
          const argsStr = JSON.stringify(args).slice(0, 200);
          console.log(`  [tool: ${name}] ${argsStr}`);
        },
        onToolResult: (name, ok, summary) => {
          const mark = ok ? 'OK' : 'FAIL';
          console.log(`  [tool: ${name}] ${mark} — ${summary}`);
          // model will continue speaking on next assistant_message; reset prefix
          process.stdout.write('< Beeni: ');
          inAssistantStream = true;
        },
      });
      if (inAssistantStream) {
        process.stdout.write('\n');
        inAssistantStream = false;
      }
      if (result.aborted) {
        console.log('[cli] (turn aborted)');
      }
      console.log(
        `[cli] turn done · rounds=${result.rounds} · tools=${result.toolsUsed.length ? result.toolsUsed.join(',') : 'none'}`,
      );
    } catch (err) {
      if (inAssistantStream) process.stdout.write('\n');
      console.error('[cli] error:', (err as Error).message);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

async function main() {
  const { prompt, model, maxRounds, repl } = parseArgs();
  if (repl) {
    await runRepl(model);
    return;
  }
  if (!prompt) {
    console.error('Usage:');
    console.error('  npx tsx src/cli.ts [--hard|--flash] [--max-rounds=N] "your prompt"');
    console.error('  npx tsx src/cli.ts --repl [--hard|--flash]');
    process.exit(2);
  }
  await runSingleShot(prompt, model, maxRounds);
}

main();
