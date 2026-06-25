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
- **Agent in the middle** — feeds your speech to **Doubao Seed 2.0 Pro** (Ark) —
  an OpenAI-compatible LLM with `tool_use` and adaptive deep-thinking — running a
  small tool-calling loop. The agent can search a local repo, read files,
  create/update Lark docs, and draw/update Lark whiteboards (as Mermaid diagrams).
- **Voice + visual out** — speaks back via **火山 (Volcengine) big-model TTS**
  (Seed-TTS 2.0), and renders structure to a bound Lark whiteboard.
- **Live whiteboard** — as you talk, the discussion is scribed onto the bound
  whiteboard in near-real-time (debounced; a fast Doubao Seed 2.0 Mini proposer
  emits incremental diagram edits) — like someone writing on a board while you
  brainstorm. A "recording" mode does the same for a meeting without talking back.

> **All-Doubao/火山 stack.** Everything runs on 字节火山方舟: 火山 ASR + 火山 TTS +
> 豆包 Ark LLM. (MiniMax / Gemini / DeepSeek were removed.)

It runs as a small Electron menubar app (the "pill") backed by a local
Express + WebSocket server.

## Architecture

```
  mic ──▶ 火山 ASR (streaming STT)
                │  transcript
                ├───────────────▶ live whiteboard scribe (debounced):
                │                   Doubao Seed 2.0 Mini → state transitions
                │                   → render Mermaid → push to 飞书 board
                ▼
        Doubao Seed 2.0 Pro (Ark) ──tool_use──▶  tools:
                │                          • search_repo / read_file (local)
                │                          • create_doc / update_doc / fetch_doc (Lark)
                │                          • update_whiteboard / fetch_whiteboard (Lark)
                │                          • web_search (stub)
                │                          • memory/* (optional, local Claude Code data)
                ▼
        火山 big-model TTS ──▶ speaker   +   Lark doc / whiteboard (visual output)
```

- `electron/` — Electron main + preload (the menubar pill window).
- `renderer/` — the pill UI. `voice-client.ts` is the source; it compiles to
  `voice-client.js` (the compiled JS is git-ignored — build before running).
- `src/server.ts` — Express + WS host. Endpoints for TTS, STT (WS), Lark
  doc/whiteboard ops, and the agent loop.
- `src/lib/` — building blocks: `volc-stt.ts` (火山 ASR), `volc-tts.ts` (火山
  big-model TTS), `agent-loop.ts` (the tool-calling conversation + the live
  whiteboard `RecordingSession`), `tools.ts` (tool schemas + executors),
  `lark.ts` (wraps the Lark CLI — invokes the local binary, not `npx`),
  `whiteboard-*.ts` (state machine + Mermaid rendering), `claude-memory.ts`
  (optional local memory tools).
- `scripts/` — end-to-end and smoke tests. Notably `npm run test:realtime`
  (live whiteboard E2E), `npm run test:tts` (火山 TTS smoke).
- `data/` — runtime whiteboard state (git-ignored; regenerated as needed).

## Prerequisites

- **Node.js** (18+ recommended; tested on 22).
- **API credentials** for Volcengine 火山 (one app id + access token covers both
  ASR and big-model TTS — each product must be separately "开通"/enabled on the
  app) and Doubao Ark (`ARK_API_KEY`). See [`.env.example`](./.env.example).
  No MiniMax / Gemini / DeepSeek keys are used anymore.
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

## Setup — easiest path (first-run wizard)

No keys ship in this repo. On first launch you get a **setup wizard** that walks
you through getting and entering your own keys (with direct "get it here" links
and a live "test connection" button for each), and writes them to a local
`.env` for you:

```sh
npm install
npm run pill          # or double-click 启动Beeni.command (macOS)
```

If `.env` is missing keys, a **首次配置 / Setup** window opens automatically.
Fill in:
- **火山引擎语音** (App ID + Access Token) — get them at
  <https://console.volcengine.com/speech/app>. ⚠️ On that app you must separately
  **开通 (enable)** both *流式语音识别(大模型)* and *大模型语音合成 (Seed-TTS)*.
- **豆包方舟** (`ARK_API_KEY`) — create one at
  <https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey>, then **开通**
  the models `doubao-seed-2-0-pro` + `doubao-seed-2-0-mini` at
  <https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement>.

Once 火山 + 豆包 test green and you click 保存, the pill starts automatically.

> Prefer manual? `cp .env.example .env` and fill it in — same result.

### Optional: 飞书 whiteboard (one-time terminal login)

To push diagrams into a real 飞书 board, configure the official Lark CLI once
(browser OAuth — not an `.env` key). Voice + LLM work without this.

```sh
npx -y @larksuite/cli@latest config init --new
npx -y @larksuite/cli@latest auth login --domain docs,markdown,wiki
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
