/**
 * lark.ts — wrapper around `npx @larksuite/cli@latest` for docs + whiteboard.
 *
 * All functions spawn the CLI as a subprocess, pipe markdown / mermaid via
 * stdin (using `--markdown -` or `--source -`), capture stdout/stderr, parse
 * JSON output, and throw on non-zero exit or parse failure.
 *
 * AUTH: caller must run `npx @larksuite/cli@latest config init --new` and
 *   `auth login --domain docs,markdown,wiki` once in their own terminal. If
 *   auth missing, these functions surface a clear "OAuth not configured"
 *   error via stderr from lark-cli — we re-throw it.
 *
 * TIMEOUT: each command is bounded by `LARK_CMD_TIMEOUT_MS` (default 60s).
 */

import { spawn } from 'node:child_process';

const LARK_CLI = ['@larksuite/cli@latest'];
const DEFAULT_TIMEOUT_MS = Number(process.env.LARK_CMD_TIMEOUT_MS || 60_000);

export interface LarkCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run an npx lark-cli command. If `stdinPayload` is provided, it's piped
 * to the child's stdin. Returns { stdout, stderr, exitCode }, throws on
 * timeout. Does NOT throw on non-zero exit — caller inspects.
 */
function runLarkCli(args: string[], stdinPayload?: string): Promise<LarkCommandResult> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-y', ...LARK_CLI, ...args];
    const child = spawn('npx', fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`lark-cli timed out after ${DEFAULT_TIMEOUT_MS}ms: npx ${fullArgs.join(' ')}`));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

    if (stdinPayload !== undefined) {
      try {
        child.stdin.write(stdinPayload);
      } catch {}
    }
    try {
      child.stdin.end();
    } catch {}
  });
}

/**
 * Best-effort JSON parser — lark-cli usually emits JSON to stdout when --json
 * is set, but sometimes prepends progress lines. Walk the stdout for a JSON
 * object/array and return the first parseable one.
 */
function extractJson(stdout: string): any | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  // try to find {...} or [...] balanced span
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const candidates: number[] = [];
  if (firstObj >= 0) candidates.push(firstObj);
  if (firstArr >= 0) candidates.push(firstArr);
  candidates.sort((a, b) => a - b);
  for (const start of candidates) {
    for (let end = trimmed.length; end > start; end--) {
      const slice = trimmed.slice(start, end);
      try {
        return JSON.parse(slice);
      } catch {}
    }
  }
  return null;
}

function ensureSuccess(result: LarkCommandResult, label: string) {
  if (result.exitCode !== 0) {
    const auth = /auth|login|config init|token|unauthor/i.test(result.stderr + result.stdout)
      ? ' (likely lark-cli OAuth not configured — run `npx @larksuite/cli@latest config init --new` then `auth login`)'
      : '';
    throw new Error(
      `${label} failed (exit ${result.exitCode})${auth}\nstderr: ${result.stderr.trim().slice(0, 800)}\nstdout: ${result.stdout.trim().slice(0, 400)}`,
    );
  }
}

export interface CreateDocResult {
  docToken: string;
  whiteboardToken?: string;
  raw: any;
}

/**
 * Create a new docs v2 document from markdown source.
 * Returns the new doc_token (and a whiteboard token if the doc happens to
 * include an embedded whiteboard block, but typically undefined).
 */
export async function larkCreateDoc(title: string, markdown: string): Promise<CreateDocResult> {
  // v2 +create takes --content + --doc-format markdown (title comes from
  // first H1 inside the content). Inject one if the caller's markdown lacks
  // any leading H1.
  const trimmed = markdown.trimStart();
  const withTitle = /^#\s+\S/.test(trimmed) ? trimmed : `# ${title}\n\n${trimmed}`;
  const args = [
    'docs',
    '+create',
    '--api-version',
    'v2',
    '--doc-format',
    'markdown',
    '--content',
    '-',
  ];
  const result = await runLarkCli(args, withTitle);
  ensureSuccess(result, 'larkCreateDoc');
  const parsed = extractJson(result.stdout);
  // lark-cli v2 returns either {document:{document_id,...}, blocks:[...]} or
  // {data:{document:{document_id}}, ...}. Walk common shapes.
  const docToken =
    parsed?.document?.document_id ||
    parsed?.document?.documentId ||
    parsed?.data?.document?.document_id ||
    parsed?.data?.document?.documentId ||
    parsed?.data?.doc_token ||
    parsed?.doc_token ||
    parsed?.docToken ||
    parsed?.document_id ||
    parsed?.documentId ||
    parsed?.id;
  if (!docToken) {
    throw new Error(
      `larkCreateDoc: could not extract doc_token from stdout: ${result.stdout.trim().slice(0, 800)}`,
    );
  }
  // Find first whiteboard block token in the response, if any.
  const whiteboardToken = findFirstWhiteboardToken(parsed);
  return { docToken, whiteboardToken, raw: parsed ?? result.stdout };
}

/**
 * Walk the response tree looking for a block of type "whiteboard" (block_type 43
 * in v1; "whiteboard" name in v2) and return its block_id / token, which
 * doubles as the whiteboard_token for `+whiteboard-update`.
 */
function findFirstWhiteboardToken(obj: any): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  // Heuristics: look for any nested object with a "whiteboard" key or
  // block_type that names a board.
  const candidates: any[] = [obj];
  const seen = new Set<any>();
  while (candidates.length) {
    const cur = candidates.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (cur.whiteboard && typeof cur.whiteboard === 'object') {
      const tok =
        cur.whiteboard.token ||
        cur.whiteboard.whiteboard_token ||
        cur.whiteboard.id ||
        cur.block_id;
      if (typeof tok === 'string' && tok.length > 4) return tok;
    }
    if (typeof cur.block_type === 'string' && /whiteboard|board/i.test(cur.block_type)) {
      const tok = cur.token || cur.block_id || cur.whiteboard_token;
      if (typeof tok === 'string' && tok.length > 4) return tok;
    }
    for (const k of Object.keys(cur)) {
      const v = (cur as any)[k];
      if (v && typeof v === 'object') candidates.push(v);
    }
  }
  return undefined;
}

/**
 * Overwrite an existing doc's markdown body.
 */
export async function larkUpdateDoc(
  docToken: string,
  markdown: string,
  mode: 'overwrite' | 'append' = 'overwrite',
): Promise<void> {
  // v2 +update uses --command (overwrite|append|...) and --content.
  const args = [
    'docs',
    '+update',
    '--api-version',
    'v2',
    '--doc',
    docToken,
    '--command',
    mode,
    '--doc-format',
    'markdown',
    '--content',
    '-',
  ];
  const result = await runLarkCli(args, markdown);
  ensureSuccess(result, 'larkUpdateDoc');
}

/**
 * Replace whiteboard contents with the provided mermaid source.
 */
export async function larkUpdateWhiteboard(
  whiteboardToken: string,
  mermaidSource: string,
  overwrite: boolean = true,
): Promise<void> {
  const args = [
    'docs',
    '+whiteboard-update',
    '--whiteboard-token',
    whiteboardToken,
    '--input_format',
    'mermaid',
    '--source',
    '-',
  ];
  if (overwrite) args.push('--overwrite');
  const result = await runLarkCli(args, mermaidSource);
  ensureSuccess(result, 'larkUpdateWhiteboard');
}

/**
 * Fetch the markdown rendering of a doc.
 */
export async function larkFetchDoc(docToken: string): Promise<string> {
  const args = [
    'docs',
    '+fetch',
    '--api-version',
    'v2',
    '--doc',
    docToken,
    '--doc-format',
    'markdown',
  ];
  const result = await runLarkCli(args);
  ensureSuccess(result, 'larkFetchDoc');
  return result.stdout;
}

/**
 * Best-effort fetch of a whiteboard's source. lark-cli's `docs +whiteboard-fetch`
 * (if it exists) would be ideal; otherwise we fall back to fetching the parent
 * doc's markdown and grepping for a fenced mermaid block.
 *
 * Returns the mermaid source if found, or null. NEVER throws — fetch-whiteboard
 * is best-effort and the caller uses an in-memory mirror as primary truth.
 */
export async function larkFetchWhiteboardBestEffort(
  whiteboardToken: string,
  parentDocToken?: string | null,
): Promise<string | null> {
  // Try 1: hypothetical direct command (some lark-cli versions expose it).
  try {
    const args = [
      'docs',
      '+whiteboard-fetch',
      '--whiteboard-token',
      whiteboardToken,
      '--output_format',
      'mermaid',
    ];
    const result = await runLarkCli(args);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // command probably doesn't exist on this CLI version; fall through
  }
  // Try 2: fetch parent doc markdown and look for mermaid fence.
  if (parentDocToken) {
    try {
      const md = await larkFetchDoc(parentDocToken);
      const fence = md.match(/```(?:mermaid)\s*([\s\S]*?)```/);
      if (fence) return fence[1].trim();
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Check whether the local lark-cli auth session is valid.
 * Returns the raw stdout — caller can grep for "authenticated" / "no token".
 */
export async function larkAuthStatus(): Promise<{ ok: boolean; raw: string }> {
  const result = await runLarkCli(['auth', 'status']);
  const text = (result.stdout + '\n' + result.stderr).toLowerCase();
  const ok =
    result.exitCode === 0 &&
    !/no.*token|not.*log|unauth|expired|init/i.test(text);
  return { ok, raw: result.stdout || result.stderr };
}
