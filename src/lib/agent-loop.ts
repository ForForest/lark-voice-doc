/**
 * agent-loop.ts — Doubao (Ark) chat with tool_use + streaming + multi-turn session.
 *
 * Uses Doubao's OpenAI-compatible Chat Completions endpoint. Two modes:
 *   1) runAgent()             — legacy single-shot (kept for backward compat)
 *   2) ConversationSession    — stateful multi-turn with streaming text tokens
 *                               + tool-call narration. Built for Beeni pill UI.
 *
 *   Endpoint:  https://ark.cn-beijing.volces.com/api/v3/chat/completions
 *   Auth:      Bearer ${ARK_API_KEY}
 *   Default model:   doubao-seed-1-6-flash-250828 ('flash')
 *   Hard model:      doubao-seed-1-6-250615 ('hard')
 *   Strongest model: doubao-seed-2-0-pro-260215 ('strongest', + deep thinking)
 *                    — the conversational creative-partner agent uses this.
 *
 * Streaming protocol (Server-Sent Events from Ark):
 *   Each chunk:  data: {"choices":[{"delta":{"content":"...","tool_calls":[...]}}]}
 *   End marker:  data: [DONE]
 *
 * tool_calls in delta arrive incrementally with `index` to dedupe across chunks.
 * We accumulate id + name + arguments per index, then execute when the chunk
 * finishes (finish_reason='tool_calls') and loop.
 */

import { TOOL_SCHEMAS, executeTool } from './tools';
import {
  summarizeToMermaid,
  proposeTransitions,
  recallWhiteboardMermaid,
  rememberWhiteboardMermaid,
  type WhiteboardLlmChoice,
} from './whiteboard-llm';
import { getWhiteboardManager } from './whiteboard-state';
import { renderMermaid } from './whiteboard-render';
import { larkUpdateWhiteboard, larkFetchDoc } from './lark';

const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DEFAULT_MODEL = 'doubao-seed-1-6-flash-250828';
const HARD_MODEL = 'doubao-seed-1-6-250615';
// The smartest model available on this Ark account (verified live, 2026-06-25).
// Used for the conversational creative-partner agent — intelligence over latency.
const STRONGEST_MODEL = process.env.DOUBAO_AGENT_MODEL || 'doubao-seed-2-0-pro-260215';
const MAX_ROUNDS_DEFAULT = 10;
const MAX_ROUNDS_PER_TURN = 6; // session: smaller per-turn budget; user can ask more

/**
 * Deep-thinking switch for the agent. Seed 2.0 exposes a `thinking` object on
 * the OpenAI-compatible body. Default 'auto' lets the model reason deeply on
 * genuinely hard creative problems (high quality) while staying responsive on
 * simple turns — the best balance for a real-time voice partner. ('enabled'
 * forces deep thinking but costs ~40-70s/turn; 'disabled' is fastest.) When
 * thinking runs, the model streams `reasoning_content` first (our SSE parser
 * ignores it) then the spoken `content`. Toggle via env DOUBAO_AGENT_THINKING.
 */
function thinkingForModel(model: string): { type: string } | undefined {
  const mode = (process.env.DOUBAO_AGENT_THINKING || 'auto').toLowerCase();
  if (model === STRONGEST_MODEL && (mode === 'enabled' || mode === 'auto')) {
    return { type: mode };
  }
  return undefined;
}

export const DEFAULT_SYSTEM_PROMPT =
  '你是一个写文档的助手, 名字叫 Beeni. 你帮用户调研 + 写飞书文档 + 画 mermaid 白板. ' +
  '风格简洁, 主动调工具, 不啰嗦. ' +
  '调研类问题先 search_repo / read_file 找证据再回答, 不凭印象. ' +
  '画图首选 mermaid (flowchart / sequenceDiagram). ' +
  '写文档前先用一两句话告诉用户你的计划, 写完返回 doc_token. ' +
  '工具失败时(尤其 lark 类) 把错误原文告诉用户, 不要装作成功. ' +
  '一轮里能并行的 tool_call 就一次调多个, 不要串行浪费时间. ' +
  '\n\n仓库地址: search_repo 不传 dir 就默认搜配置好的目标仓库 ' +
  '(通过 TARGET_REPO_DIR 环境变量设置, 未设置则是当前工作目录). ' +
  'read_file 路径必须在 user home 内, 不允许 "..". ' +
  'web_search 工具是占位实现, 暂时不可用, 不要为获取知识反复调它.\n\n' +
  '可选: 本地若有 Claude Code 历史, 你能查:\n' +
  '- list_memory_anchors(topic?): 看有哪些累积记忆主题\n' +
  '- read_memory_anchor(filename): 读某个具体 anchor (e.g. "feedback_jargon_replacement_table.md")\n' +
  '- search_memory_anchors(query, topK?): 关键词搜所有 anchor\n' +
  '- list_sessions(limit?): 看最近的 Claude Code session\n' +
  '- search_session(query, sessionId?, topK?): 在过去对话里搜内容\n' +
  '- read_session_recent(sessionId, lastN?): 读某 session 最后 N 轮\n' +
  '用户说 "我们之前讨论过 X" / "上周聊到 Y" / "我有个 memory 写了 Z" 时, ' +
  '主动调这些查清楚再回. memory/ 是累积的偏好/决定/项目 anchor, 长期; ' +
  'session jsonl 是某天的完整对话, 适合查"那天具体说了什么".';

/**
 * Multi-turn conversational prompt — used by ConversationSession. This is the
 * product persona: an insight-driven creative-discussion partner that probes,
 * challenges, drives the conversation forward, and synthesizes — NOT a passive
 * note-taker. Replies in the user's language; voice-first so it stays spoken.
 */
export const CONVERSATION_SYSTEM_PROMPT =
  '你是 Beeni，一个洞察力很强的创意讨论伙伴。\n' +
  '用户在跟你实时语音聊想法 / 创意 / 方案。你的任务不是当记录员，而是帮他想得更深、更清楚、更往前。\n' +
  '用用户说话的语言回他（他中文你就中文，英文就英文）。\n' +
  '\n' +
  '你的性格（核心，比任何工具都重要）：\n' +
  '\n' +
  '1) 挖 —— 洞察 + 把信息挖出来\n' +
  '   - 用户抛个想法，别急着夸、也别急着执行。先看穿他真正想解决的是什么、卡在哪、有没有没说出口的前提或假设。\n' +
  '   - 主动问能挖出更多的关键问题——不是客套的"还有吗"，是"你说的 X 具体指谁 / 什么场景 / 为什么非它不可？"。\n' +
  '   - 一次只问最关键的一两个，留出让他接话的空间。\n' +
  '   - 如果用户导入了背景资料，先吃透它，基于它来挖和质疑，别问他资料里已经写清楚的东西。\n' +
  '\n' +
  '2) 质疑 —— 敢推回去\n' +
  '   - 看到盲点、漏洞、一厢情愿、逻辑跳跃，直接讲出来，并说清为什么。\n' +
  '   - 可以唱反调试探（"反过来想，如果 X 不成立呢？"），但目的是把想法磨好，不是为反对而反对——质疑完给个更好的方向。\n' +
  '   - 不奉承、不和稀泥。用户想浅了就说想浅了，但要善意、对事不对人。\n' +
  '\n' +
  '3) 推 —— 有推动力\n' +
  '   - 每一轮至少把讨论往前带一点：给个新角度、一种可能性、一个"那如果…呢"。\n' +
  '   - 别让讨论停在原地或绕圈。卡住了就主动甩两三个岔路让他选。\n' +
  '\n' +
  '4) 总结 —— 善于收口\n' +
  '   - 聊到一定程度主动归纳："所以现在我们其实在说…"、"你的核心其实是这三点…"。\n' +
  '   - 让用户随时看得见自己想到哪了。这些总结也正好是落到画板上的结构。\n' +
  '\n' +
  '怎么说话（这是语音对话）：\n' +
  '- 口语、自然、像真人。简洁但不寡言——该一针见血就一句话戳中，该展开就展开。\n' +
  '- 一次聚焦一两个点，别一口气倒一大堆。\n' +
  '- 诚实第一：不瞎编、不假装懂、拿不准就说拿不准。调工具前先用一句话说你要干啥（"我查下那个文件啊"）；工具失败把错误如实说出来，别装成功。\n' +
  '- 一轮里最多调 1-2 个工具，做完跟用户报告再决定下一步。\n' +
  '\n' +
  '画板 / 文档（你善于总结，讨论里冒出来的结构要落下来）：\n' +
  '- 用户可能绑了 1 个目标文档（写入）+ N 个参考文档（只读）。所有 update_doc / update_whiteboard 都打到目标文档，别乱建新文档。\n' +
  '- 画白板前必须先 fetch_whiteboard 看现状，再决定加节点 / 改 label / 重画——禁止盲写覆盖掉用户已有的东西。\n' +
  '- 用户说"建个画板 / 做个白板"等 → 用 create_doc：title 取个简短名，markdown 里嵌一个 mermaid 代码块（如 ```mermaid\\nflowchart TD\\n  A[开始] --> B[结束]\\n```），把返回的 doc_token 告诉用户。没绑 target 时直接建，别先问"要不要建"。\n' +
  '- 没有 whiteboard_token 时别调 update_whiteboard（会失败）。\n' +
  '\n' +
  '你的工具：search_repo / read_file（查本地资料）、create_doc / update_doc / fetch_doc（飞书文档）、update_whiteboard / fetch_whiteboard（飞书画板）、web_search（暂未启用，别用）。\n' +
  'search_repo 不传 dir 就默认搜配置的目标仓库（TARGET_REPO_DIR，未设则当前目录）。\n' +
  '用户如果说"我们之前聊过 X / 我有个笔记写了 Y"，可以用 memory / session 类工具查清楚再回，别凭印象编。';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface AgentRunStep {
  round: number;
  type: 'assistant_message' | 'tool_call' | 'tool_result';
  content?: string;
  tool_name?: string;
  tool_args?: any;
  tool_result?: any;
  raw?: any;
}

export interface AgentRunResult {
  finalText: string;
  rounds: number;
  steps: AgentRunStep[];
  messages: ChatMessage[];
}

export interface AgentRunOptions {
  prompt: string;
  systemPrompt?: string;
  model?: 'flash' | 'hard' | string;
  maxRounds?: number;
  onStep?: (step: AgentRunStep) => void;
  /** Inject prior messages for multi-turn use. Excludes system. */
  priorMessages?: ChatMessage[];
}

function resolveModel(m?: string): string {
  if (!m || m === 'flash') return DEFAULT_MODEL;
  if (m === 'hard') return HARD_MODEL;
  if (m === 'strongest') return STRONGEST_MODEL;
  return m;
}

// ── single-shot (legacy) ─────────────────────────────────────────────────────

async function callArk(model: string, messages: ChatMessage[]): Promise<any> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error('ARK_API_KEY not set in env');
  const body: Record<string, any> = {
    model,
    messages,
    tools: TOOL_SCHEMAS,
    tool_choice: 'auto',
    max_tokens: 2000,
    temperature: 0.5,
    stream: false,
  };
  const thinking = thinkingForModel(model);
  if (thinking) body.thinking = thinking;
  const res = await fetch(ARK_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ark HTTP ${res.status}: ${txt.slice(0, 800)}`);
  }
  return (await res.json()) as any;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const model = resolveModel(opts.model);
  const maxRounds = Math.max(1, Math.min(20, opts.maxRounds || MAX_ROUNDS_DEFAULT));
  const steps: AgentRunStep[] = [];

  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt || DEFAULT_SYSTEM_PROMPT },
  ];
  if (opts.priorMessages) {
    for (const m of opts.priorMessages) {
      if (m.role !== 'system') messages.push(m);
    }
  }
  messages.push({ role: 'user', content: opts.prompt });

  let lastAssistantText = '';

  for (let round = 1; round <= maxRounds; round++) {
    const response = await callArk(model, messages);
    const choice = response?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      throw new Error(`Ark returned no choices: ${JSON.stringify(response).slice(0, 400)}`);
    }
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    };
    messages.push(assistantMsg);

    if (msg.content) lastAssistantText = String(msg.content);

    const step: AgentRunStep = {
      round,
      type: 'assistant_message',
      content: msg.content || undefined,
      raw: { finish_reason: choice.finish_reason, tool_call_count: msg.tool_calls?.length || 0 },
    };
    steps.push(step);
    opts.onStep?.(step);

    const toolCalls = msg.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return {
        finalText: lastAssistantText || '',
        rounds: round,
        steps,
        messages,
      };
    }

    for (const call of toolCalls) {
      const fname = call.function?.name || 'unknown';
      let parsedArgs: any = {};
      try {
        parsedArgs = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        parsedArgs = { _raw: call.function?.arguments };
      }
      const callStep: AgentRunStep = {
        round,
        type: 'tool_call',
        tool_name: fname,
        tool_args: parsedArgs,
      };
      steps.push(callStep);
      opts.onStep?.(callStep);

      const result = await executeTool(fname, parsedArgs);

      const resultStep: AgentRunStep = {
        round,
        type: 'tool_result',
        tool_name: fname,
        tool_result: result,
      };
      steps.push(resultStep);
      opts.onStep?.(resultStep);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: fname,
        content: JSON.stringify(result).slice(0, 16_000),
      });
    }
  }

  return {
    finalText: lastAssistantText || '(max rounds reached without final answer)',
    rounds: maxRounds,
    steps,
    messages,
  };
}

// ── streaming + multi-turn session ───────────────────────────────────────────

interface StreamingToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argumentsBuf: string;
}

export interface SendTurnOptions {
  /** Called for each text token streamed by the model. */
  onAssistantToken?: (token: string) => void;
  /** Called when the model emits a fully-assembled tool_call (about to execute). */
  onToolCall?: (toolName: string, args: any) => void;
  /** Called after the tool finishes executing. */
  onToolResult?: (toolName: string, ok: boolean, summary: string, raw?: any) => void;
  /** Called once per assistant message (text content), even when followed by tool calls. */
  onAssistantMessage?: (text: string) => void;
  /**
   * Called whenever a `create_doc` tool returns successfully with a doc_token.
   * Receives the user-facing 飞书 URL so the host can auto-open it.
   */
  onDocCreated?: (docToken: string, url: string) => void;
  /** Abort signal — when fired mid-stream, the in-flight Ark call is aborted. */
  signal?: AbortSignal;
}

/**
 * Build the 飞书 docx URL for a doc_token. Pattern: `https://my.feishu.cn/docx/<token>`.
 * (lark-cli stores tenant-specific URLs but `my.feishu.cn` resolves to the
 * caller's default tenant via the 飞书 app's URL handler.)
 */
export function feishuDocUrl(docToken: string): string {
  return `https://my.feishu.cn/docx/${docToken}`;
}

export interface SendTurnResult {
  text: string;
  toolsUsed: string[];
  rounds: number;
  aborted: boolean;
}

/**
 * Stream a single Ark chat-completion call and accumulate the result.
 * Returns the assembled assistant message (text + tool_calls) and finish_reason.
 */
async function streamArkCall(
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  onToken: (token: string) => void,
): Promise<{ assistantMsg: ChatMessage; finishReason: string; aborted: boolean }> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error('ARK_API_KEY not set in env');

  const body: Record<string, any> = {
    model,
    messages,
    tools: TOOL_SCHEMAS,
    tool_choice: 'auto',
    max_tokens: 2000,
    temperature: 0.5,
    stream: true,
  };
  const thinking = thinkingForModel(model);
  if (thinking) body.thinking = thinking;

  const res = await fetch(ARK_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Ark HTTP ${res.status}: ${txt.slice(0, 800)}`);
  }
  if (!res.body) {
    throw new Error('Ark returned no body for stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let contentBuf = '';
  let finishReason = '';
  const toolAcc: Map<number, StreamingToolCallAccumulator> = new Map();
  let aborted = false;

  outer: while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err: any) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        aborted = true;
        break;
      }
      throw err;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    // SSE events split by blank line
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = rawEvent.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') break outer;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          contentBuf += delta.content;
          try {
            onToken(delta.content);
          } catch {}
        }
        const tcs = delta.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const i = typeof tc.index === 'number' ? tc.index : 0;
            let acc = toolAcc.get(i);
            if (!acc) {
              acc = { index: i, id: '', name: '', argumentsBuf: '' };
              toolAcc.set(i, acc);
            }
            if (tc.id) acc.id = tc.id;
            const fn = tc.function;
            if (fn) {
              if (typeof fn.name === 'string' && fn.name) acc.name = fn.name;
              if (typeof fn.arguments === 'string') acc.argumentsBuf += fn.arguments;
            }
          }
        }
      }
    }
  }

  try {
    reader.releaseLock();
  } catch {}

  const tool_calls = Array.from(toolAcc.values())
    .sort((a, b) => a.index - b.index)
    .map((a) => ({
      id: a.id || `call_${a.index}`,
      type: 'function' as const,
      function: { name: a.name, arguments: a.argumentsBuf || '{}' },
    }));

  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: contentBuf || null,
    tool_calls: tool_calls.length ? tool_calls : undefined,
  };

  return { assistantMsg, finishReason, aborted };
}

function summarizeToolResult(r: any): { ok: boolean; summary: string } {
  if (!r) return { ok: false, summary: 'no result' };
  if (r.error) return { ok: false, summary: String(r.error).slice(0, 240) };
  if (r.ok === false) return { ok: false, summary: r.note || r.error || 'failed' };
  if (typeof r === 'object') {
    if (r.doc_token) return { ok: true, summary: `doc 创建好了 (token=${String(r.doc_token).slice(0, 12)}...)` };
    if (typeof r.count === 'number') return { ok: true, summary: `搜到 ${r.count} 条` };
    if (r.returned_lines) return { ok: true, summary: `读了 ${r.returned_lines}/${r.total_lines} 行` };
    if (r.markdown) return { ok: true, summary: `拿到 markdown (${String(r.markdown).length} 字符)` };
    const keys = Object.keys(r).slice(0, 4).join(',');
    return { ok: true, summary: `ok (${keys})` };
  }
  return { ok: true, summary: String(r).slice(0, 200) };
}

/**
 * A bound 飞书 doc/whiteboard reference. `title` is optional human label that
 * Beeni can show to the user ("拉一下 spec.md" → matches a reference titled
 * "spec.md").
 */
export interface BoundDocRef {
  docToken: string;
  whiteboardToken?: string | null;
  title?: string | null;
}

/**
 * Stateful multi-turn conversation. One instance per WS connection / pill session.
 *
 * Multi-doc binding (Phase 4):
 *   - 0-1 *target* doc — all update_doc / update_whiteboard go here.
 *   - 0-N *reference* docs — Beeni can fetch_doc them but never write.
 *
 * Usage:
 *   const sess = new ConversationSession();
 *   sess.setBoundTarget({docToken:'X', whiteboardToken:'Y'});
 *   sess.addBoundReference({docToken:'A', title:'spec'});
 *   await sess.sendUserTurn('结合 spec 写到目标文档', { onAssistantToken, ... });
 *   sess.reset();
 */
export class ConversationSession {
  private messages: ChatMessage[];
  private model: string;
  private background = ''; // imported background material (paste/docs)
  private abortCtrl: AbortController | null = null;
  /** The single target doc — all writes go here. */
  public boundTarget: BoundDocRef | null = null;
  /** Read-only reference docs Beeni can fetch_doc to ground its answers. */
  public boundReferences: BoundDocRef[] = [];
  /** Bookkeeping: most-recent doc/whiteboard tokens Beeni created/wrote to. */
  public currentDocToken: string | null = null;
  public currentWhiteboardToken: string | null = null;
  public turnCount = 0;

  constructor(opts?: { systemPrompt?: string; model?: 'flash' | 'hard' | 'strongest' | string }) {
    // Default the creative-partner agent to the strongest model (intelligence
    // over latency). Callers can still override with 'flash'/'hard'.
    this.model = resolveModel(opts?.model || 'strongest');
    this.messages = [
      { role: 'system', content: opts?.systemPrompt || CONVERSATION_SYSTEM_PROMPT },
    ];
  }

  /** Set the imported background material (paste / uploaded docs). Injected as a
   *  second system message each turn — always current, never stored in history. */
  setBackground(text: string): void {
    this.background = (text || '').trim();
  }

  /** Messages actually sent to the model: history with the background block
   *  injected right after the system prompt (if any background is loaded). */
  private outgoingMessages(): ChatMessage[] {
    if (!this.background) return this.messages;
    const [sys, ...rest] = this.messages;
    const bg: ChatMessage = {
      role: 'system',
      content:
        '【背景资料】用户从别处导入了以下背景（可能是与其他 AI 的对话、文档或笔记），' +
        '讨论时请结合参考、可主动引用，但始终以用户当前说的话为准：\n\n' +
        this.background,
    };
    return [sys, bg, ...rest];
  }

  /** Whether a turn is currently in flight. */
  get isBusy(): boolean {
    return this.abortCtrl !== null;
  }

  /** Abort the in-flight turn (if any). Safe to call any time. */
  interrupt(): void {
    if (this.abortCtrl) {
      try {
        this.abortCtrl.abort();
      } catch {}
    }
  }

  /** Wipe history (back to just system prompt). Use when user dismisses pill. */
  reset(): void {
    this.interrupt();
    this.messages = [this.messages[0]];
    this.boundTarget = null;
    this.boundReferences = [];
    this.currentDocToken = null;
    this.currentWhiteboardToken = null;
    this.turnCount = 0;
  }

  // ── multi-doc binding ──────────────────────────────────────────────────

  /**
   * Set (or clear) the target doc. All update_doc / update_whiteboard go here.
   * Passing null clears the binding.
   */
  setBoundTarget(target: BoundDocRef | null): void {
    if (!target || !target.docToken) {
      this.boundTarget = null;
      this.currentDocToken = null;
      this.currentWhiteboardToken = null;
      this.injectBindingNotice('clear-target');
      return;
    }
    this.boundTarget = {
      docToken: String(target.docToken).trim(),
      whiteboardToken: target.whiteboardToken
        ? String(target.whiteboardToken).trim()
        : null,
      title: target.title ? String(target.title) : null,
    };
    this.currentDocToken = this.boundTarget.docToken;
    if (this.boundTarget.whiteboardToken) {
      this.currentWhiteboardToken = this.boundTarget.whiteboardToken;
    }
    this.injectBindingNotice('set-target');
  }

  addBoundReference(ref: BoundDocRef): void {
    if (!ref || !ref.docToken) return;
    const tok = String(ref.docToken).trim();
    // Dedupe.
    if (this.boundReferences.some((r) => r.docToken === tok)) return;
    this.boundReferences.push({
      docToken: tok,
      whiteboardToken: ref.whiteboardToken
        ? String(ref.whiteboardToken).trim()
        : null,
      title: ref.title ? String(ref.title) : null,
    });
    this.injectBindingNotice('add-reference');
  }

  removeBoundReference(docToken: string): boolean {
    const before = this.boundReferences.length;
    this.boundReferences = this.boundReferences.filter(
      (r) => r.docToken !== docToken,
    );
    if (this.boundReferences.length !== before) {
      this.injectBindingNotice('remove-reference');
      return true;
    }
    return false;
  }

  /**
   * Inject a SYSTEM message describing the current binding state. Idempotent
   * style: each call ADDS a fresh notice to the message tail so Beeni always
   * sees the latest config in the recent context.
   */
  private injectBindingNotice(reason: string): void {
    const lines: string[] = ['[SYSTEM] 文档绑定状态变更 (' + reason + '):'];
    if (this.boundTarget) {
      const t = this.boundTarget;
      const wb = t.whiteboardToken ? ` (whiteboardToken=${t.whiteboardToken})` : '';
      const title = t.title ? ` "${t.title}"` : '';
      lines.push(`- 🎯 目标文档 (所有写入打这里): docToken=${t.docToken}${wb}${title}`);
    } else {
      lines.push('- 🎯 目标文档: 无 (用户没绑, 写之前先问要不要新建)');
    }
    if (this.boundReferences.length > 0) {
      lines.push('- 📚 参考文档 (只读, 可 fetch_doc):');
      for (const r of this.boundReferences) {
        const wb = r.whiteboardToken ? ` (wb=${r.whiteboardToken})` : '';
        const title = r.title ? ` — "${r.title}"` : '';
        lines.push(`    - docToken=${r.docToken}${wb}${title}`);
      }
    } else {
      lines.push('- 📚 参考文档: 无');
    }
    lines.push('');
    lines.push(
      '提醒: 所有 update_doc / update_whiteboard 必须打到目标文档. ' +
        '画白板前必须先 fetch_whiteboard 看现状. ' +
        '写之前可以 fetch_doc 把参考文档拉过来当 ground truth.',
    );
    this.messages.push({ role: 'system', content: lines.join('\n') });
  }

  // ── back-compat shim ───────────────────────────────────────────────────

  /**
   * Legacy single-bind API (pre-Phase 4). Kept so existing callers / tests
   * continue working. Routes to setBoundTarget.
   * Pass empty string to clear.
   */
  setBoundDoc(docToken: string, whiteboardToken?: string | null): void {
    const tok = String(docToken || '').trim();
    if (!tok) {
      this.setBoundTarget(null);
      return;
    }
    this.setBoundTarget({
      docToken: tok,
      whiteboardToken: whiteboardToken || null,
    });
  }

  /** Read-only snapshot of message history (for debugging / persistence). */
  getMessages(): ReadonlyArray<ChatMessage> {
    return this.messages;
  }

  /**
   * Send one user turn and run the agent loop until either:
   *   - the assistant returns a plain text response (no tool calls)
   *   - MAX_ROUNDS_PER_TURN exhausted
   *   - signal aborts
   *
   * All streamed tokens fire onAssistantToken in real time so the caller can
   * pipe them to TTS. Tool calls fire onToolCall (before exec) + onToolResult
   * (after exec). On abort the partial assistant message is still appended
   * to history so the next turn has correct context.
   */
  async sendUserTurn(userText: string, options: SendTurnOptions = {}): Promise<SendTurnResult> {
    if (this.isBusy) {
      throw new Error('a turn is already in flight — call interrupt() first');
    }
    this.turnCount++;
    this.messages.push({ role: 'user', content: userText });
    const toolsUsed: string[] = [];
    let totalText = '';
    let rounds = 0;
    let aborted = false;

    this.abortCtrl = new AbortController();
    // Chain external signal if provided
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortCtrl.abort();
      } else {
        options.signal.addEventListener('abort', () => this.abortCtrl?.abort(), { once: true });
      }
    }

    try {
      for (let round = 1; round <= MAX_ROUNDS_PER_TURN; round++) {
        rounds = round;
        const { assistantMsg, finishReason, aborted: wasAborted } = await streamArkCall(
          this.model,
          this.outgoingMessages(),
          this.abortCtrl.signal,
          (tok) => options.onAssistantToken?.(tok),
        );

        // Always append the (possibly partial) assistant message to keep history coherent.
        this.messages.push(assistantMsg);

        if (typeof assistantMsg.content === 'string' && assistantMsg.content.length > 0) {
          totalText += (totalText ? '\n' : '') + assistantMsg.content;
          options.onAssistantMessage?.(assistantMsg.content);
        }

        if (wasAborted) {
          aborted = true;
          break;
        }

        const toolCalls = assistantMsg.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          // Done — natural finish (stop / length / etc.)
          break;
        }

        // Execute tool calls sequentially; append each result and loop.
        for (const call of toolCalls) {
          if (this.abortCtrl.signal.aborted) {
            aborted = true;
            break;
          }
          const fname = call.function?.name || 'unknown';
          let parsedArgs: any = {};
          try {
            parsedArgs = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            parsedArgs = { _raw: call.function?.arguments };
          }
          toolsUsed.push(fname);
          try {
            options.onToolCall?.(fname, parsedArgs);
          } catch {}

          const result = await executeTool(fname, parsedArgs);

          // Track lark tokens for stateful follow-up turns
          if (result && typeof result === 'object') {
            if (result.doc_token) {
              const tok = String(result.doc_token);
              this.currentDocToken = tok;
              // Auto-bind a freshly created doc as the target so subsequent
              // updates route to it.
              if (fname === 'create_doc' && !this.boundTarget) {
                this.setBoundTarget({
                  docToken: tok,
                  whiteboardToken: result.whiteboard_token
                    ? String(result.whiteboard_token)
                    : null,
                });
              }
              // Fire create_doc auto-open hook so the host (Electron / web)
              // can pop the new doc in 飞书 immediately.
              if (fname === 'create_doc') {
                try {
                  options.onDocCreated?.(tok, feishuDocUrl(tok));
                } catch {}
              }
            }
            if (result.whiteboard_token) this.currentWhiteboardToken = String(result.whiteboard_token);
          }

          const summary = summarizeToolResult(result);
          try {
            options.onToolResult?.(fname, summary.ok, summary.summary, result);
          } catch {}

          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: fname,
            content: JSON.stringify(result).slice(0, 16_000),
          });
        }

        if (aborted) break;
        if (finishReason === 'stop') break;
        // else (finish_reason='tool_calls') loop and let model continue
      }
    } finally {
      this.abortCtrl = null;
      // A turn interrupted mid-tool-call (user talks over Beeni) can leave the
      // trailing assistant message with tool_calls that have no matching tool
      // results. Replaying that on the next turn is a hard Ark 400 that bricks
      // the session. Backfill synthetic 'aborted' results so history stays valid.
      this.reconcileDanglingToolCalls();
    }

    return {
      text: totalText,
      toolsUsed,
      rounds,
      aborted,
    };
  }

  /**
   * Ark/OpenAI require every assistant message carrying N tool_calls to be
   * followed by N tool messages (one per tool_call_id). An interrupted turn can
   * leave the most-recent assistant message with unanswered tool_calls (aborted
   * mid-stream with a partial tool_calls array, or interrupted partway through
   * the tool-execution loop). Replaying that next turn is a hard 400 that bricks
   * the session until reset(). Backfill a synthetic 'aborted' tool result for
   * any tool_call_id that has no matching tool message.
   */
  private reconcileDanglingToolCalls(): void {
    const msgs = this.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'assistant') continue;
      const tcs = msgs[i].tool_calls;
      if (!tcs || tcs.length === 0) return; // last assistant had no tools → fine
      const answered = new Set<string>();
      for (let j = i + 1; j < msgs.length; j++) {
        const tj = msgs[j];
        if (tj.role === 'tool' && tj.tool_call_id) answered.add(tj.tool_call_id);
      }
      const missing = tcs.filter((tc) => !answered.has(tc.id));
      if (missing.length > 0) {
        // Insert right after the existing trailing tool messages for this turn.
        let insertAt = i + 1;
        while (insertAt < msgs.length && msgs[insertAt].role === 'tool') insertAt++;
        const synth: ChatMessage[] = missing.map((tc) => ({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function?.name,
          content: '{"error":"aborted"}',
        }));
        msgs.splice(insertAt, 0, ...synth);
      }
      return; // only the most-recent assistant message can dangle
    }
  }
}

// ── RecordingSession (Phase 4: 会议记录员模式) ─────────────────────────────

// Real-time whiteboard cadence (replaces the old 90s wall-clock timer):
//   - after a chunk arrives, wait DEBOUNCE_MS of quiet, then redraw, so the
//     board updates "as you finish a thought" (like someone writing it down);
//   - if the user talks nonstop, force a redraw every MAX_WAIT_MS so the board
//     never falls more than that far behind the conversation.
const DEFAULT_DEBOUNCE_MS = 2500;
const DEFAULT_MAX_WAIT_MS = 12_000;
const RECENT_WINDOW_MS = 3 * 60_000; // last 3 min of transcript per summary

export interface RecordingTranscriptChunk {
  ts: number;
  text: string;
}

export interface SummaryPushedEvent {
  whiteboardToken: string;
  changeNote: string;
  modelUsed: WhiteboardLlmChoice;
  latencyMs: number;
  mermaid: string;
}

export interface RecordingSessionOptions {
  /** Called when we successfully push a summary to the whiteboard. */
  onSummaryPushed?: (evt: SummaryPushedEvent) => void;
  /** Called when a summary cycle decides there's nothing structural to draw. */
  onSummarySkipped?: (reason: string, modelUsed: WhiteboardLlmChoice) => void;
  /** Called when a summary cycle errors (e.g. LLM down, whiteboard auth). */
  onSummaryError?: (err: Error) => void;
  /** Called every status tick (~10s) — pill can show "listening for 5 min · last summary 1 min ago". */
  onStatus?: (status: RecordingStatus) => void;
  /** Quiet window after the last transcript chunk before redrawing. Default 2.5s. */
  debounceMs?: number;
  /** Hard ceiling: force a redraw if the user talks nonstop this long. Default 12s. */
  maxWaitMs?: number;
  /** @deprecated kept for backward-compat; aliases debounceMs if set. */
  summaryIntervalMs?: number;
  /**
   * Injectable whiteboard push (for tests / alternate transports). Defaults to
   * the 飞书 CLI push (larkUpdateWhiteboard). A test can pass a stub to verify
   * the pipeline without a real board.
   */
  pushWhiteboard?: (whiteboardToken: string, mermaid: string) => Promise<void>;
}

export interface RecordingStatus {
  listening: boolean;
  startedAt: number;
  listeningMs: number;
  lastSummaryAt: number;
  bufferChunks: number;
  bufferChars: number;
  pendingSummary: boolean;
}

/**
 * RecordingSession — live whiteboard scribe.
 *
 * Feeds transcript chunks via addTranscript(); each chunk (re)arms a debounce,
 * so the bound whiteboard redraws shortly after you finish a thought — like
 * someone writing on a board while you talk. Trigger points:
 *   - debounce: DEBOUNCE_MS of quiet after the last chunk (with a MAX_WAIT_MS
 *     ceiling so nonstop talking still redraws periodically)
 *   - user prompt: triggerSummary({force:true, userHint}) for "总结一下"
 *
 * Used two ways:
 *   - recording mode (start()/stop()): mic stays open, Beeni silent (TTS off).
 *   - PTT live board: addTranscript() called per turn WITHOUT start(); the
 *     board updates in parallel with Beeni's spoken reply.
 *
 * Single-flight: only one summary runs at a time; transcript that arrives while
 * one is in flight marks the session dirty and re-fires when it finishes, so
 * the last burst before a pause is never dropped.
 */
export class RecordingSession {
  private transcriptChunks: RecordingTranscriptChunk[] = [];
  private startedAt = 0;
  private lastSummaryAt = 0;
  private pendingSummary: Promise<void> | null = null;
  private statusTimerHandle: NodeJS.Timeout | null = null;
  private debounceHandle: NodeJS.Timeout | null = null;
  private firstPendingAt = 0; // when the current un-summarized burst started
  private dirty = false; // transcript arrived while a summary was in flight
  private closed = false; // torn down (WS close) — no more redraws may schedule
  private pendingForce = false; // a forced/hinted summary requested mid-flight
  private pendingUserHint: string | null = null; // hint to carry into the re-fire
  private listening = false;
  private opts: RecordingSessionOptions;
  private pushFn: (whiteboardToken: string, mermaid: string) => Promise<void>;

  /** Bound state mirrored from the parent ConversationSession. */
  public targetDocToken: string | null = null;
  public targetWhiteboardToken: string | null = null;
  public targetDocTitle: string | null = null;
  /** Optional model choice override per call. */
  public modelChoice: WhiteboardLlmChoice | null = null;

  constructor(opts: RecordingSessionOptions = {}) {
    this.opts = opts;
    this.pushFn = opts.pushWhiteboard || larkUpdateWhiteboard;
  }

  setTarget(target: BoundDocRef | null): void {
    if (!target) {
      this.targetDocToken = null;
      this.targetWhiteboardToken = null;
      this.targetDocTitle = null;
      return;
    }
    this.targetDocToken = target.docToken || null;
    this.targetWhiteboardToken = target.whiteboardToken || null;
    this.targetDocTitle = target.title || null;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.startedAt = Date.now();
    this.lastSummaryAt = 0;
    // NB: we intentionally do NOT wipe transcriptChunks here — when a PTT
    // session is upgraded to recording mode on the same instance, the last few
    // minutes of context (recentChunks windows to 3 min anyway) should carry
    // over. The 30-min GC in addTranscript bounds growth.
    // No wall-clock summary timer anymore — redraws are transcript-driven
    // (debounce in addTranscript). Just keep the status ticker for the pill UI.
    this.statusTimerHandle = setInterval(() => {
      this.emitStatus();
    }, 10_000);
    this.emitStatus();
  }

  stop(): void {
    // Always cancel an armed debounce + burst clock, even for a PTT board scribe
    // that was never start()ed (listening stays false) — otherwise the timer
    // outlives the session and pushes to a dead board.
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    this.firstPendingAt = 0;
    if (!this.listening) return;
    this.listening = false;
    if (this.statusTimerHandle) {
      clearInterval(this.statusTimerHandle);
      this.statusTimerHandle = null;
    }
    this.emitStatus();
  }

  /** Tear down on WS close: cancel any armed redraw and block all future ones. */
  dispose(): void {
    this.closed = true;
    this.stop();
  }

  isListening(): boolean {
    return this.listening;
  }

  /**
   * Append a transcript chunk (called from the STT 'final' handler, or from the
   * PTT turn handler with the user's / Beeni's text). Each chunk re-arms the
   * debounce so the board redraws shortly after the talking pauses.
   */
  addTranscript(ts: number, text: string): void {
    const t = String(text || '').trim();
    if (!t) return;
    this.transcriptChunks.push({ ts: ts || Date.now(), text: t });
    // Garbage-collect chunks older than 30 min to avoid unbounded growth in
    // very long meetings — we never need older than that for any summary.
    const cutoff = Date.now() - 30 * 60_000;
    while (this.transcriptChunks.length > 0 && this.transcriptChunks[0].ts < cutoff) {
      this.transcriptChunks.shift();
    }
    this.scheduleDebouncedSummary();
  }

  /**
   * (Re)arm the debounce. Called on every new transcript chunk. Fires a summary
   * after a quiet window, or immediately once the current talking burst exceeds
   * the max-wait ceiling. No-op if no whiteboard is bound (nothing to draw to).
   */
  private scheduleDebouncedSummary(): void {
    if (this.closed) return; // session torn down — never schedule a redraw
    if (!this.targetWhiteboardToken) return; // no board bound — nothing to draw
    // If a summary is mid-flight, just mark dirty; we re-fire when it finishes
    // (trailing edge) so the burst that landed during it isn't dropped.
    if (this.pendingSummary) {
      this.dirty = true;
      return;
    }
    const debounceMs = this.opts.debounceMs ?? this.opts.summaryIntervalMs ?? DEFAULT_DEBOUNCE_MS;
    const maxWaitMs = this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const now = Date.now();
    if (this.firstPendingAt === 0) this.firstPendingAt = now;
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    const fire = () => {
      this.debounceHandle = null;
      this.firstPendingAt = 0;
      void this.triggerSummary({ force: false });
    };
    // Ceiling: nonstop talker — don't let the board fall further behind.
    if (now - this.firstPendingAt >= maxWaitMs) {
      fire();
      return;
    }
    this.debounceHandle = setTimeout(fire, debounceMs);
  }

  /**
   * Recent chunks within the rolling window (default last 3 min). For summary
   * triggers we feed this to the LLM, not the full buffer.
   */
  private recentChunks(): RecordingTranscriptChunk[] {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return this.transcriptChunks.filter((c) => c.ts >= cutoff);
  }

  /**
   * Trigger a summary cycle. If force=false (timer), let the LLM decide whether
   * to draw at all (it might output SKIP). If force=true (user said "总结一下"),
   * we still let it skip if nothing structural, but tone is "make best effort".
   */
  async triggerSummary(options: {
    force?: boolean;
    userPrompt?: string;
  } = {}): Promise<void> {
    if (this.pendingSummary) {
      // One at a time. If this is an EXPLICIT user request (force/hint), stash
      // it so the trailing-edge re-fire honors it — otherwise the user's
      // "总结一下" + its hint would be silently swallowed by the in-flight one.
      if (options.force || options.userPrompt) {
        this.pendingForce = true;
        if (options.userPrompt) this.pendingUserHint = options.userPrompt;
      }
      return this.pendingSummary;
    }
    if (this.closed) return; // torn down
    if (!this.targetWhiteboardToken) {
      this.opts.onSummaryError?.(
        new Error('triggerSummary: no targetWhiteboardToken bound — cannot push'),
      );
      return;
    }
    // We're firing now — cancel any armed debounce so it doesn't double-fire,
    // and reset the burst clock.
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    this.firstPendingAt = 0;
    const transcript = this.recentChunks()
      .map((c) => c.text)
      .join('\n');
    if (!transcript.trim() && !options.userPrompt) {
      // Nothing to summarize.
      return;
    }
    // Snapshot taken — anything that arrives from here marks us dirty for a
    // trailing re-fire after this summary completes.
    this.dirty = false;
    const wbToken = this.targetWhiteboardToken;
    const docToken = this.targetDocToken;
    const userHint = options.userPrompt
      ? options.userPrompt
      : options.force
        ? '用户主动请你总结. 请尽量画出当前讨论的核心结构。'
        : '';
    const promise = (async () => {
      try {
        await this.runStateMachineSummary({
          docToken: docToken || wbToken,
          wbToken,
          transcript,
          userHint,
        });
      } catch (err) {
        this.opts.onSummaryError?.(err as Error);
      } finally {
        this.emitStatus();
      }
    })();
    this.pendingSummary = promise;
    this.emitStatus();
    promise.finally(() => {
      this.pendingSummary = null;
      if (this.closed) return; // torn down mid-flight — don't re-arm anything
      // Trailing edge. An explicit forced/hinted request that collided with this
      // in-flight summary takes priority and re-fires WITH its hint; otherwise a
      // passive "transcript landed during the summary" redraw.
      if (this.pendingForce) {
        const hint = this.pendingUserHint;
        this.pendingForce = false;
        this.pendingUserHint = null;
        this.dirty = false;
        void this.triggerSummary({ force: true, userPrompt: hint ?? undefined });
      } else if (this.dirty) {
        this.dirty = false;
        this.scheduleDebouncedSummary();
      }
    });
    return promise;
  }

  /**
   * Phase 5 state-machine summary path:
   *  1) Load WhiteboardState from disk (per docToken)
   *  2) Ask LLM to propose transitions
   *  3) Validate + apply atomically + persist
   *  4) Render mermaid from new state + push to 飞书
   *  5) On parse failure → fallback to Phase 4 summarizeToMermaid once
   */
  private async runStateMachineSummary(args: {
    docToken: string;
    wbToken: string;
    transcript: string;
    userHint?: string;
  }): Promise<void> {
    const { docToken, wbToken, transcript, userHint } = args;
    const manager = getWhiteboardManager();
    const state = await manager.load(docToken, wbToken);
    let chosen: WhiteboardLlmChoice = this.modelChoice || 'doubao';

    // 1) Propose transitions
    let proposal: Awaited<ReturnType<typeof proposeTransitions>> | null = null;
    try {
      proposal = await proposeTransitions({
        state,
        transcript,
        userHint,
        docTitle: this.targetDocTitle || undefined,
        model: this.modelChoice || undefined,
      });
    } catch (err) {
      // Hard LLM failure — fallback to Phase 4 path so the user at least
      // gets *something* on the whiteboard rather than a stuck pill.
      console.warn(
        '[recording] proposeTransitions failed, falling back to summarizeToMermaid:',
        (err as Error).message,
      );
      await this.runLegacyMermaidFallback({ wbToken, transcript, userHint });
      return;
    }

    this.lastSummaryAt = Date.now();
    chosen = proposal.modelUsed;

    if (proposal.skipped || proposal.transitions.length === 0) {
      this.opts.onSummarySkipped?.(
        proposal.changeNote || '讨论无结构性进展, 跳过',
        proposal.modelUsed,
      );
      return;
    }

    // 2) Atomic apply + persist
    const turnId = `t${state.version + 1}-${Date.now()}`;
    const { state: nextState, results, reasons, appliedCount } = await manager.mutate(
      docToken,
      proposal.transitions,
      { turnId, byLLM: chosen },
      wbToken,
    );

    if (appliedCount === 0) {
      // Every transition was rejected — log + surface as skip so caller knows.
      const why = reasons.filter(Boolean).slice(0, 3).join(' | ');
      console.warn(
        `[recording] all ${proposal.transitions.length} transitions rejected:`,
        why,
      );
      this.opts.onSummarySkipped?.(`所有转移被拒绝: ${why}`, proposal.modelUsed);
      return;
    }

    // 3) Render mermaid from state + push to 飞书
    const mermaid = renderMermaid(nextState);
    try {
      await this.pushFn(wbToken, mermaid);
    } catch (err) {
      // Persisted state is still valid; just couldn't push. Surface the error.
      this.opts.onSummaryError?.(err as Error);
      return;
    }
    // Stamp the legacy mirror so fetch_whiteboard / future Phase 4 fallbacks
    // see fresh content.
    rememberWhiteboardMermaid(wbToken, mermaid);

    const rejectedCount = results.length - appliedCount;
    const note =
      rejectedCount > 0
        ? `${proposal.changeNote} (${appliedCount}/${results.length} 应用)`
        : proposal.changeNote;

    this.opts.onSummaryPushed?.({
      whiteboardToken: wbToken,
      changeNote: note,
      modelUsed: proposal.modelUsed,
      latencyMs: proposal.latencyMs,
      mermaid,
    });
  }

  /** Last-resort fallback when proposeTransitions throws (LLM down, JSON garbage). */
  private async runLegacyMermaidFallback(args: {
    wbToken: string;
    transcript: string;
    userHint?: string;
  }): Promise<void> {
    const { wbToken, transcript, userHint } = args;
    const current = recallWhiteboardMermaid(wbToken);
    const result = await summarizeToMermaid({
      transcript,
      currentWhiteboardMermaid: current,
      userHint: userHint || undefined,
      docTitle: this.targetDocTitle || undefined,
      model: this.modelChoice || undefined,
    });
    this.lastSummaryAt = Date.now();
    if (!result.mermaid) {
      this.opts.onSummarySkipped?.(
        result.changeNote || '无结构 (fallback)',
        result.modelUsed,
      );
      return;
    }
    await this.pushFn(wbToken, result.mermaid);
    rememberWhiteboardMermaid(wbToken, result.mermaid);
    this.opts.onSummaryPushed?.({
      whiteboardToken: wbToken,
      changeNote: `[fallback] ${result.changeNote}`,
      modelUsed: result.modelUsed,
      latencyMs: result.latencyMs,
      mermaid: result.mermaid,
    });
  }

  getStatus(): RecordingStatus {
    const now = Date.now();
    const bufferChars = this.transcriptChunks.reduce((a, c) => a + c.text.length, 0);
    return {
      listening: this.listening,
      startedAt: this.startedAt,
      listeningMs: this.listening ? now - this.startedAt : 0,
      lastSummaryAt: this.lastSummaryAt,
      bufferChunks: this.transcriptChunks.length,
      bufferChars,
      pendingSummary: this.pendingSummary !== null,
    };
  }

  private emitStatus(): void {
    try {
      this.opts.onStatus?.(this.getStatus());
    } catch {}
  }

  /** Read-only snapshot of buffered transcript (for debugging). */
  getTranscriptChunks(): ReadonlyArray<RecordingTranscriptChunk> {
    return this.transcriptChunks;
  }
}
