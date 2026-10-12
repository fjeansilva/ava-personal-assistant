# Ava personal assistant

A personal assistant built with TypeScript and Pi as its harness.

## Current step: terminal conversation

The terminal connects to one Pi agent session through `createMessageHandler(session)` in `src/core/handler.ts`, streams replies, and supports cancellation and cleanup. `src/terminal-preview.ts` imports `modelConfig` from `src/agents/ava/config.ts`, awaits the resource loader from `src/agents/ava/resources.ts`, and passes both to `createSession(modelConfig, { cwd, resourceLoader })` in `src/core/session.ts`. It creates the handler and disposes the session on exit. Tools are disabled for this first milestone.

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

Each application run creates a new Pi session. Messages within that run share one session; resuming a previous session is not implemented yet.

## Telegram channel preview

The Telegram channel currently uses simulated streaming replies. It does not load Pi, model settings, or AVA's persona. The owner will connect Pi afterward.

Add these values to your existing local `.env` without replacing the model settings:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USER_IDS=your_numeric_user_id
```

Create a bot with [BotFather](https://t.me/BotFather) and keep its token private. If you need your user ID, run `npm run telegram:identify` and send the temporary phrase shown in the terminal to your bot in a private chat. Copy the resulting user-ID setting into `.env`. Use identification before starting the channel; it acknowledges earlier updates while waiting and sends no replies.

```sh
npm run telegram
```

Keep the process running and send a private text message to the bot. Only allowed users in private chats can invoke the handler. `/start` explains the preview, `/cancel` interrupts the active reply and clears queued requests, and Ctrl+C shuts down and disposes conversations. Run only one polling process per bot token.

Replies use temporary streaming drafts followed by a final message. Long output is split into plain-text messages. The preview stores no chat history across restarts. Automatic reconnection, delivery retries, and durable queues are deferred; polling failures stop the process and must be addressed before restarting. A bot with an existing webhook is rejected rather than reconfigured.

The integration point is `createConversation` in `src/telegram.ts`. Replace that simulated factory with your Pi-backed implementation of `src/channels/contracts.ts`; channels receive a handler and cleanup function, not a Pi session. The extracted Pi handler and model-configurable session factory are already used by the terminal. AVA's configuration and resource policy are also connected to the terminal. Persistent chat mapping and Telegram–Pi wiring remain for the owner.

See [the Telegram plan](./docs/telegram-channel-plan.md) for decisions, implementation ownership, and remaining Pi work.

## Development

```sh
npm run build
npm run typecheck
npm test
```

The tests use local callbacks and make no model requests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module responsibilities, diagrams, the terminal callback contract, and the Pi connection. See [AGENTS.md](./AGENTS.md) for coding guidelines.
