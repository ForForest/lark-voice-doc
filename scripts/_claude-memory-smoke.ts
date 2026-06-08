/**
 * _claude-memory-smoke.ts — exercise all 6 claude-memory tools with real data.
 *
 * Run:  npx tsx scripts/_claude-memory-smoke.ts
 *
 * Prints to stdout, no writes. Sized so the 500MB session JSONL doesn't
 * blow up the process: search_session uses streaming + early termination.
 */

import {
  listMemoryAnchors,
  readMemoryAnchor,
  searchMemoryAnchors,
  listSessions,
  searchSession,
  readSessionRecent,
} from '../src/lib/claude-memory';

function hr(label: string) {
  console.log('\n' + '─'.repeat(72));
  console.log(`▶ ${label}`);
  console.log('─'.repeat(72));
}

function ms(label: string, start: number) {
  const dt = Date.now() - start;
  console.log(`  ⏱  ${label}: ${dt} ms`);
  return dt;
}

async function main() {
  // ── Tool 1: list_memory_anchors ──────────────────────────────────────────
  hr('1) list_memory_anchors() — full list');
  let t = Date.now();
  const all = await listMemoryAnchors();
  ms('listMemoryAnchors() (no filter)', t);
  console.log(`  total entries: ${all.length}`);
  console.log('  first 5:');
  for (const e of all.slice(0, 5)) {
    console.log(`    [${e.section ?? '—'}] ${e.title} → ${e.file}`);
    console.log(`        hook: ${e.hook.slice(0, 110)}`);
  }

  hr('1b) list_memory_anchors(topic="git") — filtered');
  t = Date.now();
  const gitFiltered = await listMemoryAnchors('git');
  ms('listMemoryAnchors("git")', t);
  console.log(`  matched: ${gitFiltered.length}`);
  for (const e of gitFiltered.slice(0, 5)) {
    console.log(`    ${e.title} → ${e.file}`);
  }

  // ── Tool 2: read_memory_anchor ───────────────────────────────────────────
  hr('2) read_memory_anchor("feedback_no_time_estimates.md")');
  t = Date.now();
  try {
    const r = await readMemoryAnchor('feedback_no_time_estimates.md');
    ms('readMemoryAnchor', t);
    console.log(`  frontmatter:`, r.frontmatter);
    console.log(`  totalChars: ${r.totalChars}, truncated: ${r.truncated}`);
    console.log(`  body (first 400 chars):\n${r.body.slice(0, 400)}`);
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }

  // ── Path safety check ────────────────────────────────────────────────────
  hr('2b) read_memory_anchor — path traversal rejected');
  for (const bad of ['../secret.md', 'subdir/file.md', 'not-md.txt']) {
    try {
      await readMemoryAnchor(bad);
      console.log(`  UNEXPECTED PASS: ${bad}`);
    } catch (err) {
      console.log(`  OK rejected "${bad}": ${(err as Error).message}`);
    }
  }

  // ── Tool 3: search_memory_anchors ────────────────────────────────────────
  hr('3) search_memory_anchors("padel", 5)');
  t = Date.now();
  const padelHits = await searchMemoryAnchors('padel', 5);
  ms('searchMemoryAnchors("padel")', t);
  console.log(`  hits: ${padelHits.length}`);
  for (const h of padelHits) {
    console.log(`    [score=${h.score} matches=${h.matchCount}] ${h.title} → ${h.file}`);
    console.log(`        ${h.snippet.slice(0, 160)}`);
  }

  hr('3b) search_memory_anchors("freetalk", 3)');
  t = Date.now();
  const freetalkHits = await searchMemoryAnchors('freetalk', 3);
  ms('searchMemoryAnchors("freetalk")', t);
  for (const h of freetalkHits) {
    console.log(`    [score=${h.score}] ${h.title} → ${h.file}`);
    console.log(`        ${h.snippet.slice(0, 140)}`);
  }

  // ── Tool 4: list_sessions ────────────────────────────────────────────────
  hr('4) list_sessions(5)');
  t = Date.now();
  const sessions = await listSessions(5);
  ms('listSessions(5)', t);
  for (const s of sessions) {
    const sizeMb = (s.sizeBytes / 1024 / 1024).toFixed(2);
    const dt = new Date(s.mtime).toISOString();
    console.log(`    ${s.sessionId}  ${sizeMb}MB  ${dt}`);
    if (s.firstUserMsg) {
      console.log(`        first user msg: ${s.firstUserMsg.slice(0, 140)}`);
    } else {
      console.log(`        (no first user msg found in first 200 lines)`);
    }
  }

  // ── Tool 5: search_session ───────────────────────────────────────────────
  // We test against the ACTIVE / large session because that's the real-world
  // perf concern. The current biggest is e5dd088b... (~486MB).
  const biggest = sessions[0];
  hr(`5) search_session("padel", sessionId="${biggest.sessionId.slice(0, 8)}...", topK=5)`);
  t = Date.now();
  const sessHits = await searchSession('padel', biggest.sessionId, 5);
  ms('searchSession on biggest session', t);
  console.log(`  hits: ${sessHits.length}`);
  for (const h of sessHits) {
    console.log(`    line ${h.lineNum} (${h.role}) ${h.ts ?? ''}`);
    console.log(`        ${h.snippet.slice(0, 200)}`);
  }

  hr('5b) search_session("Beegin", no sessionId — searches recent 3)');
  t = Date.now();
  const multiHits = await searchSession('Beegin', undefined, 6);
  ms('searchSession across 3 recent sessions', t);
  console.log(`  hits: ${multiHits.length} (across multiple sessions)`);
  const bySession = new Map<string, number>();
  for (const h of multiHits) {
    bySession.set(h.sessionId, (bySession.get(h.sessionId) || 0) + 1);
  }
  for (const [sid, count] of bySession) {
    console.log(`    ${sid}: ${count} hits`);
  }
  console.log('  first 2 snippets:');
  for (const h of multiHits.slice(0, 2)) {
    console.log(`    [${h.sessionId.slice(0, 8)}] line ${h.lineNum} (${h.role})`);
    console.log(`        ${h.snippet.slice(0, 200)}`);
  }

  // ── Tool 6: read_session_recent ──────────────────────────────────────────
  // Use the SMALLEST recent session to keep the test cheap.
  const smallish = [...sessions].sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
  hr(`6) read_session_recent("${smallish.sessionId.slice(0, 8)}...", lastN=5) — smallest recent`);
  t = Date.now();
  const recent = await readSessionRecent(smallish.sessionId, 5);
  ms('readSessionRecent', t);
  console.log(`  totalTurnsScanned: ${recent.totalTurnsScanned}, returned: ${recent.turns.length}`);
  for (const turn of recent.turns) {
    console.log(`    line ${turn.lineNum} (${turn.role}) ${turn.ts ?? ''}`);
    if (turn.text) console.log(`        text: ${turn.text.slice(0, 160)}`);
    if (turn.toolCalls) {
      for (const tc of turn.toolCalls) {
        console.log(`        tool: ${tc.name} ${tc.input.slice(0, 80)}`);
      }
    }
  }

  console.log('\n✓ smoke test complete');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
