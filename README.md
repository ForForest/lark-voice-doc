# lark-voice-doc

A desktop, voice-driven research-and-writing tool. Talk to it, and an LLM agent
researches, drafts, and writes the result straight into [Lark / 飞书](https://www.feishu.cn/)
documents and whiteboards.

> **Status: early / experimental.** This is a working prototype, not a polished
> product. Some tools are stubs (e.g. `web_search`), the Lark integration shells
> out to the official CLI and requires a one-time OAuth, and the UI is rough.
> Expect to read the code.

## What it does

- **Voice in** — captures microphone audio and streams it to Volcengine (火山)
  streaming ASR for real-time Chinese/English transcription.
- **Agent in the middle** — feeds your speech to Doubao (Ark) — an
  OpenAI-compatible LLM with `tool_use` — running a small tool-calling loop. The
  agent can search a local repo, read files, create/update Lark docs, and
  draw/update Lark whiteboards (as Mermaid diagrams).
- **Voice + visual out** — speaks back via MiniMax Chinese TTS, and renders
  structure to a bound Lark whiteboard. A "recording" mode listens to a meeting
  and periodically summarizes the discussion into a diagram without talking back.

It runs as a small Electron menubar app (the "pill") backed by a local
Express + WebSocket server.

## Architecture

```
  mic ──▶ Volcengine ASR (streaming STT)
                │  transcript
                ▼
        Doubao (Ark) LLM  ──tool_use──▶  tools:
                │                          • search_repo / read_file (local)
                │                          • create_doc / update_doc / fetch_doc (Lark)
                │                          • update_whiteboard / fetch_whiteboard (Lark)
                │                          • web_search (stub)
                │                          • memory/* (optional, local Claude Code data)
                ▼
        MiniMax TTS ──▶ speaker     +     Lark doc / whiteboard (visual output)
```

- `electron/` — Electron main + preload (the menubar pill window).
- `renderer/` — the pill UI. `voice-client.ts` is the source; it compiles to
  `voice-client.js` (the compiled JS is git-ignored — build before running).
- `src/server.ts` — Express + WS host. Endpoints for TTS, STT (WS), Lark
  doc/whiteboard ops, and the agent loop.
- `src/lib/` — building blocks: `volc-stt.ts`, `minimax.ts`, `agent-loop.ts`
  (the tool-calling conversation), `tools.ts` (tool schemas + executors),
  `lark.ts` (wraps the Lark CLI), `whiteboard-*.ts` (state machine + Mermaid
  rendering), `claude-memory.ts` (optional local memory tools).
- `scripts/` — end-to-end and smoke tests.
- `data/` — runtime whiteboard state (git-ignored; regenerated as needed).

## Prerequisites

- **Node.js** (18+ recommended).
- **API credentials** for MiniMax, Volcengine ASR, and Doubao (Ark). Gemini and
  DeepSeek keys are optional. See [`.env.example`](./.env.example).
- **Lark / 飞书 CLI + OAuth** (external dependency, see below) — only needed for
  the doc/whiteboard tools. Research tools (`search_repo`, `read_file`) and
  voice work without it.

### Lark CLI dependency

The Lark doc/whiteboard tools shell out to the official Lark CLI via `npx`
(`@larksuite/cli`). You must configure it **once** in your own terminal before
those tools will work:

```sh
npx -y @larksuite/cli@latest config init --new
npx -y @larksuite/cli@latest auth login --domain docs,markdown,wiki
```

Until OAuth is configured, any `create_doc` / `update_doc` / `update_whiteboard`
/ `fetch_doc` call will fail with an "OAuth not configured" style error
(surfaced verbatim from the CLI). The rest of the app — voice, transcription,
LLM reasoning, local `search_repo` / `read_file` — works fine without it.

## Setup

```sh
npm install
cp .env.example .env      # then fill in your real keys
```

## Running

Build and launch the Electron pill:

```sh
npm run pill        # build:electron + build:renderer + electron .
# or
npm start           # same thing
```

Run the server on its own (for the web/test clients):

```sh
npm run server      # tsx src/server.ts → http://localhost:3001
```

Other useful scripts:

```sh
npm run typecheck       # tsc --noEmit
npm run build:pill      # compile electron + renderer only
npm run test:minimax    # quick MiniMax TTS sanity check
```

## Configuration notes

- **`TARGET_REPO_DIR`** — the directory the `search_repo` tool greps when the
  agent doesn't pass an explicit `dir`. If unset, it defaults to the current
  working directory. Set this to point the agent at whatever codebase you want
  it to research.
- **`CLAUDE_PROJECT_DIR` / `CLAUDE_MEMORY_DIR`** — the optional `memory/*` tools
  read a local [Claude Code](https://claude.com/claude-code) project directory
  (per-session transcripts + anchor notes). These default to
  `~/.claude/projects/<home-slug>` and are simply inert if that directory does
  not exist on your machine.
- **`PORT`** — server port (default `3001`).

See [`.env.example`](./.env.example) for the full list of environment variables
and what each one is for.

## Security

Do not commit your `.env` — it holds live API keys. `.gitignore` excludes
`.env`, build output, and runtime `data/`. Only `.env.example` (placeholders) is
tracked.
