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
 *   Default model: doubao-seed-1-6-flash-250828
 *   Hard model:    doubao-seed-1-6-250615
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
const MAX_ROUNDS_DEFAULT = 10;
const MAX_ROUNDS_PER_TURN = 6; // session: smaller per-turn budget; user can ask more

export const DEFAULT_SYSTEM_PROMPT =
  '你是一个写文档的助手, 名字叫 Beeni. 你帮 founder 调研 + 写飞书文档 + 画 mermaid 白板. ' +
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
  '你能查 founder 跟 Claude Code 之间的历史:\n' +
  '- list_memory_anchors(topic?): 看有哪些累积记忆主题\n' +
  '- read_memory_anchor(filename): 读某个具体 anchor (e.g. "feedback_jargon_replacement_table.md")\n' +
  '- search_memory_anchors(query, topK?): 关键词搜所有 anchor\n' +
  '- list_sessions(limit?): 看最近的 Claude Code session\n' +
  '- search_session(query, sessionId?, topK?): 在过去对话里搜内容\n' +
  '- read_session_recent(sessionId, lastN?): 读某 session 最后 N 轮\n' +
  'founder 说 "我们之前讨论过 X" / "上周聊到 Y" / "我有个 memory 写了 Z" 时, ' +
  '主动调这些查清楚再回. memory/ 是累积的偏好/决定/项目 anchor, 长期; ' +
  'session jsonl 是某天的完整对话, 适合查"那天具体说了什么".';

/**
 * Multi-turn conversational prompt — used by ConversationSession.
 * Different tone than DEFAULT_SYSTEM_PROMPT: emphasizes thinking-out-loud,
 * smaller tool batches, and "ask before assume".
 */
export const CONVERSATION_SYSTEM_PROMPT =
  '你是 Beeni, founder 的写文档伙伴。\n' +
  '你跟 founder 实时对话 — 他说一段, 你帮他梳理 / 调研 / 写飞书文档 / 画白板。\n' +
  '\n' +
  '重要规则:\n' +
  '- 边想边说 — 调工具前先告诉 founder "等下我查一下 X..." 或 "我先看看那个文件"\n' +
  '- 不要一次性跑很多 tool, 一次最多 1-2 个, 然后跟 founder 报告再决定下一步\n' +
  '- 短句, 像跟朋友聊, 不要长篇大论\n' +
  '- 不知道用户要什么就先问, 不要瞎写一通\n' +
  '- 工具失败把错误原文告诉 founder, 不要装作成功\n' +
  '\n' +
  '文档绑定纪律 (核心):\n' +
  '- 用户可能绑了 1 个**目标文档** (写入) + N 个**参考文档** (只读).\n' +
  '- 所有 update_doc / update_whiteboard 必须打到目标文档, 别乱建新文档.\n' +
  '- 写之前可以 fetch_doc 把参考文档拉过来当 ground truth, 别凭空写.\n' +
  '- **画白板前必须先 fetch_whiteboard** 看现状, 决定是加节点 / 改 label / 重画.\n' +
  '  禁止盲写白板 — 那会把 founder 之前画的全覆盖掉。\n' +
  '\n' +
  '你的工具:\n' +
  '- search_repo / read_file: 调研 founder 的代码\n' +
  '- web_search: 调研外部信息 (目前是 stub, 不要用)\n' +
  '- create_doc / update_doc / fetch_doc: 写 + 读飞书文档\n' +
  '- update_whiteboard / fetch_whiteboard: 写 + 读飞书白板\n' +
  '- list_memory_anchors / read_memory_anchor / search_memory_anchors: 查 founder 跨 session 累积的偏好 / 决定 / 项目 anchor (~131 篇 .md)\n' +
  '- list_sessions / search_session / read_session_recent: 查过往 Claude Code terminal session 完整对话 jsonl\n' +
  '\n' +
  '⭐ 建画板 / 建白板 / 做画板 任务规则 (核心):\n' +
  '- 用户说"建一个画板" / "做一个白板" / "新建画板" 等 → **必须用 create_doc** 工具:\n' +
  '    1) title 取一个简短的描述名 (e.g. "新画板", "讨论笔记")\n' +
  '    2) markdown 内容里**嵌入一个 mermaid 代码块** (e.g. ```mermaid\\nflowchart TD\\n  A[开始] --> B[结束]\\n```)\n' +
  '    3) create_doc 返回 doc_token + whiteboard_token (内嵌白板). Beeni 把 doc_token 告诉用户即可.\n' +
  '- 没绑 target 文档 + 用户说"建/做/写"类动作 → 直接 create_doc 新建, 不要先问 "要不要建", 直接做.\n' +
  '- 不要在没有 whiteboard_token 的情况下调 update_whiteboard — 那只会失败.\n' +
  '\n' +
  'founder 说 "我们之前讨论过 X" / "上周聊到 Y" / "我有个 memory 写了 Z" 时, 主动查清楚再回, 不要凭印象.\n' +
  '区分: memory anchor = 长期累积偏好/决定, session jsonl = 某天具体对话.\n' +
  '注意 anchor 数据是 founder 跟 Claude Code (终端) 的, 不是 app 的用户数据.\n' +
  '\n' +
  '仓库地址: search_repo 不传 dir 就默认搜配置好的目标仓库 ' +
  '(通过 TARGET_REPO_DIR 环境变量设置, 未设置则是当前工作目录).';

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
  return m;
}

// ── single-shot (legacy) ─────────────────────────────────────────────────────

async function callArk(model: string, messages: ChatMessage[]): Promise<any> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error('ARK_API_KEY not set in env');
  const body = {
    model,
    messages,
    tools: TOOL_SCHEMAS,
    tool_choice: 'auto',
    max_tokens: 2000,
    temperature: 0.5,
    stream: false,
  };
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

  const body = {
    model,
    messages,
    tools: TOOL_SCHEMAS,
    tool_choice: 'auto',
    max_tokens: 2000,
    temperature: 0.5,
    stream: true,
  };

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
  private abortCtrl: AbortController | null = null;
  /** The single target doc — all writes go here. */
  public boundTarget: BoundDocRef | null = null;
  /** Read-only reference docs Beeni can fetch_doc to ground its answers. */
  public boundReferences: BoundDocRef[] = [];
  /** Bookkeeping: most-recent doc/whiteboard tokens Beeni created/wrote to. */
  public currentDocToken: string | null = null;
  public currentWhiteboardToken: string | null = null;
  public turnCount = 0;

  constructor(opts?: { systemPrompt?: string; model?: 'flash' | 'hard' | string }) {
    this.model = resolveModel(opts?.model);
    this.messages = [
      { role: 'system', content: opts?.systemPrompt || CONVERSATION_SYSTEM_PROMPT },
    ];
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
          this.messages,
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
    }

    return {
      text: totalText,
      toolsUsed,
      rounds,
      aborted,
    };
  }
}

// ── RecordingSession (Phase 4: 会议记录员模式) ─────────────────────────────

const DEFAULT_SUMMARY_INTERVAL_MS = 90_000; // 90s timer
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
  /** Interval between auto-summary attempts. Default 90s. */
  summaryIntervalMs?: number;
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
 * RecordingSession — 会议记录员模式.
 *
 * Mic stays open; client VAD-segments and feeds transcript chunks via
 * addTranscript(). Two trigger points push summaries to the bound target
 * whiteboard:
 *   - timer: every summaryIntervalMs (default 90s), summarize last ~3 min
 *   - user prompt: triggerSummary({force:true, userHint}) for "总结一下"
 *
 * Beeni stays silent in this mode (TTS off) — only visual whiteboard updates,
 * no voice-back so it doesn't interrupt the human meeting.
 */
export class RecordingSession {
  private transcriptChunks: RecordingTranscriptChunk[] = [];
  private startedAt = 0;
  private lastSummaryAt = 0;
  private pendingSummary: Promise<void> | null = null;
  private timerHandle: NodeJS.Timeout | null = null;
  private statusTimerHandle: NodeJS.Timeout | null = null;
  private listening = false;
  private opts: RecordingSessionOptions;

  /** Bound state mirrored from the parent ConversationSession. */
  public targetDocToken: string | null = null;
  public targetWhiteboardToken: string | null = null;
  public targetDocTitle: string | null = null;
  /** Optional model choice override per call. */
  public modelChoice: WhiteboardLlmChoice | null = null;

  constructor(opts: RecordingSessionOptions = {}) {
    this.opts = opts;
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
    this.transcriptChunks = [];
    this.lastSummaryAt = 0;
    const intervalMs = this.opts.summaryIntervalMs || DEFAULT_SUMMARY_INTERVAL_MS;
    this.timerHandle = setInterval(() => {
      // Don't trigger if buffer is empty (no one's talking) — skip silently.
      if (this.transcriptChunks.length === 0) return;
      // Don't trigger if we just summarized (e.g. user-triggered <15s ago).
      const sinceLast = Date.now() - this.lastSummaryAt;
      if (this.lastSummaryAt > 0 && sinceLast < 15_000) return;
      void this.triggerSummary({ force: false });
    }, intervalMs);
    // Status ticker — 10s.
    this.statusTimerHandle = setInterval(() => {
      this.emitStatus();
    }, 10_000);
    // Immediate status emit on start.
    this.emitStatus();
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.statusTimerHandle) {
      clearInterval(this.statusTimerHandle);
      this.statusTimerHandle = null;
    }
    this.emitStatus();
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Append a transcript chunk (called from STT 'final' handler in WS server). */
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
      // One at a time. The new request can race in next interval.
      return this.pendingSummary;
    }
    if (!this.targetWhiteboardToken) {
      this.opts.onSummaryError?.(
        new Error('triggerSummary: no targetWhiteboardToken bound — cannot push'),
      );
      return;
    }
    const transcript = this.recentChunks()
      .map((c) => c.text)
      .join('\n');
    if (!transcript.trim() && !options.userPrompt) {
      // Nothing to summarize.
      return;
    }
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
      // Hard LLM failure — fallback to Phase 4 path so the founder at least
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
      await larkUpdateWhiteboard(wbToken, mermaid);
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
    await larkUpdateWhiteboard(wbToken, result.mermaid);
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
