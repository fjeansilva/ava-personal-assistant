# Ava personal assistant

A personal assistant built with TypeScript and Pi as its harness.

## Current step: Pi conversations and a voice prototype

The terminal connects to one Pi agent session through `createMessageHandler(session)` in `src/core/handler.ts`, streams replies, and supports cancellation and cleanup. `src/terminal-preview.ts` imports `modelConfig` from `src/agents/ava/config.ts`, awaits the resource loader from `src/agents/ava/resources.ts`, and passes both to `createSession(modelConfig, { cwd, resourceLoader })` in `src/core/session.ts`. It creates the handler and disposes the session on exit. Telegram now uses the same core factories with a separate persistent session per chat, resumed after application restarts. The owner confirmed this behavior in a live Telegram test. Tools are disabled for this milestone.

The voice prototype connects Ava Orb's GPT-Live conversation to a simulated backend through the same `Conversation` contract. It collects user and assistant transcripts around each delegation; Pi integration for voice is a future step.

## Setup

Use Node.js 24 and install the project dependencies:

```sh
npm ci
```

Create a local `.env` file in the repository root with your selected model:

```dotenv
AVA_MODEL_PROVIDER=your-provider
AVA_MODEL_ID=your-model-id
AVA_MODEL_THINKING_LEVEL=medium
```

Replace the provider and model placeholders with a model available in your Pi configuration. Configure credentials for that provider through Pi; the application uses Pi's authentication storage. `.env` is ignored by Git.

From the repository root, run:

```sh
npm run terminal
```

The command builds the project, loads `.env`, and starts a real model conversation. Type `/exit` to finish or press Ctrl+C to cancel and exit.

AVA's persona remains in `.pi/SYSTEM.md`, loaded by Pi for the trusted project. Her resource factory uses Pi's native `DefaultResourceLoader` with `noContextFiles: true`, so repository coding guidelines such as `AGENTS.md` are not automatically added to her context. It also omits `APPEND_SYSTEM.md` additions. Session history remains managed by Pi; skills and extension discovery retain their defaults.

Each terminal run creates a new Pi session and reuses it for that conversation. Telegram uses a chat-specific persistent manager and resumes its saved conversation after restarting.

## Telegram channel

The Telegram entry point connects the channel to AVA through the Pi session factory and message handler. It uses the same model settings, provider credentials, and `.pi/SYSTEM.md` persona as the terminal, with a separate history per chat.

Add these values to your existing local `.env` without replacing the model settings:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USER_IDS=your_numeric_user_id
```

Create a bot with [BotFather](https://t.me/BotFather) and keep its token private. If you need your user ID, run `npm run telegram:identify` and send the temporary phrase shown in the terminal to your bot in a private chat. Copy the resulting user-ID setting into `.env`. Use identification before starting the channel; it acknowledges earlier updates while waiting and sends no replies.

```sh
npm run telegram
```

Keep the process running and send a private text message to the bot. Only allowed users in private chats can invoke the handler. `/start` shows the channel greeting, `/cancel` interrupts the active reply and clears queued requests, and Ctrl+C shuts down and disposes conversations. Run only one polling process per bot token.

Replies use temporary streaming drafts followed by a final message. Long output is split into plain-text messages. Conversation history is stored by Pi under ``join(getAgentDir(), "sessions", `ava-telegram-${conversationId}`)`` and resumed with `SessionManager.continueRecent`. Keep the same project working directory and agent directory between runs. This does not restore queued requests or guarantee reply delivery across restarts. Automatic reconnection, delivery retries, and durable queues are deferred; polling failures stop the process and must be addressed before restarting. A bot with an existing webhook is rejected rather than reconfigured.

The composition point is `createConversation` in `src/telegram.ts`. It derives the chat storage directory, loads AVA resources, selects the persistent manager, creates the Pi session, and returns `createMessageHandler(session)` plus a cleanup function. The channel caches that conversation per chat and processes messages sequentially; it remains independent of Pi.

See [the Telegram plan](./docs/telegram-channel-plan.md) for decisions, implementation ownership, and remaining Pi work.

## Development

See the voice prototype below for the third channel under development. Terminal and Telegram use Pi; voice currently uses a simulated backend.

```sh
npm run build
npm run typecheck
npm test
```

The 29 tests cover terminal (four), Telegram (fourteen), and voice (eleven) behavior using local callbacks, a fake Telegram API, and a fake WebSocket. They make no network or model requests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module responsibilities, diagrams, the terminal callback contract, and the Pi connection. See [AGENTS.md](./AGENTS.md) for coding guidelines.

## Voice prototype: transcripts and simulated delegation

The Ava Orb application owns the WebRTC audio conversation with GPT-Live. `src/voice-preview.ts` attaches a backend WebSocket to that existing Live session and supplies a simulated `Conversation` through `createVoiceAdapter`. This entry point does not load Pi or use its model settings, tools, or session storage.

Keep the Orb call open with client delegation enabled. From this repository, use the active Live session ID and an environment file containing `OPENAI_API_KEY` for the same OpenAI project:

```sh
npm run build
node --env-file=/absolute/path/to/voice/.env dist/voice-preview.js "<LIVE_SESSION_ID>"
```

After attachment, transcript logs distinguish `[transcript:user]` from `[transcript:assistant]`, with timing and the exact text of each fragment. Ask Ava to test the adapter. The connector opens a collection window for the delegation and waits until either:

- 800 ms pass without receiving another user transcript fragment;
- 2 seconds pass since the window opened; or
- another delegation arrives, which freezes the previous window and opens the next one.

Assistant fragments are collected but do not extend the window. The frozen snapshot includes all fragments received so far, including ones with timestamps after the delegation's offset. Responses remain simulated, and the terminal prints the snapshot for inspection. Fragments arriving after a snapshot freezes remain available for the next delegation. Closing the connection discards the pending window and aborts active work.

This window is a prototype heuristic, not an end-of-speech detector: gaps in transcript delivery do not prove silence, and a fragment can still arrive too late or belong to a new utterance. The transcript buffer lives only in memory for this connection. It is not Pi history or persistent voice memory. Local tests use a fake socket and controlled timers; they do not call GPT-Live.
