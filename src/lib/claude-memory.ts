/**
 * claude-memory.ts — Read-only access to Claude Code's own persistent memory
 *                    + past terminal session transcripts.
 *
 * Two data sources, both on the local filesystem (no DB, no MCP):
 *
 *  1) Memory anchors — accumulated user prefs / decisions / project notes.
 *     Index file:  ~/.claude/projects/-Users-xinjiesui/memory/MEMORY.md
 *     Anchor files: same dir, e.g. `feedback_no_time_estimates.md`.
 *     Each anchor has YAML frontmatter (name/description/type) + body.
 *
 *  2) Session transcripts — one JSONL file per terminal Claude Code session.
 *     Location: ~/.claude/projects/-Users-xinjiesui/*.jsonl
 *     Each line is a JSON event. Relevant types are `user` and `assistant`,
 *     whose `.message.content` is either a string (legacy user prompt) or an
 *     array of blocks (`text`, `tool_use`, `tool_result`, `thinking`).
 *
 * Everything here is READ-ONLY — Beeni never mutates the user's memory dir.
 *
 * All paths are validated to live under MEMORY_DIR / SESSIONS_DIR so a
 * malicious filename can't escape to the rest of the filesystem.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

// ── Paths ────────────────────────────────────────────────────────────────────
//
// These point at a local Claude Code project directory (memory anchors +
// per-session JSONL transcripts). They are fully configurable so the tool does
// not assume any particular machine layout:
//
//   CLAUDE_PROJECT_DIR — the Claude Code project dir holding the *.jsonl session
//                        files and a `memory/` subdir. Defaults to
//                        ~/.claude/projects/<home-slug>, where <home-slug> is
//                        the home path with separators turned into dashes
//                        (Claude Code's own naming convention).
//   CLAUDE_MEMORY_DIR  — override just the memory anchor dir (defaults to
//                        <CLAUDE_PROJECT_DIR>/memory).
//
// If these dirs don't exist on a given machine, the memory/* tools simply
// return errors at call time; the rest of the app works fine without them.

function defaultProjectDir(): string {
  const home = os.homedir();
  // Claude Code slugifies the project path by replacing path separators (and
  // the leading separator) with dashes, e.g. /Users/alice → -Users-alice.
  const slug = home.replace(/[\\/]/g, '-');
  return path.join(home, '.claude', 'projects', slug);
}

export const SESSIONS_DIR =
  process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : defaultProjectDir();
export const MEMORY_DIR =
  process.env.CLAUDE_MEMORY_DIR
    ? path.resolve(process.env.CLAUDE_MEMORY_DIR)
    : path.join(SESSIONS_DIR, 'memory');
export const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnchorIndexEntry {
  /** Human title from MEMORY.md (the markdown link text). */
  title: string;
  /** Filename inside memory/, e.g. "feedback_no_time_estimates.md". */
  file: string;
  /** The short hook / description text following the link in MEMORY.md. */
  hook: string;
  /** Section header in MEMORY.md this entry was found under. */
  section?: string;
}

export interface AnchorRead {
  ok: boolean;
  file: string;
  /** Parsed YAML frontmatter — best-effort (string values only). */
  frontmatter: Record<string, string>;
  /** Body content after frontmatter. */
  body: string;
  /** Total chars in body (before any truncation). */
  totalChars: number;
  truncated: boolean;
}

export interface AnchorSearchHit {
  file: string;
  title: string;
  /** Short snippet around the first body match, or frontmatter description. */
  snippet: string;
  /** Number of times query appeared across title+frontmatter+body. */
  matchCount: number;
  /** Score: title (50) + frontmatter desc (10) + body (1 each) — for ranking. */
  score: number;
}

export interface SessionInfo {
  sessionId: string;
  file: string;
  mtime: number; // epoch ms
  sizeBytes: number;
  firstUserMsg?: string;
}

export interface SessionSearchHit {
  sessionId: string;
  lineNum: number;
  role: 'user' | 'assistant';
  ts?: string;
  snippet: string;
}

export interface SessionTurnSummary {
  lineNum: number;
  role: 'user' | 'assistant';
  ts?: string;
  /** Concatenated `text` blocks (or string content). Empty if turn is pure tool I/O. */
  text: string;
  /** Tool calls observed in this turn (assistant turns only). */
  toolCalls?: Array<{ name: string; input: string }>;
}

// ── Path safety ──────────────────────────────────────────────────────────────

function safeAnchorPath(filename: string): string {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('filename required');
  }
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error('filename must be a plain basename, no slashes / ".."');
  }
  if (!filename.endsWith('.md')) {
    throw new Error('filename must end with .md');
  }
  const abs = path.join(MEMORY_DIR, filename);
  if (!abs.startsWith(MEMORY_DIR + path.sep)) {
    throw new Error('resolved path escapes memory dir');
  }
  return abs;
}

function safeSessionPath(sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('sessionId required');
  }
  // sessionId is the jsonl basename (with or without `.jsonl`). Strip if needed.
  let id = sessionId.trim();
  if (id.endsWith('.jsonl')) id = id.slice(0, -'.jsonl'.length);
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('sessionId must be a UUID-like basename, no slashes / ".."');
  }
  const abs = path.join(SESSIONS_DIR, `${id}.jsonl`);
  if (!abs.startsWith(SESSIONS_DIR + path.sep)) {
    throw new Error('resolved session path escapes sessions dir');
  }
  return abs;
}

// ── Tool 1: list_memory_anchors ──────────────────────────────────────────────

/**
 * Parse MEMORY.md into a flat list of anchors. Recognizes lines like:
 *   - [Title](file.md) — hook text
 *   - 📋 **[Title](file.md)** — hook text
 *   - 🚀 **[Title](file.md)** — hook text with **bold** inside
 * Tracks the current "## section" header so each entry knows which section
 * it lived under (useful for the agent to skim by topic).
 */
export async function listMemoryAnchors(
  topic?: string,
): Promise<AnchorIndexEntry[]> {
  let text: string;
  try {
    text = await fsp.readFile(MEMORY_INDEX, 'utf-8');
  } catch (err) {
    throw new Error(`failed to read MEMORY index at ${MEMORY_INDEX}: ${(err as Error).message}`);
  }
  const entries: AnchorIndexEntry[] = [];
  let currentSection: string | undefined;
  // Match `[Title](file.md)` then optional `**` then ` — hook` or ` - hook`.
  // We extract anywhere in the line so emojis / bold / bullets don't matter.
  const linkRe = /\[([^\]\n]+)\]\(([^)\s]+\.md)\)/;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trimEnd();
    // Section header (## …)
    const secMatch = line.match(/^#{1,3}\s+(.+)$/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }
    // List item with a markdown link inside
    if (!/^\s*-\s/.test(line)) continue;
    const m = line.match(linkRe);
    if (!m) continue;
    const title = m[1].trim();
    const file = m[2].trim();
    // Skip non-anchor refs (subdirs, html, etc.)
    if (file.includes('/')) continue;
    // Hook = everything after the link. Strip trailing closing `**`, em-dash,
    // hyphens.
    const after = line.slice(line.indexOf(m[0]) + m[0].length);
    const hook = after
      .replace(/^\s*\*+\s*/, '') // closing **
      .replace(/^\s*[—–-]\s*/, '') // em-dash / hyphen separator
      .replace(/\s+$/, '')
      .slice(0, 280);
    entries.push({ title, file, hook, section: currentSection });
  }
  if (topic && topic.trim()) {
    const q = topic.trim().toLowerCase();
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.hook.toLowerCase().includes(q) ||
        (e.section && e.section.toLowerCase().includes(q)),
    );
  }
  return entries;
}

// ── Tool 2: read_memory_anchor ───────────────────────────────────────────────

const MAX_ANCHOR_BYTES = 50 * 1024; // 50KB

/** Parse simple YAML frontmatter (key: value pairs, no nesting). */
function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  // Find closing `---` on its own line.
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return { frontmatter: {}, body: text };
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return { frontmatter: {}, body: text };
  const fmBlock = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n').replace(/^\n+/, '');
  const fm: Record<string, string> = {};
  for (const fl of fmBlock) {
    const m = fl.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim();
    // Strip surrounding quotes
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    fm[k] = v;
  }
  return { frontmatter: fm, body };
}

export async function readMemoryAnchor(filename: string): Promise<AnchorRead> {
  const abs = safeAnchorPath(filename);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`anchor not found: ${filename}`);
  }
  const raw = await fsp.readFile(abs, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const totalChars = body.length;
  const truncated = Buffer.byteLength(body, 'utf-8') > MAX_ANCHOR_BYTES;
  let outBody = body;
  if (truncated) {
    // Truncate at ~50KB worth of chars (rough byte→char approx).
    outBody = body.slice(0, MAX_ANCHOR_BYTES) + '\n\n[…truncated, original is larger; raise the limit if you need more]';
  }
  return {
    ok: true,
    file: filename,
    frontmatter,
    body: outBody,
    totalChars,
    truncated,
  };
}

// ── Tool 3: search_memory_anchors ────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    count++;
    from = i + needle.length;
  }
  return count;
}

function snippetAround(body: string, needle: string, win = 140): string {
  const idx = body.toLowerCase().indexOf(needle);
  if (idx < 0) return body.slice(0, win * 2);
  const start = Math.max(0, idx - win);
  const end = Math.min(body.length, idx + needle.length + win);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix;
}

export async function searchMemoryAnchors(
  query: string,
  topK: number = 5,
): Promise<AnchorSearchHit[]> {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const cap = Math.max(1, Math.min(50, topK || 5));
  const files = (await fsp.readdir(MEMORY_DIR)).filter(
    (f) => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  const hits: AnchorSearchHit[] = [];
  for (const file of files) {
    const abs = path.join(MEMORY_DIR, file);
    let raw: string;
    try {
      raw = await fsp.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const titleCandidate =
      frontmatter.name || frontmatter.title || file.replace(/\.md$/, '');
    const title = titleCandidate;
    const titleLow = title.toLowerCase();
    const descLow = (frontmatter.description || '').toLowerCase();
    const bodyLow = body.toLowerCase();
    const titleMatches = countOccurrences(titleLow, q);
    const descMatches = countOccurrences(descLow, q);
    const bodyMatches = countOccurrences(bodyLow, q);
    const matchCount = titleMatches + descMatches + bodyMatches;
    if (matchCount === 0) continue;
    const score = titleMatches * 50 + descMatches * 10 + bodyMatches;
    let snippet = '';
    if (descMatches > 0) {
      snippet = frontmatter.description || '';
    } else if (bodyMatches > 0) {
      snippet = snippetAround(body, q);
    } else {
      snippet = title;
    }
    hits.push({
      file,
      title,
      snippet: snippet.slice(0, 320),
      matchCount,
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, cap);
}

// ── Tool 4: list_sessions ────────────────────────────────────────────────────

/**
 * Best-effort: peek the first ~120 lines of a session JSONL and return the
 * first real user message (skipping system / file-snapshot / progress events).
 */
async function peekFirstUserMessage(file: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    let count = 0;
    let resolved = false;
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf-8' });
    } catch {
      resolve(undefined);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = (v?: string) => {
      if (resolved) return;
      resolved = true;
      try {
        rl.close();
      } catch {}
      try {
        stream.destroy();
      } catch {}
      resolve(v);
    };
    rl.on('line', (line) => {
      count++;
      if (count > 200) {
        finish(undefined);
        return;
      }
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (evt?.type !== 'user') return;
      const msg = evt.message;
      if (!msg) return;
      // Skip tool_result echoes (they're role=user, content=array of tool_result)
      let text: string | undefined;
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        const onlyToolResult = msg.content.every(
          (c: any) => c?.type === 'tool_result',
        );
        if (onlyToolResult) return;
        const textBlock = msg.content.find((c: any) => c?.type === 'text');
        if (textBlock) text = textBlock.text;
      }
      if (!text) return;
      // Skip system-reminder-only messages.
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('<system-reminder>') || trimmed.startsWith('<command-')) {
        return;
      }
      finish(trimmed.slice(0, 240));
    });
    rl.on('close', () => finish(undefined));
    rl.on('error', () => finish(undefined));
  });
}

export async function listSessions(limit: number = 10): Promise<SessionInfo[]> {
  const cap = Math.max(1, Math.min(50, limit || 10));
  const entries = await fsp.readdir(SESSIONS_DIR);
  const jsonl = entries.filter((f) => f.endsWith('.jsonl'));
  const infos: SessionInfo[] = [];
  for (const f of jsonl) {
    const abs = path.join(SESSIONS_DIR, f);
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) continue;
      infos.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        file: abs,
        mtime: st.mtimeMs,
        sizeBytes: st.size,
      });
    } catch {
      continue;
    }
  }
  infos.sort((a, b) => b.mtime - a.mtime);
  const top = infos.slice(0, cap);
  // Cheap: peek first user msg only for the top-N (don't open every file).
  for (const info of top) {
    try {
      info.firstUserMsg = await peekFirstUserMessage(info.file);
    } catch {
      // ignore
    }
  }
  return top;
}

// ── Tool 5: search_session ───────────────────────────────────────────────────

/**
 * Extract user-visible text from a JSONL event (user or assistant).
 * Skips pure-tool-result events (those are noise for keyword search).
 */
function extractEventText(evt: any): {
  role: 'user' | 'assistant' | null;
  text: string;
  ts?: string;
} {
  const type = evt?.type;
  if (type !== 'user' && type !== 'assistant') return { role: null, text: '' };
  const msg = evt.message;
  if (!msg) return { role: null, text: '' };
  const ts = evt.timestamp || msg?.timestamp;
  if (typeof msg.content === 'string') {
    return { role: type as any, text: msg.content, ts };
  }
  if (!Array.isArray(msg.content)) return { role: type as any, text: '', ts };
  const parts: string[] = [];
  for (const c of msg.content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text);
    } else if (c.type === 'tool_use' && c.name) {
      // Surface tool name + a short slice of input — searchable
      const inp = c.input ? JSON.stringify(c.input).slice(0, 200) : '';
      parts.push(`[tool_use:${c.name}] ${inp}`);
    }
    // Skip thinking blocks (often empty signature blobs) and tool_result echoes.
  }
  return { role: type as any, text: parts.join('\n'), ts };
}

function snippetForSession(text: string, needle: string, win = 150): string {
  const low = text.toLowerCase();
  const idx = low.indexOf(needle);
  if (idx < 0) return text.slice(0, win * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, idx - win);
  const end = Math.min(text.length, idx + needle.length + win);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (
    prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix
  );
}

async function searchOneSession(
  file: string,
  sessionId: string,
  query: string,
  maxHits: number,
): Promise<SessionSearchHit[]> {
  const needleLow = query.toLowerCase();
  const hits: SessionSearchHit[] = [];
  return await new Promise<SessionSearchHit[]>((resolve) => {
    let lineNum = 0;
    let resolved = false;
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf-8' });
    } catch {
      resolve([]);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        rl.close();
      } catch {}
      try {
        stream.destroy();
      } catch {}
      resolve(hits);
    };
    rl.on('line', (line) => {
      lineNum++;
      if (hits.length >= maxHits) {
        finish();
        return;
      }
      // Cheap pre-filter — if query string doesn't appear anywhere in raw line,
      // skip JSON parse. Saves a ton on 500MB files.
      if (line.toLowerCase().indexOf(needleLow) < 0) return;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      const { role, text, ts } = extractEventText(evt);
      if (!role || !text) return;
      if (text.toLowerCase().indexOf(needleLow) < 0) return;
      hits.push({
        sessionId,
        lineNum,
        role,
        ts,
        snippet: snippetForSession(text, needleLow),
      });
      if (hits.length >= maxHits) finish();
    });
    rl.on('close', () => finish());
    rl.on('error', () => finish());
  });
}

export async function searchSession(
  query: string,
  sessionId?: string,
  topK: number = 10,
): Promise<SessionSearchHit[]> {
  const q = String(query || '').trim();
  if (!q) return [];
  const cap = Math.max(1, Math.min(100, topK || 10));
  // Per-file max we collect before stopping; over-collect a bit so we can sort.
  const perFileMax = Math.max(cap, cap * 2);
  if (sessionId) {
    const abs = safeSessionPath(sessionId);
    const hits = await searchOneSession(abs, sessionId, q, perFileMax);
    return hits.slice(0, cap);
  }
  // Default: search top-3 most-recent sessions.
  const sessions = await listSessions(3);
  const all: SessionSearchHit[] = [];
  for (const s of sessions) {
    const hits = await searchOneSession(s.file, s.sessionId, q, perFileMax);
    all.push(...hits);
    if (all.length >= cap * 3) break;
  }
  // Return in the order found (recent session first, top to bottom).
  return all.slice(0, cap);
}

// ── Tool 6: read_session_recent ──────────────────────────────────────────────

/**
 * Read the last N "turns" (user or assistant text events) from a session.
 * We stream the whole file once (jsonl files are line-delimited so this is
 * cheap-ish even at 500MB if we only keep a ring buffer).
 */
export async function readSessionRecent(
  sessionId: string,
  lastN: number = 20,
): Promise<{
  sessionId: string;
  totalTurnsScanned: number;
  turns: SessionTurnSummary[];
}> {
  const abs = safeSessionPath(sessionId);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const cap = Math.max(1, Math.min(200, lastN || 20));
  // Ring buffer of last `cap` turns.
  const ring: SessionTurnSummary[] = [];
  let totalTurns = 0;
  return await new Promise((resolve, reject) => {
    let lineNum = 0;
    const stream = fs.createReadStream(abs, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lineNum++;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      const { role, text, ts } = extractEventText(evt);
      if (!role) return;
      // Collect tool calls separately for assistant turns
      const toolCalls: Array<{ name: string; input: string }> = [];
      if (role === 'assistant' && Array.isArray(evt?.message?.content)) {
        for (const c of evt.message.content) {
          if (c?.type === 'tool_use' && c.name) {
            toolCalls.push({
              name: c.name,
              input: c.input ? JSON.stringify(c.input).slice(0, 240) : '',
            });
          }
        }
      }
      // Skip events that have neither text nor tool calls.
      if (!text && toolCalls.length === 0) return;
      totalTurns++;
      ring.push({
        lineNum,
        role,
        ts,
        text: text.slice(0, 2000),
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });
      if (ring.length > cap) ring.shift();
    });
    rl.on('close', () => {
      resolve({
        sessionId,
        totalTurnsScanned: totalTurns,
        turns: ring,
      });
    });
    rl.on('error', (err) => reject(err));
  });
}
