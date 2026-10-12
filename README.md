# Ava personal assistant

A personal assistant built with TypeScript and Pi as its harness.

## Current step: Pi conversations and a voice prototype

The terminal connects to one Pi agent session through `createMessageHandler(session)` in `src/core/handler.ts`, streams replies, and supports cancellation and cleanup. `src/terminal-preview.ts` imports `modelConfig` from `src/agents/ava/config.ts`, awaits the resource loader from `src/agents/ava/resources.ts`, and passes both to `createSession(modelConfig, { cwd, resourceLoader })` in `src/core/session.ts`. It creates the handler and disposes the session on exit. Telegram now uses the same core factories with a separate persistent session per chat, resumed after application restarts. The owner confirmed this behavior in a live Telegram test. Tools are disabled for this milestone.

The voice channel connects Ava Orb's GPT-Live conversation to Pi through the same `Conversation` contract. It sends only newly collected user and assistant transcript fragments for each delegation, reusing one Pi session during the backend process. The owner confirmed the Pi-backed voice round trip before this incremental update.

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

Terminal, Telegram, and voice use Pi through the shared session factory and message handler. See the voice setup below.

```sh
npm run build
npm run typecheck
npm test
```

The 31 tests cover terminal (four), Telegram (fourteen), and voice (thirteen) behavior using local callbacks, a fake Telegram API, and a fake WebSocket. They make no network or model requests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module responsibilities, diagrams, the terminal callback contract, and the Pi connection. See [AGENTS.md](./AGENTS.md) for coding guidelines.

## Voice channel: Pi-backed incremental delegation

The Ava Orb application owns the WebRTC audio conversation with GPT-Live. `src/voice-preview.ts` attaches a backend WebSocket to that existing Live session and supplies a Pi-backed `Conversation` through `createVoiceAdapter`. The entry point loads AVA's model settings and resource policy, creates one Pi session, and reuses `createMessageHandler` for every delegation. Tools remain disabled.

Keep the Orb call open with client delegation enabled. Its instructions should describe a real Pi backend rather than the earlier simulated connection test. From this repository, load the AVA model settings and the environment file containing `OPENAI_API_KEY` for the same OpenAI project as the Live session:

```sh
npm run build
node --env-file=.env --env-file=/absolute/path/to/voice/.env dist/voice-preview.js "<LIVE_SESSION_ID>"
```

Provider credentials for Pi still use its authentication configuration. `OPENAI_API_KEY` authenticates the Live connection; `AVA_MODEL_PROVIDER` and `AVA_MODEL_ID` select the delegated Pi model.

After attachment, transcript logs distinguish `[transcript:user]` from `[transcript:assistant]`, with timing and the exact text of each fragment. Ask Ava to delegate a task to the backend. The connector opens a collection window and waits until either:

- 800 ms pass without receiving another user transcript fragment;
- 2 seconds pass since the window opened; or
- another delegation arrives, which freezes the previous window and opens the next one.

Assistant fragments are collected but do not extend the window. At freezing, `takeSnapshot` removes the pending fragments from the buffer and reserves them for that delegation. The first batch contains everything received since attachment; subsequent batches contain only new arrivals. This happens before queuing, so even multiple requests waiting behind a slow response cannot reuse the same fragments. Each batch is sorted by audio timestamps, but membership is determined by arrival: a late fragment with an older timestamp is still included in the next batch.

The terminal prints `Transcript batch received:` for inspection. Previous batches and backend replies remain in the Pi session history; the channel does not resend them. New assistant speech is still included because it records what the voice interface said. A delegation with no new fragments takes the existing clarification path without prompting Pi.

The collection window remains a heuristic, not an end-of-speech detector. Gaps in transcript delivery do not prove silence; fragments after freezing wait for the next delegation, and a new utterance inside the window can also be included. The pending buffer and queue are in memory. Batches are not automatically replayed after a handler or delivery failure, since Pi may already have accepted them. This does not provide durable delivery or recovery across restarts.

Each backend launch creates a fresh persistent Pi session; automatic voice session resume is not configured. Shutdown clears collection timers, aborts active work, and disposes the Pi session. Local tests use a fake socket and controlled timers, with no model or network calls. The incremental behavior still needs a live voice check.
