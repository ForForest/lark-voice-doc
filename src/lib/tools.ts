/**
 * tools.ts — Doubao (OpenAI function-calling spec) tool definitions + executor.
 *
 * Doubao Ark API speaks the OpenAI Chat Completions format, including the
 * `tools` array of {type:'function', function:{name, description, parameters}}.
 * After a tool call, we run the function locally, append a
 * `{role:'tool', tool_call_id, content: <JSON-stringified result>}` message,
 * and re-invoke the model.
 *
 * Safety:
 *  - read_file refuses absolute paths outside the user's home directory and
 *    refuses paths containing `..`. (search_repo grep is restricted to the
 *    configured target repo by default but accepts a `dir` param.)
 *  - All filesystem reads are READ-ONLY across the project boundary. We never
 *    mutate the target repo.
 *
 * Configuration:
 *  - TARGET_REPO_DIR — the default directory search_repo searches when no `dir`
 *    is given. Defaults to the current working directory if unset.
 */

import { exec, ExecOptions } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  larkCreateDoc,
  larkUpdateDoc,
  larkUpdateWhiteboard,
  larkFetchDoc,
  larkFetchWhiteboardBestEffort,
} from './lark';
import {
  rememberWhiteboardMermaid,
  recallWhiteboardMermaid,
  whiteboardMirrorStatus,
} from './whiteboard-llm';
import {
  listMemoryAnchors,
  readMemoryAnchor,
  searchMemoryAnchors,
  listSessions,
  searchSession,
  readSessionRecent,
} from './claude-memory';

const pexec = promisify(exec);

const HOME = os.homedir();

/**
 * Default directory `search_repo` greps when the model doesn't pass an explicit
 * `dir`. Configurable via TARGET_REPO_DIR; falls back to the process CWD so the
 * tool is useful out of the box without leaking any machine-specific path.
 */
const TARGET_REPO_DIR = process.env.TARGET_REPO_DIR
  ? path.resolve(process.env.TARGET_REPO_DIR)
  : process.cwd();

export interface DoubaoToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export const TOOL_SCHEMAS: DoubaoToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'search_repo',
      description:
        '在目标仓库里搜代码 / 文档关键字 (ripgrep-style). 默认 case-insensitive. 返回匹配文件 + 行号 + 上下文.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键字或正则' },
          dir: {
            type: 'string',
            description:
              '搜索目录, 相对 user home 或绝对路径. 默认搜配置的目标仓库 (TARGET_REPO_DIR, 未设置则当前工作目录).',
          },
          max_results: { type: 'number', description: '最多返回条数 (默认 30)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文件的内容 (UTF-8). 路径必须在 user home 内, 不允许 ..',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径或 ~/ 开头' },
          max_lines: { type: 'number', description: '最多读取行数 (默认 400)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '网络搜索 (TODO: 当前未接外部搜索源, 占位返回空). 后续接 Bocha / Bing 时实现.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索 query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_doc',
      description:
        '在飞书创建一个新文档. 输入 title 和 markdown 内容, 返回 doc_token. 需要本地 lark-cli OAuth 已配置.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string', description: '完整 markdown body' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_doc',
      description: '用 markdown 覆盖一个已有飞书文档 (整体覆写, 不 patch).',
      parameters: {
        type: 'object',
        properties: {
          doc_token: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['doc_token', 'markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_whiteboard',
      description:
        '更新一个飞书白板 (mermaid source). 注意: whiteboard_token != doc_token, 由文档创建时返回或手动从飞书 URL 取.',
      parameters: {
        type: 'object',
        properties: {
          whiteboard_token: { type: 'string' },
          mermaid: {
            type: 'string',
            description: 'mermaid flowchart / sequence / etc. 源码',
          },
        },
        required: ['whiteboard_token', 'mermaid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_doc',
      description: '拉取一个飞书文档当前 markdown 内容.',
      parameters: {
        type: 'object',
        properties: { doc_token: { type: 'string' } },
        required: ['doc_token'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memory_anchors',
      description:
        '列出 Claude Code 长期记忆里所有 anchor 主题 (founder 跨 session 累积的偏好 / 决定 / 项目笔记). ' +
        '返回 {title, file, hook, section} 列表. 可传 topic 子串过滤. 用于 founder 问 "我有哪些 memory" / "聊过什么主题".',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: '可选 — 子串过滤 (匹配 title / hook / section). 不传返回全部.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory_anchor',
      description:
        '读取一个具体 memory anchor 文件 (e.g. "feedback_no_time_estimates.md"). 返回 frontmatter + body. ' +
        '只接受 memory/ 下的纯 basename, 不能跨目录.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: '文件名, 必须是 .md 结尾的纯 basename (e.g. "user_founder_background.md")',
          },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_memory_anchors',
      description:
        '在所有 memory anchor 里搜关键字 (case-insensitive). 返回 top-K {file, title, snippet, matchCount, score}. ' +
        '排序: title 命中 > frontmatter description 命中 > body 命中. 用于 founder 问 "我之前关于 X 写过啥".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键字' },
          topK: { type: 'number', description: '返回前 N 条 (默认 5, 上限 50)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description:
        '列出最近的 Claude Code terminal session (按 mtime 倒序). ' +
        '返回 {sessionId, mtime, sizeBytes, firstUserMsg}. 最大文件 + 最近修改 = 当前 session.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回前 N 个 (默认 10, 上限 50)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_session',
      description:
        '在 Claude Code session jsonl 里搜关键字. 不传 sessionId 默认搜最近 3 个 session. ' +
        '返回 {sessionId, lineNum, role, ts, snippet}. 用于 founder 问 "那天我们说了啥" / "之前讨论 X 在哪个 session".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键字 (case-insensitive)' },
          sessionId: {
            type: 'string',
            description: '可选 — 限定某个 session (UUID, 不含 .jsonl). 不传搜最近 3 个.',
          },
          topK: { type: 'number', description: '最多返回 N 条 (默认 10, 上限 100)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session_recent',
      description:
        '读某 session 最后 N 个 turn (user/assistant text + tool calls). ' +
        '用于回放 / context recall — "我们上一轮聊到哪了".',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'session UUID (不含 .jsonl)' },
          lastN: { type: 'number', description: '返回最后 N 个 turn (默认 20, 上限 200)' },
        },
        required: ['sessionId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_whiteboard',
      description:
        '拉取一个飞书白板的当前 mermaid 源码. **在 update_whiteboard 之前必须先调它**, 看现状再决定是加节点 / 改 label / 重画整图. 优先用本地 mirror (我们自己写过的), fallback 到 lark-cli (可能拿不到).',
      parameters: {
        type: 'object',
        properties: {
          whiteboard_token: { type: 'string' },
          parent_doc_token: {
            type: 'string',
            description: '可选 — 白板所在的飞书文档 doc_token, 用作 fallback 拉取',
          },
        },
        required: ['whiteboard_token'],
      },
    },
  },
];

/**
 * Resolve and validate a filesystem path. Returns absolute path under $HOME
 * or throws.
 */
function safeResolve(p: string): string {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error('path must be a non-empty string');
  }
  if (p.includes('..')) {
    throw new Error('path may not contain ".." segments');
  }
  let abs: string;
  if (p.startsWith('~/')) {
    abs = path.join(HOME, p.slice(2));
  } else if (path.isAbsolute(p)) {
    abs = p;
  } else {
    // treat as relative-to-home
    abs = path.join(HOME, p);
  }
  abs = path.normalize(abs);
  if (!abs.startsWith(HOME + path.sep) && abs !== HOME) {
    throw new Error(`path must live under user home (${HOME}); got ${abs}`);
  }
  return abs;
}

async function execSearchRepo(args: {
  query: string;
  dir?: string;
  max_results?: number;
}): Promise<any> {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query required');
  const dirRaw = args.dir ? safeResolve(args.dir) : TARGET_REPO_DIR;
  const max = Math.max(1, Math.min(200, args.max_results || 30));
  // Prefer ripgrep if available; fall back to grep -RIn.
  let cmd: string;
  try {
    await pexec('which rg');
    cmd = `rg --no-heading --line-number --max-count=3 --max-columns=240 -i -e ${JSON.stringify(query)} ${JSON.stringify(dirRaw)} | head -n ${max}`;
  } catch {
    cmd = `grep -RInI --color=never ${JSON.stringify(query)} ${JSON.stringify(dirRaw)} | head -n ${max}`;
  }
  const opts: ExecOptions = { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 };
  try {
    const { stdout } = await pexec(cmd, opts);
    const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
    const lines = stdoutStr
      .split('\n')
      .map((l: string) => l.trim())
      .filter(Boolean)
      .slice(0, max);
    return {
      ok: true,
      query,
      dir: dirRaw,
      count: lines.length,
      hits: lines,
    };
  } catch (err: any) {
    // grep/rg exit 1 on no matches — that's not an error
    if (err && err.code === 1) {
      return { ok: true, query, dir: dirRaw, count: 0, hits: [] };
    }
    throw err;
  }
}

async function execReadFile(args: { path: string; max_lines?: number }): Promise<any> {
  const abs = safeResolve(args.path);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${abs}`);
  const max = Math.max(1, Math.min(5000, args.max_lines || 400));
  const data = await fs.readFile(abs, 'utf-8');
  const lines = data.split('\n');
  const truncated = lines.length > max;
  return {
    ok: true,
    path: abs,
    total_lines: lines.length,
    returned_lines: Math.min(lines.length, max),
    truncated,
    content: lines.slice(0, max).join('\n'),
  };
}

async function execWebSearch(args: { query: string }): Promise<any> {
  // STUB. DeepSeek does not have a native web search. Future: integrate
  // Bocha / Bing Search v7 / Tavily. For Phase 2 we return a no-op so the
  // agent can still finish; it should be told via system prompt that this
  // tool is currently disabled.
  return {
    ok: false,
    query: args.query,
    note: 'web_search is currently a no-op stub (Phase 2). Future: wire to Bocha or Bing Search API.',
  };
}

async function execCreateDoc(args: { title: string; markdown: string }): Promise<any> {
  const res = await larkCreateDoc(args.title, args.markdown);
  return { ok: true, doc_token: res.docToken, whiteboard_token: res.whiteboardToken };
}

async function execUpdateDoc(args: { doc_token: string; markdown: string }): Promise<any> {
  await larkUpdateDoc(args.doc_token, args.markdown);
  return { ok: true };
}

async function execUpdateWhiteboard(args: {
  whiteboard_token: string;
  mermaid: string;
}): Promise<any> {
  await larkUpdateWhiteboard(args.whiteboard_token, args.mermaid);
  // Remember what we just pushed so future fetch_whiteboard calls can recall
  // it from the server-side mirror (lark-cli fetch isn't reliable for boards).
  rememberWhiteboardMermaid(args.whiteboard_token, args.mermaid);
  return { ok: true };
}

async function execFetchDoc(args: { doc_token: string }): Promise<any> {
  const md = await larkFetchDoc(args.doc_token);
  return { ok: true, markdown: md };
}

async function execFetchWhiteboard(args: {
  whiteboard_token: string;
  parent_doc_token?: string;
}): Promise<any> {
  // 1) Server-side mirror — primary source of truth for what WE have drawn.
  const mirrored = recallWhiteboardMermaid(args.whiteboard_token);
  if (mirrored) {
    const status = whiteboardMirrorStatus(args.whiteboard_token);
    return {
      ok: true,
      source: 'mirror',
      mermaid: mirrored,
      updated_at: status.updatedAt,
      note: '来自 server 本地 mirror (我们最后一次 push 的内容)',
    };
  }
  // 2) Fallback — best-effort lark-cli fetch.
  const fromLark = await larkFetchWhiteboardBestEffort(
    args.whiteboard_token,
    args.parent_doc_token || null,
  );
  if (fromLark) {
    // Cache it so subsequent fetches are fast + consistent.
    rememberWhiteboardMermaid(args.whiteboard_token, fromLark);
    return { ok: true, source: 'lark-cli', mermaid: fromLark };
  }
  // 3) Empty board — that's fine.
  return {
    ok: true,
    source: 'empty',
    mermaid: '',
    note: '白板还没画过 (mirror 空 + lark-cli fetch 无结果). 这是干净状态, 可直接 update_whiteboard 第一张图.',
  };
}

/**
 * Dispatch a tool_call to its implementation. Always returns a JSON-able
 * object; on error returns {error:string} so the model can see and recover.
 */
export async function executeTool(name: string, args: Record<string, any>): Promise<any> {
  try {
    switch (name) {
      case 'search_repo':
        return await execSearchRepo(args as any);
      case 'read_file':
        return await execReadFile(args as any);
      case 'web_search':
        return await execWebSearch(args as any);
      case 'create_doc':
        return await execCreateDoc(args as any);
      case 'update_doc':
        return await execUpdateDoc(args as any);
      case 'update_whiteboard':
        return await execUpdateWhiteboard(args as any);
      case 'fetch_doc':
        return await execFetchDoc(args as any);
      case 'fetch_whiteboard':
        return await execFetchWhiteboard(args as any);
      case 'list_memory_anchors':
        return { ok: true, entries: await listMemoryAnchors((args as any).topic) };
      case 'read_memory_anchor':
        return await readMemoryAnchor((args as any).filename);
      case 'search_memory_anchors':
        return {
          ok: true,
          query: (args as any).query,
          hits: await searchMemoryAnchors(
            (args as any).query,
            (args as any).topK,
          ),
        };
      case 'list_sessions':
        return { ok: true, sessions: await listSessions((args as any).limit) };
      case 'search_session':
        return {
          ok: true,
          query: (args as any).query,
          hits: await searchSession(
            (args as any).query,
            (args as any).sessionId,
            (args as any).topK,
          ),
        };
      case 'read_session_recent':
        return await readSessionRecent(
          (args as any).sessionId,
          (args as any).lastN,
        );
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err: any) {
    return { error: (err && err.message) || String(err) };
  }
}
