/**
 * _phase4-whiteboard-quality.ts — A/B Doubao vs Gemini Flash on 5 real
 * discussion shapes. For each scenario we want to see:
 *   - mermaid generates cleanly
 *   - the visual type matches the shape (flowchart / mindmap / sequence /
 *     gantt / quadrant) and not always default flowchart
 *   - latency
 *
 * Run with server NOT required (this is a direct LLM A/B):
 *   npx tsx scripts/_phase4-whiteboard-quality.ts
 *
 * Output: text table per scenario per model.
 */

import 'dotenv/config';
import { summarizeToMermaid } from '../src/lib/whiteboard-llm';

interface Scenario {
  name: string;
  expectedType: string; // flowchart | mindmap | sequenceDiagram | gantt | quadrantChart | stateDiagram
  transcript: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: '流程: onboarding 三步',
    expectedType: 'flowchart',
    transcript:
      '咱们 onboarding 走 3 步: 第一步用户注册账号, 第二步申请麦克风权限, 第三步做完 intake 问卷. 后面就进首页了.',
  },
  {
    name: 'brainstorm: memory 四层',
    expectedType: 'mindmap',
    transcript:
      'memory 系统大概想成 4 层: 工作记忆, 会话记忆, 长期事实库, 还有一个语义召回. 后两层是借鉴 OpenClaw 的设计. 工作记忆是当下 5 分钟, 会话记忆是这次 conversation, 长期是 facts, 语义召回是向量数据库.',
  },
  {
    name: '时序: 4 组件交互',
    expectedType: 'sequenceDiagram',
    transcript:
      '调用顺序: 用户说话 → Beeni 收到 → Beeni 给 Doubao 拿 tool_use → Doubao 返回 → Beeni 调 lark-cli 写文档 → 返回成功 → Beeni 调 MiniMax 出语音 → 给用户. 5 步上下来.',
  },
  {
    name: '排期: 本周到下周一',
    expectedType: 'gantt',
    transcript:
      '咱们计划这样: 5 月 25 到 27 写 Phase 4 spec, 5 月 28 到 29 写代码, 5 月 30 测试, 6 月 1 周一上线. 期间周末 founder 可能审。',
  },
  {
    name: '比较: 三个 LLM 候选',
    expectedType: 'quadrantChart',
    transcript:
      '挑 whiteboard LLM 三个候选, 按"延迟低"和"图质量高"两个维度看. Doubao reasoning 延迟中等图质量好, Gemini Flash 延迟低质量中等, DeepSeek 延迟低但没 vision 不行.',
  },
];

interface Result {
  scenario: string;
  model: string;
  ok: boolean;
  detectedType: string;
  latencyMs: number;
  charsOut: number;
  mermaidPreview: string;
  err?: string;
}

function detectMermaidType(mermaid: string | null): string {
  if (!mermaid) return '(SKIP)';
  const head = mermaid.trim().split('\n')[0].toLowerCase();
  if (head.startsWith('flowchart') || head.startsWith('graph')) return 'flowchart';
  if (head.startsWith('mindmap')) return 'mindmap';
  if (head.startsWith('sequencediagram')) return 'sequenceDiagram';
  if (head.startsWith('gantt')) return 'gantt';
  if (head.startsWith('quadrantchart')) return 'quadrantChart';
  if (head.startsWith('statediagram')) return 'stateDiagram';
  return head.split(/\s+/)[0];
}

async function runOne(scen: Scenario, model: 'doubao' | 'gemini-flash'): Promise<Result> {
  try {
    const r = await summarizeToMermaid({
      transcript: scen.transcript,
      model,
    });
    return {
      scenario: scen.name,
      model,
      ok: true,
      detectedType: detectMermaidType(r.mermaid),
      latencyMs: r.latencyMs,
      charsOut: r.mermaid ? r.mermaid.length : 0,
      mermaidPreview: (r.mermaid || '(skip)').replace(/\n/g, ' \\n ').slice(0, 140),
    };
  } catch (err) {
    return {
      scenario: scen.name,
      model,
      ok: false,
      detectedType: '(err)',
      latencyMs: 0,
      charsOut: 0,
      mermaidPreview: '',
      err: (err as Error).message.slice(0, 200),
    };
  }
}

async function main() {
  console.log('Phase 4 — whiteboard LLM quality A/B');
  console.log('====================================');
  const rows: Result[] = [];
  for (const scen of SCENARIOS) {
    console.log(`\n▸ ${scen.name}  (expect ${scen.expectedType})`);
    for (const model of ['doubao', 'gemini-flash'] as const) {
      process.stdout.write(`  ${model.padEnd(14)} ... `);
      const r = await runOne(scen, model);
      rows.push(r);
      if (r.ok) {
        const ok = r.detectedType === scen.expectedType ? '✓' : '~';
        console.log(`${ok} ${r.detectedType.padEnd(18)} ${r.latencyMs}ms  ${r.charsOut}ch`);
        console.log(`    ${r.mermaidPreview}`);
      } else {
        console.log(`✗ ${r.err}`);
      }
    }
  }

  // Per-model score (% correct visual type)
  console.log('\n────────── SCOREBOARD ──────────');
  for (const model of ['doubao', 'gemini-flash']) {
    const mine = rows.filter((r) => r.model === model);
    const okCount = mine.filter((r) => r.ok).length;
    const correctType = mine.filter(
      (r) => r.ok && r.detectedType === SCENARIOS.find((s) => s.name === r.scenario)!.expectedType,
    ).length;
    const avgLat =
      mine.filter((r) => r.ok).reduce((a, b) => a + b.latencyMs, 0) /
      (okCount || 1);
    console.log(
      `${model.padEnd(14)} ok=${okCount}/${SCENARIOS.length}  correct-type=${correctType}/${SCENARIOS.length}  avgLatency=${Math.round(avgLat)}ms`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
