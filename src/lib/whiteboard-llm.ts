/**
 * whiteboard-llm.ts — LLM layer for whiteboard state machine.
 *
 * Phase 5 paradigm shift:
 *   - OLD (Phase 4): LLM outputs full mermaid every turn → drifts over 10+ rounds
 *   - NEW (Phase 5): LLM proposes STATE TRANSITIONS (add_node / resolve_question /
 *     update_status / ...) and the server applies them to a persisted state.
 *
 * Why: 白板永远不漂。Mermaid is rendered deterministically from state.
 * The LLM never sees nor writes mermaid — only the structured state digest.
 *
 * Backward-compat: `summarizeToMermaid` is kept for the Phase 4 fallback
 * path when transition parsing fails (e.g. LLM returns garbage JSON).
 *
 * Model (consolidated to Doubao — 2026-06-25):
 *   - Doubao Seed 2.0 Mini (`doubao-seed-2-0-pro` family, fast variant). The
 *     proposer emits constrained delta-transitions, so a fast model keeps the
 *     whiteboard real-time (~1.5s/call, verified) — the heavy reasoning lives
 *     in the conversational agent, not here. Override via env DOUBAO_WB_MODEL.
 *   - The old Gemini-flash fallback was removed during the all-Doubao swap.
 */

import type { WhiteboardState, WBTransition, WhiteboardKind } from './whiteboard-state';
import { renderStateDigest } from './whiteboard-render';

const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
// Fast Seed 2.0 model — keeps the live whiteboard responsive as the user talks.
const DOUBAO_WHITEBOARD_MODEL = process.env.DOUBAO_WB_MODEL || 'doubao-seed-2-0-mini-260215';
// Validate the thinking override so an env typo can't silently re-enable the
// 45-77s deep-think (which would kill the real-time board) or error the request.
const WB_THINKING_TYPE = (() => {
  const v = (process.env.DOUBAO_WB_THINKING || 'disabled').toLowerCase();
  return ['disabled', 'enabled', 'auto'].includes(v) ? v : 'disabled';
})();

// Kept as a single-member union so existing callers/types stay valid after the
// Gemini removal; 'doubao' is now the only choice.
export type WhiteboardLlmChoice = 'doubao';

// ── Common types ────────────────────────────────────────────────────────────

export interface SummarizeOptions {
  /** Raw transcript / discussion chunks accumulated since last summary. */
  transcript: string;
  /** Optional: legacy — current whiteboard mermaid (Phase 4 fallback only). */
  currentWhiteboardMermaid?: string | null;
  /** Optional: user prompt (e.g. "总结一下" or "把刚才的画出来"). */
  userHint?: string;
  /** Optional: force a particular LLM (overrides env). */
  model?: WhiteboardLlmChoice;
  /** Optional: target doc title for context. */
  docTitle?: string;
}

export interface SummarizeResult {
  mermaid: string | null;
  changeNote: string;
  modelUsed: WhiteboardLlmChoice;
  latencyMs: number;
  rawText: string;
}

// ── Phase 5 transition-proposal types ────────────────────────────────────────

export interface ProposeOptions {
  state: WhiteboardState;
  transcript: string;
  userHint?: string;
  model?: WhiteboardLlmChoice;
  docTitle?: string;
}

export interface ProposeResult {
  transitions: WBTransition[];
  changeNote: string;
  modelUsed: WhiteboardLlmChoice;
  latencyMs: number;
  rawText: string;
  /** True if LLM judged the discussion has no structural progress (empty transitions). */
  skipped: boolean;
}

// ── System prompt (Phase 5 — state-machine semantics) ────────────────────────

const TRANSITION_SYSTEM_PROMPT = `你是白板状态机的"提议者", 不是 mermaid 画家。
白板已经是一个持久化状态: { nodes, edges, subgraphs, history, kind }.
你的工作: 看新讨论, 输出 0-5 个**状态转移指令** (transitions), server 会原子 apply 并自动重新渲染。
你**永远不**输出 mermaid 源码。

可选的 action (严格按 JSON 输出):

1. add_node — 加新节点
   { "action": "add_node", "node": {
       "id"?: "可选, 不给则 server 自动生成 (Q1/A1/N1)",
       "kind": "topic" | "question" | "decision" | "note",
       "label": "≤ 8 个汉字 / ≤ 12 ASCII",
       "status": "pending" | "active" | "decided" | "done",
       "parentId"?: "可选, 给则建父子关系 (mindmap 用)",
       "subgraphId"?: "可选, 加入指定 subgraph"
   }}

2. add_edge — 加连线
   { "action": "add_edge", "edge": {
       "from": "节点 id", "to": "节点 id",
       "label"?: "可选边标签", "kind"?: "flow" | "resolves" | "depends"
   }}

3. resolve_question — 把 pending 问题标为已决议 (最常用!)
   { "action": "resolve_question",
       "questionId": "现存的 question 节点 id",
       "conclusion": "决议内容 ≤ 8 字",
       "resolvedById": "决议节点 id (不存在 server 会创建为 decision 节点)"
   }

4. update_status — 改节点状态 (active → done / pending → decided)
   { "action": "update_status", "nodeId": "...", "status": "done" }

5. relabel — 改文字
   { "action": "relabel", "nodeId": "...", "newLabel": "..." }

6. add_subgraph — 加新分组 (subgraph / 泳道)
   { "action": "add_subgraph", "subgraph": {
       "id": "sg1", "label": "前端", "nodeIds": ["N3","N5"]
   }}

7. remove_node — 删节点 (慎用)
   { "action": "remove_node", "nodeId": "..." }

8. change_kind — 改图类型 (慎用! 只有讨论完全转向才用)
   { "action": "change_kind", "newKind": "flowchart" | "mindmap" | "sequence" | "gantt" | "quadrant" | "state" }

硬规则:
- 看清现有 state 里的 pending questions, 决议过的别再加重复 question
- 用现有 node id (Q1/A2/N3) 引用现存节点, 别瞎编 id (server 会拒绝)
- 如果新讨论 resolve 了某个 pending Q, **优先用 resolve_question** 一步搞定 (它会自动建 decision 节点 + 连线)
- 如果讨论冒出新问题, 加 add_node kind='question' status='pending'
- 如果讨论开启新话题但无明显结构, 加 add_node kind='topic' status='active'
- 一次最多 5 个 transitions (太多说明你想做太多 — 拆几轮)
- 如果新讨论无结构性进展 (闲聊 / 重复 / 离题), 输出空数组 [] — server 会跳过

输出格式严格如下 (纯 JSON, 不要 markdown 包裹, 不要解释):
{
  "change_note": "一句话描述这次更新干啥 ≤ 20 字",
  "transitions": [
    { "action": "...", ... },
    ...
  ]
}

few-shot:

[当前 state]:
[白板状态] kind=flowchart version=2 nodes=2 edges=1
讨论主题:
  - N1: onboarding [active]
  - N2: 注册流程 [active]
连线:
  - N1 → N2

[新讨论]: "注册完了申请麦克风权限, 第三步做 intake. 这条路定了, 别改了。"

[输出]:
{"change_note":"补完 onboarding 三步","transitions":[
  {"action":"add_node","node":{"id":"N3","kind":"topic","label":"麦克风权限","status":"active"}},
  {"action":"add_node","node":{"id":"N4","kind":"topic","label":"intake","status":"active"}},
  {"action":"add_edge","edge":{"from":"N2","to":"N3"}},
  {"action":"add_edge","edge":{"from":"N3","to":"N4"}},
  {"action":"update_status","nodeId":"N1","status":"decided"}
]}

[当前 state]:
[白板状态] kind=flowchart version=3 nodes=3 edges=2
未决问题:
  - Q1: 用 Doubao 还是 Gemini?

[新讨论]: "Q1 我决定了, 用 Doubao reasoning, 质量高时间换不亏。"

[输出]:
{"change_note":"决议 Q1 选 Doubao","transitions":[
  {"action":"resolve_question","questionId":"Q1","conclusion":"用 Doubao","resolvedById":"A1"}
]}

[当前 state]:
[白板状态] kind=flowchart version=5 nodes=4 edges=3

[新讨论]: "嗯, 我也不知道, 反正就是, 那个那个... 我先去倒杯水"

[输出]:
{"change_note":"讨论无结构, 跳过","transitions":[]}
`;

// ── LLM callers ──────────────────────────────────────────────────────────────

async function callDoubaoReasoning(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) throw new Error('ARK_API_KEY not set');
  const body = {
    model: DOUBAO_WHITEBOARD_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1500,
    stream: false,
    // CRITICAL for real-time: Seed 2.0 otherwise deep-thinks on this structured
    // task (~45-77s/call, measured). The proposer follows a detailed few-shot
    // prompt to emit constrained JSON transitions — it doesn't need chain-of-
    // thought. Disabling thinking drops it to a few seconds so the board keeps
    // pace with speech. Override via DOUBAO_WB_THINKING if you ever want it.
    thinking: { type: WB_THINKING_TYPE },
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
    throw new Error(`Doubao HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const json: any = await res.json();
  const text = json?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Doubao returned empty content');
  return String(text);
}

function resolveModelChoice(_explicit?: WhiteboardLlmChoice): WhiteboardLlmChoice {
  return 'doubao';
}

// ── Transition JSON parser ──────────────────────────────────────────────────

/**
 * Find the first balanced JSON object in `raw` and parse it. LLMs sometimes
 * wrap output in prose despite "no markdown" instruction; we tolerate.
 */
function extractJson(raw: string): any | null {
  const trimmed = raw.trim();
  // direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}
  // strip ``` fences
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }
  // scan for {...}
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  for (let end = trimmed.length; end > start; end--) {
    const slice = trimmed.slice(start, end);
    try {
      return JSON.parse(slice);
    } catch {}
  }
  return null;
}

const VALID_ACTIONS = new Set([
  'add_node',
  'add_edge',
  'add_subgraph',
  'resolve_question',
  'update_status',
  'relabel',
  'remove_node',
  'remove_edge',
  'change_kind',
]);

/**
 * Validate + normalize a parsed transition array. Drops invalid entries.
 * Returns {transitions, dropped} where dropped is a count for monitoring.
 */
export function validateTransitions(raw: any): {
  transitions: WBTransition[];
  dropped: number;
  reasons: string[];
} {
  if (!Array.isArray(raw)) return { transitions: [], dropped: 0, reasons: [] };
  const out: WBTransition[] = [];
  const reasons: string[] = [];
  let dropped = 0;
  for (const t of raw) {
    if (!t || typeof t !== 'object' || typeof t.action !== 'string') {
      dropped++;
      reasons.push('non-object transition');
      continue;
    }
    if (!VALID_ACTIONS.has(t.action)) {
      dropped++;
      reasons.push(`bad action: ${t.action}`);
      continue;
    }
    // Best-effort shape check per action; deeper validation is in applyTransition.
    out.push(t as WBTransition);
  }
  return { transitions: out, dropped, reasons };
}

/**
 * Phase 5 primary entry point — propose transitions based on current state
 * and new discussion. Caller (server) is responsible for applying them via
 * WhiteboardManager.mutate().
 */
export async function proposeTransitions(opts: ProposeOptions): Promise<ProposeResult> {
  const choice = resolveModelChoice(opts.model);
  const digest = renderStateDigest(opts.state);
  const lines: string[] = [];
  if (opts.docTitle) lines.push(`[文档标题]: ${opts.docTitle}`);
  lines.push(`[当前 state]:\n${digest}`);
  if (opts.userHint) lines.push(`[用户指示]: ${opts.userHint}`);
  lines.push(`[新讨论]:\n${opts.transcript.trim().slice(0, 6000)}`);
  const userMessage = lines.join('\n\n');

  const t0 = Date.now();
  const used: WhiteboardLlmChoice = choice;
  const rawText = await callOnce(choice, TRANSITION_SYSTEM_PROMPT, userMessage);
  const latencyMs = Date.now() - t0;
  const parsed = extractJson(rawText);
  let transitions: WBTransition[] = [];
  // Start empty so the skip/applied fallbacks below actually fire when the LLM
  // omits change_note — otherwise a skip would be mislabeled "已更新白板".
  let changeNote = '';
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.change_note === 'string') changeNote = parsed.change_note.trim().slice(0, 80);
    const arr = Array.isArray(parsed.transitions) ? parsed.transitions : [];
    const validated = validateTransitions(arr);
    transitions = validated.transitions;
  }
  const skipped = transitions.length === 0;
  if (skipped) {
    changeNote = changeNote || '讨论无结构性进展, 跳过';
  } else {
    changeNote = changeNote || '已更新白板';
  }
  return {
    transitions,
    changeNote,
    modelUsed: used,
    latencyMs,
    rawText,
    skipped,
  };
}

async function callOnce(
  _choice: WhiteboardLlmChoice,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  return callDoubaoReasoning(systemPrompt, userMessage);
}

// ── Phase 4 backward-compat: summarizeToMermaid ─────────────────────────────
// Kept so the fallback path (Phase 5 transition parse failed) can still push
// something to the whiteboard. Not used by the new state-machine path.

const LEGACY_MERMAID_SYSTEM_PROMPT = `你是白板战略家, 不是会议秘书。
- 你不写 paragraphs, 你画 visual structure (节点 + 边)
- 你输出完整 mermaid 源码 (lark-cli 不支持局部 patch)

挑 visual 类型 (按讨论内容决定, 不是默认 flowchart):
- 一步步流程 / 系统架构 → flowchart (LR 或 TD)
- 头脑风暴 / 概念发散 / 分类 → mindmap
- 谁跟谁交互 / API 顺序 → sequenceDiagram
- 时间线 / 排期 → gantt
- 比较选项 / 二维定位 → quadrantChart
- 状态机 → stateDiagram-v2

硬规则:
1. 节点 label ≤ 8 个汉字
2. 一次只输出一个 mermaid 图
3. 如果讨论混乱无明显结构, 输出 SKIP (大写)
4. 给了"当前白板" 优先在它基础上**增量**修改
5. 输出格式严格如下:
[CHANGE_NOTE]: 一句话描述 ≤ 20 字
[MERMAID_START]
<mermaid 源码>
[MERMAID_END]
或:
[CHANGE_NOTE]: 讨论无明显结构, 跳过
[SKIP]
`;

function parseLegacyOutput(raw: string): { mermaid: string | null; changeNote: string } {
  const noteMatch = raw.match(/\[CHANGE_NOTE\][:：]\s*(.+?)(?:\n|$)/);
  const changeNote = noteMatch ? noteMatch[1].trim().slice(0, 80) : '已更新白板';
  if (/\[SKIP\]/i.test(raw)) return { mermaid: null, changeNote };
  const startIdx = raw.indexOf('[MERMAID_START]');
  const endIdx = raw.indexOf('[MERMAID_END]');
  let mermaid: string | null = null;
  if (startIdx >= 0 && endIdx > startIdx) {
    mermaid = raw.slice(startIdx + '[MERMAID_START]'.length, endIdx).trim();
  } else {
    const fence = raw.match(/```(?:mermaid)?\s*([\s\S]*?)```/);
    if (fence) mermaid = fence[1].trim();
  }
  if (mermaid) {
    mermaid = mermaid.replace(/^```(?:mermaid)?\s*/, '').replace(/```\s*$/, '').trim();
    if (!mermaid) mermaid = null;
  }
  return { mermaid, changeNote };
}

function buildLegacyUserMessage(opts: SummarizeOptions): string {
  const parts: string[] = [];
  if (opts.docTitle) parts.push(`[文档标题]: ${opts.docTitle}`);
  if (opts.userHint) parts.push(`[用户指示]: ${opts.userHint}`);
  if (opts.currentWhiteboardMermaid && opts.currentWhiteboardMermaid.trim()) {
    parts.push(
      `[当前白板 mermaid]:\n\`\`\`\n${opts.currentWhiteboardMermaid.trim()}\n\`\`\``,
    );
    parts.push('请在此基础上**增量**修改, 不要每次重画。');
  }
  parts.push(`[讨论 transcript]:\n${opts.transcript.trim().slice(0, 8000)}`);
  return parts.join('\n\n');
}

/**
 * Phase 4 fallback (kept). Returns mermaid source directly. NOT the primary
 * path in Phase 5 — only used when proposeTransitions parse fails N times.
 */
export async function summarizeToMermaid(
  opts: SummarizeOptions,
): Promise<SummarizeResult> {
  const choice = resolveModelChoice(opts.model);
  const userMessage = buildLegacyUserMessage(opts);
  const t0 = Date.now();
  const used: WhiteboardLlmChoice = choice;
  const rawText = await callOnce(choice, LEGACY_MERMAID_SYSTEM_PROMPT, userMessage);
  const latencyMs = Date.now() - t0;
  const parsed = parseLegacyOutput(rawText);
  return {
    mermaid: parsed.mermaid,
    changeNote: parsed.changeNote,
    modelUsed: used,
    latencyMs,
    rawText,
  };
}

// ── Legacy in-memory mirror (Phase 4) ────────────────────────────────────────
// Still used by tools.ts (fetch_whiteboard reads it). In Phase 5 the
// WhiteboardManager state is the authoritative source; this mirror gets
// stamped after every successful push so legacy callers keep working.

const whiteboardMirror = new Map<string, { mermaid: string; updatedAt: number }>();

export function rememberWhiteboardMermaid(token: string, mermaid: string): void {
  if (!token || !mermaid) return;
  whiteboardMirror.set(token, { mermaid, updatedAt: Date.now() });
}

export function recallWhiteboardMermaid(token: string): string | null {
  const entry = whiteboardMirror.get(token);
  if (!entry) return null;
  return entry.mermaid;
}

export function whiteboardMirrorStatus(token: string): {
  has: boolean;
  updatedAt: number | null;
} {
  const entry = whiteboardMirror.get(token);
  return entry ? { has: true, updatedAt: entry.updatedAt } : { has: false, updatedAt: null };
}
