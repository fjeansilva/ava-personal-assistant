# Coding Agent Guidelines

These instructions apply to agents working on this repository's code and documentation. AVA's personal-assistant behavior is defined separately in `.pi/SYSTEM.md`.

## Project purpose

AVA is a personal assistant built with TypeScript and the Pi SDK. The current milestone is a terminal conversation with an explicitly selected model, streamed replies, cancellation, and session cleanup. Tools are disabled. Calendar integration, long-term personal memory, and Pi Durable are future work.

Use Pi for the agent loop, model requests, context assembly, and session persistence. Keep application code focused on configuration, lifecycle, and the user interface.

## Working with the owner

- Keep code, comments, documentation, and coding-agent explanations in English. AVA's conversation language is governed by `.pi/SYSTEM.md`.
- Respect the requested scope. During guided learning, proceed one component at a time and distinguish explanations or examples from authorized file changes.
- Preserve the owner's edits. Inspect the current files before proposing or making changes.
- Prefer small, understandable modules. Avoid speculative abstractions, additional frameworks, and dependencies that the current task does not need.
- Report what changed, what was verified, and any remaining limitation. Do not claim a live model integration worked based only on a type check or local test.

## Telegram implementation ownership

The Telegram channel preview is implemented with simulated replies and no Pi/model calls. The owner explicitly wants to implement the Pi core himself for learning: extracting the handler, making the session factory configurable, defining AVA, adding persisted chat-to-session mappings, and connecting Pi. Do not implement those steps or move the existing terminal files unless asked.

The Telegram entry point is `src/telegram.ts`; its `createConversation` callback is the connection point. Channel contracts live in `src/channels/contracts.ts`, and Telegram modules in `src/channels/telegram/`. `npm run telegram` runs the simulated channel; `npm run telegram:identify` discovers the owner's ID locally. Both use only Telegram environment settings. Keep the channel independent of Pi.

`test/telegram.test.mjs` adds local tests for access restrictions, streaming, queue ordering, cancellation, API handling, and cleanup. Cancellation currently interrupts the active response and clears pending messages, following the owner's latest written choice. See `docs/telegram-channel-plan.md` for confirmed decisions and deferred recovery work.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/config/settings.ts` | Read and validate model configuration from the environment. |
| `src/config/runtime.ts` | Create the Pi model runtime, load resources, resolve the model, and create an agent session. |
| `src/terminal.ts` | Provide a terminal input loop and streaming-output callback, independent of Pi. |
| `src/terminal-preview.ts` | Connect one Pi session to the terminal and manage subscriptions, cancellation, and disposal. Despite its name, this entry point makes real model requests. |
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
- Create one session per terminal conversation and reuse that same live object for prompting and subscriptions.
- Subscribe before prompting, forward text-delta events to `write`, and await each prompt before processing another message.
- Bridge the terminal's abort signal to `session.abort()`. Remove listeners and subscriptions in `finally` blocks and dispose the session when the interface closes.
- Keep terminal UI code independent of Pi. Model and session operations belong in the runtime and entry point.
- Let Pi own context assembly and history. Do not add a parallel transcript store or agent loop without a concrete requirement.
- Preserve `noTools: "all"` until tool integration is requested.
- Use `DefaultResourceLoader` and `.pi/SYSTEM.md` for project prompt discovery. A hardcoded `systemPromptOverride` takes precedence over the discovered file.
- Pi also discovers `AGENTS.md` as project context. These coding guidelines apply to repository work; they do not replace AVA's persona.

## Configuration and private data

- The terminal command loads `.env` before importing the application. Required variables are `AVA_MODEL_PROVIDER`, `AVA_MODEL_ID`, and `AVA_MODEL_THINKING_LEVEL`.
- Keep credentials in the local environment or Pi's authentication storage. Do not copy credentials, personal conversation logs, or session files into the repository.
- Keep `.env`, `node_modules/`, `dist/`, logs, and coverage output untracked. Commit `package-lock.json` when dependencies change.
- Use local test callbacks for ordinary validation. Run live model requests only when they are needed and authorized by the task; state clearly when a check did not call a model.

## Validation and documentation

For source changes, run the relevant checks:

```sh
npm run typecheck
npm test
```

`npm test` builds the project and runs terminal and Telegram tests without network or model calls. `npm run build` builds separately. `npm run terminal` starts the real Pi-backed application and requires environment configuration and provider credentials.

Test observable behavior, especially streaming, message ordering, error recovery, cancellation, and cleanup. For documentation-only changes, check Markdown structure, paths, links, and consistency with the current implementation.

Update `README.md` and `ARCHITECTURE.md` when behavior, setup, or component responsibilities change. Clearly distinguish implemented features from planned work. Before committing, inspect the staged diff and run `git diff --cached --check`. Commit and push when requested; do not force-push unless explicitly authorized.
