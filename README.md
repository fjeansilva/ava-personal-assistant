# Ava personal assistant

A personal assistant built with TypeScript and Pi as its harness.

## Current step: Pi conversations and a voice prototype

The terminal connects to one Pi agent session through `createMessageHandler(session)` in `src/core/handler.ts`, streams replies, and supports cancellation and cleanup. `src/terminal-preview.ts` imports `modelConfig` from `src/agents/ava/config.ts`, awaits the resource loader from `src/agents/ava/resources.ts`, and passes both to `createSession(modelConfig, { cwd, resourceLoader })` in `src/core/session.ts`. It creates the handler and disposes the session on exit. Telegram now uses the same core factories with a separate persistent session per chat, resumed after application restarts. The owner confirmed this behavior in a live Telegram test. Terminal and Telegram tools remain disabled; voice has time and web-search tools plus an optional facial-expression tool.

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

The 56 tests cover terminal (four), Telegram (fourteen), voice delegation (thirteen), voice connection failures (nine), voice session storage (three), expression tool/client (five), and time/search tools (eight). Storage tests use Pi's real `SessionManager` with temporary files. Connection tests include a real WebSocket against a loopback HTTP server; other checks use local callbacks and fake transports. They make no OpenAI or model requests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module responsibilities, diagrams, the terminal callback contract, and the Pi connection. See [AGENTS.md](./AGENTS.md) for coding guidelines.

## Voice channel: Pi-backed incremental delegation

The Ava Orb application owns the WebRTC audio conversation with GPT-Live. `src/voice-preview.ts` attaches a backend WebSocket to that existing Live session and supplies a Pi-backed `Conversation` through `createVoiceAdapter`. The entry point loads AVA's model settings and resource policy, creates one Pi session, and reuses `createMessageHandler` for every delegation. Voice enables `get_local_time` and `web_search`, plus `set_expression` when the Orb bridge is configured. Terminal and Telegram still have no tools enabled.

Keep the Orb call open with client delegation enabled. Its instructions should describe a real Pi backend rather than the earlier simulated connection test. From this repository, load the AVA model settings and the environment file containing `OPENAI_API_KEY` for the same OpenAI project as the Live session:

```sh
npm run build
node --env-file=.env --env-file=/absolute/path/to/voice/.env dist/voice-preview.js "<LIVE_SESSION_ID>"
```

Provider credentials for Pi still use its authentication configuration. `OPENAI_API_KEY` authenticates the Live connection; `AVA_MODEL_PROVIDER` and `AVA_MODEL_ID` select the delegated Pi model.

If the initial WebSocket attachment returns HTTP 429, 502, 503, or 504, the client retries after 1, 2, and 4 seconds (four attempts total). It respects a longer `Retry-After` up to 30 seconds; a longer requested wait ends the run so you can retry later. Each handshake has a 10-second timeout. Authentication and other HTTP errors stop immediately. The entry point prints an actionable error and exits unsuccessfully if attachment fails, while disposing the Pi session; Ctrl+C cancels pending retries.

Keep the Orb call open and use its current Live session ID. A 503 is a failure of the remote attachment request; it does not indicate a Pi JSONL error. Start a new call and use its new ID if the previous call ended. If 503 persists for an active call, retry later. Established connections are never automatically reattached and delegations are never replayed: missed transcripts cannot be recovered by this retry policy.

After attachment, transcript logs distinguish `[transcript:user]` from `[transcript:assistant]`, with timing and the exact text of each fragment. Ask Ava to delegate a task to the backend. The connector opens a collection window and waits until either:

- 800 ms pass without receiving another user transcript fragment;
- 2 seconds pass since the window opened; or
- another delegation arrives, which freezes the previous window and opens the next one.

Assistant fragments are collected but do not extend the window. At freezing, `takeSnapshot` removes the pending fragments from the buffer and reserves them for that delegation. The first batch contains everything received since attachment; subsequent batches contain only new arrivals. This happens before queuing, so even multiple requests waiting behind a slow response cannot reuse the same fragments. Each batch is sorted by audio timestamps, but membership is determined by arrival: a late fragment with an older timestamp is still included in the next batch.

The terminal prints `Transcript batch received:` for inspection. Previous batches and backend replies remain in the Pi session history; the channel does not resend them. New assistant speech is still included because it records what the voice interface said. A delegation with no new fragments takes the existing clarification path without prompting Pi.

The collection window remains a heuristic, not an end-of-speech detector. Gaps in transcript delivery do not prove silence; fragments after freezing wait for the next delegation, and a new utterance inside the window can also be included. The pending buffer and queue are in memory. Batches are not automatically replayed after a handler or delivery failure, since Pi may already have accepted them. This does not provide durable delivery or recovery across restarts.

Each backend launch explicitly creates a fresh persistent Pi session through `createVoiceSessionManager` in `src/agents/ava/voice-session.ts`. Files are grouped by Live call under ``join(getAgentDir(), "sessions", `ava-voice-${liveSessionId}`)`` (normally `~/.pi/agent/sessions/ava-voice-<LIVE_SESSION_ID>/`). The terminal prints `Voice Pi session:` and `Session file:` at startup, and Pi stores the display name `Ava voice: <LIVE_SESSION_ID>`.

Pi creates the JSONL file when the first user message is recorded, not merely when the backend attaches. In this integration, that means the first non-empty delegation accepted by Pi. Opening a call, receiving transcript fragments without delegation, or receiving an empty delegation does not create a conversation file. The JSONL contains delegated transcript batches, Pi replies, and tool calls/results; it is not a complete archive of everything spoken to GPT-Live. Older voice files remain in Pi's default project directory alongside terminal files; they are not migrated or deleted.

Automatic voice session resume is not configured: restarting the backend creates another file even for the same Live ID. Shutdown clears collection timers, aborts active work, and disposes the Pi session. Local tests use a fake socket and controlled timers, with no model or network calls. The incremental behavior still needs a live voice check.

### Facial expression tool

`src/agents/ava/tools/set-expression.ts` defines a native Pi tool. The voice entry point injects the local Orb client and selects this tool alongside time and web search through `customTools` and `tools`. The session factory retains `noTools: "all"` as its default; the installed SDK gives an explicit tool selection precedence. No built-in coding tools are enabled.

Use the matching `feat/orb-set-expression` implementation in the Ava Orb repository. Put a random, private `AVA_ORB_BRIDGE_TOKEN` in `ava-orb/voice/.env`, and load that same file in both processes. A token was configured locally during this implementation; it is not committed. Do not use the OpenAI API key as this token. For another installation, generate a new random token with at least 32 bytes of entropy.

The Orb server defaults to port 3000. If you change it, set `AVA_ORB_BRIDGE_URL=http://127.0.0.1:<port>` for the Pi backend. This transport accepts only local HTTP origins.

1. Restart the Orb server and reload the browser to load the new client.
2. Start a new voice call. The server creates a separate browser credential for that Live session and opens an SSE connection for expression commands.
3. Start `voice-preview.js` with the new Live session ID, using the two environment files shown above.
4. Say: "Ava, use set_expression para fazer uma piscadinha por cinco segundos."

The tool sends an authenticated HTTP request to the Orb server. The browser applies the mapped expression with `orb.setExpression` and acknowledges it. Only then does the tool return success to Pi. Automatic expressions from speech cannot replace an explicit expression until its duration expires; a later explicit command can replace it. Allowed names are `neutra`, `atenta`, `pensativa`, `feliz`, `surpresa`, `sonolenta`, `piscadinha`, `triste`, and `desconfiada`. Duration defaults to 3000 ms and must be an integer from 800 to 15000 ms.

On 2026-10-12, the owner followed the voice test above and confirmed that the expression integration worked in a live call. This is owner-reported manual validation, separate from the automated transport and tool tests.

Missing credentials disable the tool with a startup warning. A missing browser, disconnect, invalid command, or missing acknowledgement produces a tool error. A timeout means application was not confirmed, not proof that nothing changed; commands are not automatically retried. The acknowledgement confirms the browser called the rendering API, not that the user saw it. Restart the voice session after an expression-connection failure. `web_search` and `get_local_time` work independently of the expression bridge.

### Local time and web search

Both tools are registered with Pi's native `defineTool` in `src/agents/ava/tools/` and selected by the voice entry point. Pi retains the agent loop, tool validation, result recording, and conversation history. Terminal and Telegram retain their existing configuration.

- `get_local_time` returns a fresh date, time, weekday, UTC offset, and UTC timestamp for `America/Sao_Paulo`. It uses Node's clock and `Intl`, without a network request or a dependency on the host's default time zone.
- `web_search` accepts a focused query and calls OpenAI's hosted `web_search` through the Responses API. It uses `OPENAI_API_KEY` from the same environment file as the Live connection. The search model defaults to `gpt-6-astra`; optionally set `AVA_WEB_SEARCH_MODEL` to another Responses model that supports web search. This selection is separate from `AVA_MODEL_ID` and incurs its own model/search API usage.

The installed Pi tool API describes callable functions, so the OpenAI hosted tool is wrapped in one native Pi tool. Each execution makes one Responses request, forces search, sets `store: false`, and sends only the query rather than Pi's conversation history. There is no second application-managed agent loop or search conversation. Returned text includes separate lists of cited and consulted sources. See the [official web-search guide](https://developers.openai.com/api/docs/guides/tools-web-search).

Search has a 60-second timeout, a 2000-character query limit, and a 4096-token output budget. Incomplete results, missing search execution, API errors, and malformed responses become tool errors. Session cancellation aborts the request; no automatic retry is performed. Raw provider errors and credentials are not added to tool results.

Restart both applications and start a new Live session using the same commands as above. The backend logs `Voice tools enabled:` at startup. Try:

1. "Ava, use get_local_time e me diga a data e a hora em São Paulo."
2. "Ava, pesquise na web uma notícia recente sobre exploração espacial e cite a fonte."

The matching Orb changes prompt GPT-Live to delegate these requests and preserve source URLs. URLs and Markdown links relayed in its transcript become clickable, without interpreting transcript content as HTML. This still depends on GPT-Live relaying the links; it is not a separate source-delivery protocol.

The eight time/search tests use a fixed clock and injected HTTP responses. No paid OpenAI search was performed during implementation; account/model access and the new live voice flow still need a manual test.
