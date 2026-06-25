/**
 * context-store.ts — imported background material for the conversation.
 *
 * Single-user desktop app, so this is a process-global store. The user pastes
 * text or uploads files (txt/md/pdf/docx) in the 背景资料 window; we extract the
 * text and keep it here. The conversation agent injects getContextText() as a
 * background block so Beeni discusses with that context in mind (e.g. a chat
 * exported from another AI, a spec, meeting notes).
 */
import { randomUUID } from 'node:crypto';

const MAX_TOTAL_CHARS = Number(process.env.CONTEXT_MAX_CHARS || 120_000);
const MAX_ITEM_CHARS = Number(process.env.CONTEXT_MAX_ITEM_CHARS || 60_000);

export interface ContextItem {
  id: string;
  label: string;
  chars: number;
  source: 'paste' | 'file';
  addedAt: number;
}
interface StoredItem extends ContextItem {
  text: string;
}

const items: StoredItem[] = [];

function publicItem(x: StoredItem): ContextItem {
  return { id: x.id, label: x.label, chars: x.chars, source: x.source, addedAt: x.addedAt };
}

export function addContext(label: string, text: string, source: 'paste' | 'file' = 'paste'): ContextItem {
  let t = String(text || '').trim();
  if (!t) throw new Error('内容为空');
  let suffix = '';
  if (t.length > MAX_ITEM_CHARS) {
    t = t.slice(0, MAX_ITEM_CHARS);
    suffix = '（已截断）';
  }
  const item: StoredItem = {
    id: randomUUID().slice(0, 8),
    label: ((label || '背景资料').trim().slice(0, 80)) + suffix,
    chars: t.length,
    source,
    addedAt: Date.now(),
    text: t,
  };
  items.push(item);
  return publicItem(item);
}

export function listContexts(): ContextItem[] {
  return items.map(publicItem);
}

export function removeContext(id: string): boolean {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) {
    items.splice(i, 1);
    return true;
  }
  return false;
}

export function clearContexts(): void {
  items.length = 0;
}

/**
 * Concatenate all imported background into one block for the agent, capped at
 * MAX_TOTAL_CHARS so a huge import can't blow the context window.
 */
export function getContextText(): string {
  if (items.length === 0) return '';
  const blocks: string[] = [];
  let total = 0;
  for (const it of items) {
    const header = `── ${it.label} ──\n`;
    let body = it.text;
    if (total + header.length + body.length > MAX_TOTAL_CHARS) {
      body = body.slice(0, Math.max(0, MAX_TOTAL_CHARS - total - header.length));
    }
    if (!body) break;
    blocks.push(header + body);
    total += header.length + body.length;
    if (total >= MAX_TOTAL_CHARS) break;
  }
  return blocks.join('\n\n');
}

/**
 * Extract plain text from an uploaded file buffer by extension.
 * txt/md → utf-8; pdf → pdf-parse (v2 PDFParse.getText); docx → mammoth.
 * Libs are lazy-imported so a parse failure can't crash server boot.
 */
export async function extractFile(filename: string, buf: Buffer): Promise<string> {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['txt', 'md', 'markdown', 'text', 'log', 'csv', 'json'].includes(ext)) {
    return buf.toString('utf-8');
  }
  if (ext === 'pdf') {
    const mod: any = await import('pdf-parse');
    const PDFParse = mod.PDFParse || mod.default?.PDFParse;
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const r = await parser.getText();
      return (r?.text || '').trim();
    } finally {
      try { await parser.destroy?.(); } catch {}
    }
  }
  if (ext === 'docx') {
    const mammoth: any = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    return (r?.value || '').trim();
  }
  // unknown — best-effort utf-8 (covers most plain-text exports)
  return buf.toString('utf-8');
}
