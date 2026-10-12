# Coding Agent Guidelines

These instructions apply to agents working on this repository's code and documentation. AVA's personal-assistant behavior is defined separately in `.pi/SYSTEM.md`.

## Project purpose

AVA is a personal assistant built with TypeScript and the Pi SDK. The current milestone includes terminal and Telegram conversations with an explicitly selected model, streamed replies, cancellation, and session cleanup. Telegram resumes a separate persistent Pi session per authorized private chat; the owner confirmed live resume after restarting. Only voice enables `set_expression` when the Orb bridge is configured; terminal and Telegram tools remain disabled. Calendar integration, long-term personal memory, and Pi Durable are future work.

Voice is the third Pi-backed channel: `src/voice-preview.ts` attaches to an existing GPT-Live session used by Ava Orb, loads AVA settings/resources, and creates one Pi session per backend launch. The owner supplied logs confirming the live Pi-backed round trip. The latest incremental transcript changes have local test coverage only.

Use Pi for the agent loop, model requests, context assembly, and session persistence. Keep application code focused on configuration, lifecycle, and the user interface.

## Working with the owner

- Keep code, comments, documentation, and coding-agent explanations in English. AVA's conversation language is governed by `.pi/SYSTEM.md`.
- Respect the requested scope. During guided learning, proceed one component at a time and distinguish explanations or examples from authorized file changes.
- Preserve the owner's edits. Inspect the current files before proposing or making changes.
- Prefer small, understandable modules. Avoid speculative abstractions, additional frameworks, and dependencies that the current task does not need.
- Report what changed, what was verified, and any remaining limitation. Do not claim a live model integration worked based only on a type check or local test.

## Telegram implementation ownership

The owner has implemented the shared Pi handler and session factory, AVA configuration and resource policy, and Telegram integration with persistent per-chat session resume. Terminal and Telegram compose the same core functions with separate live sessions. The owner continues implementation himself for learning; do not move the terminal files or add new integrations unless asked.

The Telegram entry point is `src/telegram.ts`; its `createConversation` callback is the connection point. Channel contracts live in `src/channels/contracts.ts`, and Telegram modules in `src/channels/telegram/`. `npm run telegram` runs the real Pi-backed channel; `npm run telegram:identify` discovers the owner's ID locally. The Telegram entry point also loads AVA model settings and resources and selects a chat-specific `SessionManager`. Identification uses only Telegram settings. Keep the channel modules independent of Pi.

`test/telegram.test.mjs` adds local tests for access restrictions, streaming, queue ordering, cancellation, API handling, and cleanup. Cancellation currently interrupts the active response and clears pending messages, following the owner's latest written choice. See `docs/telegram-channel-plan.md` for confirmed decisions and deferred recovery work.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/agents/ava/config.ts` | Read and validate AVA model configuration from the environment. |
| `src/agents/ava/resources.ts` | Apply AVA context policy with Pi's native `DefaultResourceLoader`, await `reload()`, and return the loader. |
| `src/core/session.ts` | Export `ModelConfig` and `createSession(modelConfig, options)`; resolve the model, forward native `cwd` / `resourceLoader` / `sessionManager` / `customTools` / `tools` options, and return a live Pi session without importing AVA settings or policy. |
| `src/terminal.ts` | Provide a terminal input loop and streaming-output callback, independent of Pi. |
| `src/core/handler.ts` | Export `createMessageHandler(session)` to adapt channel messages to Pi prompting, streamed events, cancellation, and per-message cleanup. |
| `src/terminal-preview.ts` | Load AVA settings and resources, call `createSession(modelConfig, { cwd, resourceLoader })`, create the handler, run the terminal, and dispose the session. Despite its name, this entry point makes real model requests. |
| `src/telegram.ts` | Compose AVA conversations using `SessionManager.continueRecent` in a chat-specific directory, return the Pi handler and session disposal, and retain the existing channel contract. |
| `src/channels/voice/adapter.ts` | Adapt an injected `Conversation` to `{ delegationId, text }` results; accumulate text and honor cancellation. |
| `src/channels/voice/live-client.ts` | Attach a backend WebSocket, validate events, log both transcript speakers, collect fragments within a bounded window, serialize delegations, and return results. |
| `src/channels/voice/transcript.ts` | Keep pending fragments per connection; `takeSnapshot` drains them into a frozen incremental batch. Pi owns persistent history. |
| `src/voice-preview.ts` | Supply a Pi-backed AVA conversation using the shared factories, describe incremental transcript input, and own connection/session cleanup. |
| `src/agents/ava/tools/set-expression.ts` | Define the native Pi expression tool, validate its parameters, and await the injected application callback. |
| `src/channels/voice/orb-client.ts` | Send authenticated expression requests to the local Orb server and validate browser confirmation. |
| `.pi/SYSTEM.md` | Define AVA's runtime persona through Pi's project system-prompt convention. |
| `test/terminal.test.mjs` | Test terminal behavior with local callbacks and Node's built-in test runner. |
| `test/voice.test.mjs` | Test transcript capture, collection deadlines, immutable snapshots, queue ordering, and cleanup with a fake socket and controlled timers. |
| `ARCHITECTURE.md` | Document responsibilities, lifecycle, and Mermaid diagrams. |

## TypeScript and Node.js

- Use Node.js 24, npm, TypeScript strict mode, and ESM, following the existing project configuration.
- Keep application source in `src/` and generated output in `dist/`.
- Use `.js` extensions in relative TypeScript imports for NodeNext output.
- Prefer named exports and `import type` for type-only dependencies.
- Validate environment values at the configuration boundary. Do not use unchecked type assertions to hide invalid input.
- Use the installed Pi SDK declarations and examples as the authority for the version in this project. Do not assume APIs from a different release.

## Voice channel boundaries

- Keep channel modules independent of Pi through the existing `Conversation` contract. The owner has connected `voice-preview.ts` to the real AVA settings, resources, session factory, and message handler; preserve that integration.
- User transcripts use `session.input_transcript.delta`; assistant transcripts use `session.output_transcript.delta`. Preserve fragment text and spaces exactly.
- Collection closes after 800 ms without a new user fragment, at 2 seconds from delegation, or when the next delegation arrives. Only user fragments reset the idle timer; never extend the maximum deadline.
- Reserve incremental batches before queuing with `takeSnapshot`; this drains pending fragments so queued delegations cannot reuse them. Membership follows arrival order, including late fragments with older or equal audio timestamps. The delegation offset is metadata, not a cutoff. Fragments after freezing remain for the next request; they do not steer an active request.
- Treat the collection window as a prototype heuristic, not proof of a completed spoken turn. Do not infer silence from event-delivery gaps.
- Keep only pending fragments in the connection buffer. Earlier batches and backend replies are already in Pi history; do not resend the full transcript. Empty batches return a clarification without prompting Pi. Automatic voice history resume and task updates are not implemented.
- Do not automatically requeue reserved batches after a handler or delivery failure: Pi may already have accepted their prompt. Durable recovery and exactly-once processing are not implemented.
- Clear collection timers on close/error and pass the abort signal through the adapter. Spoken cancellation and per-delegation cancellation are not implemented.
- Inject the socket factory for tests. Do not require live API credentials or a model call for local validation.

## Pi integration boundaries

- `set_expression` is currently a voice-only native Pi tool. Inject its implementation at the voice entry point; preserve the default of no tools in terminal and Telegram.
- The owner confirmed the `set_expression` integration in a live voice call on 2026-10-12. Automated tests cover tool and transport behavior separately.
- The Orb bridge uses local HTTP/SSE in the separate `ava-orb` repository. Keep the shared bridge token server-side, scope commands and acknowledgements to a Live session, and report success only after browser acknowledgement. Timeout or abort does not prove that an expression was never applied. Do not automatically replay it.
- Preserve explicit expression duration against speech-driven automatic expressions. A later explicit command may replace it. Never send application UI commands as invented GPT-Live protocol events.
- Tests for the Orb server/browser modules run in that repository with `node --test voice/expression.test.mjs`; they use loopback HTTP, without OpenAI calls.

- Select the model explicitly by provider and model ID. Fail clearly if the configuration is missing or the model cannot be resolved.
- Create one session per terminal conversation, one separate session per Telegram chat, and one voice session per backend launch. Reuse the same live object for prompting and subscriptions. Voice currently creates a fresh persistent session rather than resuming a previous one.
- Telegram selects history through ``SessionManager.continueRecent(cwd, join(getAgentDir(), "sessions", `ava-telegram-${conversationId}`))``. Keep discovery scoped to that chat and use the same `cwd` across restarts; do not resume the most recent session globally. Pi owns persistence and context reconstruction.
- Pi history resume does not restore the channel's pending queue or polling offset. Do not claim durable delivery from conversation persistence alone.
- Subscribe before prompting, forward text-delta events to `write`, and await each prompt before processing another message.
- Bridge the terminal's abort signal to `session.abort()`. Remove listeners and subscriptions in `finally` blocks and dispose the session when the interface closes.
- Keep terminal UI code independent of Pi. Session setup belongs in `src/core/session.ts`, per-message Pi operations in `src/core/handler.ts`, and session ownership in the entry point. Keep environment validation in `src/agents/ava/config.ts` and resource policy in `src/agents/ava/resources.ts`. Pass values and the loaded resource loader into the core; do not add AVA-specific imports inside the session factory.
- Let Pi own context assembly and history. Do not add a parallel transcript store or agent loop without a concrete requirement.
- Keep `noTools: "all"` as the default. Voice explicitly registers and selects only `set_expression` through native `customTools` / `tools` options when `AVA_ORB_BRIDGE_TOKEN` is configured. Do not enable coding tools or add Orb dependencies to the core.
- Use `DefaultResourceLoader` and `.pi/SYSTEM.md` for project prompt discovery. A hardcoded `systemPromptOverride` takes precedence over the discovered file.
- Preserve AVA's `noContextFiles: true` policy and empty `appendSystemPromptOverride`. Automatic `AGENTS.md` discovery is disabled for AVA, while `.pi/SYSTEM.md` and session history remain available through Pi. These coding guidelines still apply to agents working on this repository.
- Await the AVA loader's `reload()` before passing it to the session. Use the same `cwd` for both. Reuse native SDK options and types instead of introducing a parallel context manager.

## Configuration and private data

- Terminal and Telegram commands load `.env` before importing the application. Required variables are `AVA_MODEL_PROVIDER`, `AVA_MODEL_ID`, and `AVA_MODEL_THINKING_LEVEL`.
- Keep credentials in the local environment or Pi's authentication storage. Do not copy credentials, personal conversation logs, or session files into the repository.
- Keep `.env`, `node_modules/`, `dist/`, logs, and coverage output untracked. Commit `package-lock.json` when dependencies change.
- Use local test callbacks for ordinary validation. Run live model requests only when they are needed and authorized by the task; state clearly when a check did not call a model.

## Validation and documentation

For source changes, run the relevant checks:

```sh
npm run typecheck
npm test
```

`npm test` builds the project and runs 36 tests: four terminal, fourteen Telegram, thirteen voice delegation, and five expression tool/client tests without network or model calls. `npm run build` builds separately. `npm run terminal` and `npm run telegram` start real Pi-backed applications and require model configuration and provider credentials. Telegram also requires bot settings. `voice-preview.ts` requires an active Live session ID, `OPENAI_API_KEY`, and the AVA model settings and provider credentials; it makes real Pi requests. Voice tests inject a local conversation instead. The owner has confirmed live Telegram resume; current automated channel tests do not cover Pi restart recovery end to end or live GPT-Live transcript delivery.

Test observable behavior, especially streaming, message ordering, error recovery, cancellation, and cleanup. For documentation-only changes, check Markdown structure, paths, links, and consistency with the current implementation.

Update `README.md` and `ARCHITECTURE.md` when behavior, setup, or component responsibilities change. Clearly distinguish implemented features from planned work. Before committing, inspect the staged diff and run `git diff --cached --check`. Commit and push when requested; do not force-push unless explicitly authorized.
