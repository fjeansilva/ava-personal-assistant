# Coding Agent Guidelines

These instructions apply to agents working on this repository's code and documentation. AVA's personal-assistant behavior is defined separately in `.pi/SYSTEM.md`.

## Project purpose

AVA is a personal assistant built with TypeScript and the Pi SDK. The current milestone includes terminal and Telegram conversations with an explicitly selected model, streamed replies, cancellation, and session cleanup. Telegram resumes a separate persistent Pi session per authorized private chat; the owner confirmed live resume after restarting. Tools are disabled. Calendar integration, long-term personal memory, and Pi Durable are future work.

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
| `src/core/session.ts` | Export `ModelConfig` and `createSession(modelConfig, options)`; resolve the model, forward native `cwd` / `resourceLoader` / `sessionManager` options, and return a live Pi session without importing AVA settings or policy. |
| `src/terminal.ts` | Provide a terminal input loop and streaming-output callback, independent of Pi. |
| `src/core/handler.ts` | Export `createMessageHandler(session)` to adapt channel messages to Pi prompting, streamed events, cancellation, and per-message cleanup. |
| `src/terminal-preview.ts` | Load AVA settings and resources, call `createSession(modelConfig, { cwd, resourceLoader })`, create the handler, run the terminal, and dispose the session. Despite its name, this entry point makes real model requests. |
| `src/telegram.ts` | Compose AVA conversations using `SessionManager.continueRecent` in a chat-specific directory, return the Pi handler and session disposal, and retain the existing channel contract. |
| `.pi/SYSTEM.md` | Define AVA's runtime persona through Pi's project system-prompt convention. |
| `test/terminal.test.mjs` | Test terminal behavior with local callbacks and Node's built-in test runner. |
| `ARCHITECTURE.md` | Document responsibilities, lifecycle, and Mermaid diagrams. |

## TypeScript and Node.js

- Use Node.js 24, npm, TypeScript strict mode, and ESM, following the existing project configuration.
- Keep application source in `src/` and generated output in `dist/`.
- Use `.js` extensions in relative TypeScript imports for NodeNext output.
- Prefer named exports and `import type` for type-only dependencies.
- Validate environment values at the configuration boundary. Do not use unchecked type assertions to hide invalid input.
- Use the installed Pi SDK declarations and examples as the authority for the version in this project. Do not assume APIs from a different release.

## Pi integration boundaries

- Select the model explicitly by provider and model ID. Fail clearly if the configuration is missing or the model cannot be resolved.
- Create one session per terminal conversation and one separate session per Telegram chat. Reuse the same live object for prompting and subscriptions.
- Telegram selects history through ``SessionManager.continueRecent(cwd, join(getAgentDir(), "sessions", `ava-telegram-${conversationId}`))``. Keep discovery scoped to that chat and use the same `cwd` across restarts; do not resume the most recent session globally. Pi owns persistence and context reconstruction.
- Pi history resume does not restore the channel's pending queue or polling offset. Do not claim durable delivery from conversation persistence alone.
- Subscribe before prompting, forward text-delta events to `write`, and await each prompt before processing another message.
- Bridge the terminal's abort signal to `session.abort()`. Remove listeners and subscriptions in `finally` blocks and dispose the session when the interface closes.
- Keep terminal UI code independent of Pi. Session setup belongs in `src/core/session.ts`, per-message Pi operations in `src/core/handler.ts`, and session ownership in the entry point. Keep environment validation in `src/agents/ava/config.ts` and resource policy in `src/agents/ava/resources.ts`. Pass values and the loaded resource loader into the core; do not add AVA-specific imports inside the session factory.
- Let Pi own context assembly and history. Do not add a parallel transcript store or agent loop without a concrete requirement.
- Preserve `noTools: "all"` until tool integration is requested.
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

`npm test` builds the project and runs terminal and Telegram tests without network or model calls. `npm run build` builds separately. `npm run terminal` and `npm run telegram` start real Pi-backed applications and require model configuration and provider credentials. Telegram also requires bot settings. The owner has confirmed live Telegram resume; current automated channel tests do not cover Pi restart recovery end to end.

Test observable behavior, especially streaming, message ordering, error recovery, cancellation, and cleanup. For documentation-only changes, check Markdown structure, paths, links, and consistency with the current implementation.

Update `README.md` and `ARCHITECTURE.md` when behavior, setup, or component responsibilities change. Clearly distinguish implemented features from planned work. Before committing, inspect the staged diff and run `git diff --cached --check`. Commit and push when requested; do not force-push unless explicitly authorized.
