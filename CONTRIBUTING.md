# Contributing

Thanks for your interest! This is an early/experimental project — issues and PRs
welcome. A few things to make it smooth.

## Dev setup

```sh
npm install
npm run pill          # builds + launches the Electron pill (it spawns the backend itself)
```

No keys ship in the repo. On first launch a **setup wizard** opens — fill in your
own 火山 (Volcengine speech) + 豆包 (Ark) keys; it writes them to a local `.env`
(git-ignored). See the [README](./README.md#setup--easiest-path-first-run-wizard)
for where to get each.

To run the backend on its own (for the test/web clients):

```sh
npm run server        # tsx src/server.ts → http://localhost:3001
```

## Running tests

The harnesses hit the real Doubao/火山 APIs (so they need a configured `.env`),
but never need a real microphone or a real 飞书 board (the board push is stubbed):

```sh
npm run typecheck       # tsc --noEmit (src)
npm run test:realtime   # end-to-end live-whiteboard harness (debounce, incremental, …)
npm run test:tts        # 火山 TTS smoke (mp3 + pcm)
npm run test:context    # background-import end to end (incl. the agent using it)
npm run build:pill      # compile electron + renderer
```

Most `scripts/_probe-*.ts` and `scripts/_smoke-*.ts` are throwaway diagnostics
you can run ad-hoc with `npx tsx scripts/<name>.ts`.

## Architecture

See the [Architecture section in the README](./README.md#architecture). Quick map:

- `electron/` — the menubar pill (spawns the backend, global push-to-talk).
- `renderer/` — the pill UI (`voice-client.ts`).
- `src/server.ts` — Express + WS host (TTS, STT, agent loop, setup, context).
- `src/lib/` — `volc-stt.ts` / `volc-tts.ts` (火山 speech), `agent-loop.ts`
  (Doubao tool-calling + the live-whiteboard `RecordingSession`), `whiteboard-*.ts`
  (state machine + Mermaid), `lark.ts` (飞书 CLI), `context-store.ts`,
  `setup.ts`.

## Conventions

- TypeScript, run via `tsx` (no build step for the server). `"type": "commonjs"`.
- Match the style of the surrounding code — comment density, naming, idioms.
- Keep real-time paths fast: the whiteboard proposer uses a fast Doubao model
  with thinking disabled on purpose (see the comment in `whiteboard-llm.ts`).
- **Never commit secrets.** `.env` is git-ignored; only `.env.example` is tracked.
  Don't hardcode keys in any tracked file.

## Reporting issues

Include: what you did, what you expected, what happened, and any error from the
terminal (`npm run pill` logs the backend). For voice/whiteboard issues, note
whether it's the mic path, the agent reply, or the 飞书 push.
