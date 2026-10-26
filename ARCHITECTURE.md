# Ava architecture

Ava uses Pi as its agent harness. The application selects a model and supplies an interface; Pi provides the agent loop, model requests, context assembly, session storage, and tool execution.

## Current milestone

The terminal is connected to Pi through `createMessageHandler(session)`, extracted by the owner into `src/core/handler.ts`. The entry point creates the session and handler, starts the terminal, and disposes the session on exit. The handler owns the per-message subscription, text streaming, and cancellation bridge.

Telegram now uses the same Pi core and AVA configuration through its own application entry point. Each authorized private chat has a separate persistent Pi session. The owner confirmed that restarting the Telegram application resumes the conversation correctly.

Voice is the third Pi-backed channel: Ava Orb maintains the GPT-Live audio session, while `voice-preview.ts` attaches a backend connection and creates a separate Pi conversation. The owner implemented and tested this integration. The voice path now sends incremental transcript batches; its diagram below shows collection, queuing, and the Pi connection.

AVA-specific configuration and resource policy now live in `src/agents/ava/config.ts` and `src/agents/ava/resources.ts`. The terminal supplies both to `createSession(modelConfig, { cwd, resourceLoader })` in `src/core/session.ts`. Telegram also supplies a chat-specific `sessionManager`; voice supplies a fresh manager in a Live-call-specific directory. The core does not import AVA settings or choose her context policy. The factory retains `noTools: "all"` as its default. Voice explicitly enables `get_local_time` and `web_search`, plus `set_expression` when configured; terminal and Telegram have no enabled tools. Calendar tools, personal memory, and Pi Durable are future work.

## Current component diagram

All connections below are implemented. Terminal and Telegram reuse the same core functions while keeping separate live sessions and histories.

```mermaid
flowchart LR
    subgraph Ava["AVA configuration and resource policy"]
        Config["agents/ava/config.ts<br/>Validate model settings"]
        Resources["agents/ava/resources.ts<br/>Configure and reload Pi DefaultResourceLoader"]
    end
    Config -->|"modelConfig"| Entry["terminal-preview.ts"]
    Resources -->|"Loaded resourceLoader"| Entry
    Entry -->|"modelConfig + cwd + resourceLoader"| Factory["Session factory<br/>core/session.ts"]
    Factory -->|"Create once at terminal startup"| Session["Terminal Pi AgentSession"]
    Entry -->|"createMessageHandler(session)"| Handler["Terminal handler<br/>core/handler.ts"]
    Entry -->|"runTerminal(handler)"| Terminal["Terminal interface<br/>terminal.ts"]
    Terminal -->|"message + signal"| Handler
    Handler -->|"prompt / abort"| Session
    Session -->|"text_delta events"| Handler
    Handler -->|"write(delta)"| Terminal
    Session <-->|"Model request / response"| Model["Selected model"]
    Session --> History["Pi session storage"]
    Config --> TelegramApp["telegram.ts<br/>createConversation(chat)"]
    Resources --> TelegramApp
    TelegramApp --> Manager["Pi SessionManager.continueRecent<br/>Chat-specific directory"]
    Manager -->|"Selected sessionManager"| TelegramApp
    TelegramApp -->|"modelConfig + cwd + loader + manager"| Factory
    Factory -->|"Create or restore one per chat"| TelegramSession["Telegram Pi AgentSession"]
    TelegramApp -->|"Return handler + dispose"| Telegram["Telegram channel<br/>channels/telegram/channel.ts"]
    Telegram -->|"message + signal"| TelegramHandler["Per-chat handler<br/>core/handler.ts"]
    TelegramHandler -->|"prompt / abort"| TelegramSession
    TelegramSession -->|"text_delta events"| TelegramHandler
    TelegramHandler -->|"write(delta)"| Telegram
    TelegramSession <-->|"Model request / response"| Model
    TelegramSession --> ChatHistory["Pi JSONL files<br/>ava-telegram-chatId"]
    Manager -->|"Open latest matching session"| ChatHistory
```

`terminal-preview.ts` imports `modelConfig`, awaits `createAvaResourceLoader(cwd)`, and calls `createSession(modelConfig, { cwd, resourceLoader })`. It passes the resulting live session to `createMessageHandler` and owns session disposal. The loader and session receive the same working directory. The Telegram entry point composes the same factories for each chat and supplies a `Conversation` with a handler and disposal function. Channel modules remain independent of Pi; sharing factories does not share live sessions.

## Voice channel: GPT-Live with a Pi backend

The owner replaced the simulated conversation with AVA resources, `createSession`, and `createMessageHandler`, and supplied a live log showing backend results returned to GPT-Live and reformulated in its output transcript. Each backend process creates one Pi session and reuses it across delegations. The latest update sends only new transcript fragments rather than resending all voice history.

```mermaid
flowchart LR
    User["You"] <-->|"Audio"| Orb["Ava Orb"]
    Orb <-->|"WebRTC"| Live["GPT-Live session"]
    Live -->|"Transcript deltas + client delegations"| Client["voice/live-client.ts<br/>Backend WebSocket attachment"]
    Client --> Buffer["voice/transcript.ts<br/>Pending fragments"]
    Buffer -->|"takeSnapshot: reserve new arrivals"| Queue["Sequential delegation queue<br/>Disjoint frozen batches"]
    Queue --> Adapter["voice/adapter.ts<br/>createVoiceAdapter"]
    Settings["AVA config + resource loader"] --> Preview["voice-preview.ts"]
    Preview -->|"Live session ID + cwd"| Manager["agents/ava/voice-session.ts<br/>Pi SessionManager.create"]
    Manager -->|"Persistent sessionManager"| Preview
    Preview -->|"createSession with manager"| Pi["Voice Pi AgentSession"]
    Preview -->|"Supplies Conversation"| Handler["createMessageHandler<br/>core/handler.ts"]
    Adapter -->|"New transcript batch + signal + write"| Handler
    Handler -->|"prompt / abort"| Pi
    Pi -->|"text_delta"| Handler
    Handler -->|"Text chunks"| Adapter
    Pi <--> History["Pi JSONL history<br/>ava-voice-LiveID"]
    Manager -->|"Select fresh file; name session"| History
    Preview -->|"Register and select"| Time["get_local_time<br/>System clock + Intl"]
    Preview -->|"Register and select"| Search["web_search<br/>Native Pi tool"]
    Pi <-->|"Native tool call / current timestamp"| Time
    Pi <-->|"Native tool call / answer and sources"| Search
    Search <-->|"One Responses request, query only"| Web["OpenAI hosted web_search"]
    Preview -->|"Register and select set_expression"| Tool["AVA expression tool"]
    Pi -->|"Native tool execution"| Tool
    Tool <-->|"Authenticated HTTP request / confirmation"| OrbServer["Orb server<br/>Session-scoped expression bridge"]
    OrbServer <-->|"SSE command / HTTP acknowledgement"| Orb
    Adapter -->|"delegationId + complete text"| Client
    Client -->|"session.commentary.append"| Live
```

Responsibilities:

- `voice-preview.ts` reads the Live session ID and API key, loads AVA model settings and resources, creates a Pi session, and supplies its conversation to the adapter. A short message wrapper explains that each transcript batch is incremental and earlier context is already in Pi history. The entry point owns connection shutdown, session abort, and disposal.
- `agents/ava/voice-session.ts` selects a dedicated directory per Live call and creates a fresh native persistent manager with a readable session name. The entry point injects it into the shared factory and prints the selected session ID and file path.
- `channels/voice/live-client.ts` validates incoming events, identifies and logs the speaker, manages collection timers and the sequential queue, and sends results with the delegation ID. It reserves the batch before queuing, independently of how long preceding requests take. A socket factory is injectable for local tests; production uses `ws`.
- `channels/voice/transcript.ts` holds only pending arrivals. `takeSnapshot(offsetMs)` drains that buffer into an immutable JSON batch sorted by audio timestamps. Text and spaces are preserved. The offset is metadata, not a cutoff or progress cursor. Late fragments with older or overlapping timestamps remain eligible for the next batch.
- `channels/voice/adapter.ts` invokes the injected `Conversation`, accumulates its `write` calls, honors cancellation, rejects concurrent invocations, and returns `{ delegationId, text }`. The connector serializes calls to it.
- The existing Pi core continues to own prompting, context assembly, and persistent history. Voice modules do not implement a second agent loop or parse Pi session files.

```mermaid
sequenceDiagram
    participant Live as GPT-Live
    participant Client as Voice client
    participant Buffer as Pending transcript fragments
    participant Queue as Delegation queue
    participant Adapter as Voice adapter
    participant Pi as Shared voice Pi session
    participant Disk as Pi JSONL file
    Live->>Client: User and assistant transcript deltas
    Client->>Buffer: Append exact text, speaker, and timestamps
    Live->>Client: Client delegation with ID and offset
    Note over Client: Open collection window: 800 ms idle / 2 s maximum
    Live->>Client: More user or assistant fragments
    Client->>Buffer: Append; only user arrivals reset idle timer
    Note over Client: Idle deadline, maximum deadline, or next delegation
    Client->>Buffer: takeSnapshot(offset)
    Buffer-->>Client: New fragments only; pending buffer drained
    Client->>Queue: Reserve immutable batch for this delegation
    Live->>Client: Late fragment, possibly with an older audio timestamp
    Client->>Buffer: Keep for the next delegation
    Queue->>Adapter: Process batch after preceding work settles
    Adapter->>Pi: Prompt through createMessageHandler
    Pi->>Disk: Persist delegated user message (create file on first prompt)
    Note over Pi: Earlier batches and replies come from Pi's own history
    Pi-->>Adapter: Stream response text
    Pi->>Disk: Persist reply and tool events
    Adapter-->>Client: Complete response with delegation ID
    Client->>Live: session.commentary.append
    Live-->>Client: session.commentary.appended
```

### Initial voice connection failures

`live-client.ts` retries only unsuccessful initial HTTP handshakes with status 429, 502, 503, or 504. Backoff is 1, 2, then 4 seconds; there are at most four attempts, each with a 10-second handshake timeout. A longer `Retry-After` is honored up to 30 seconds; excessive requested waits stop the run instead of retrying prematurely. Other HTTP responses and transport errors end the connection. The same Pi session and injected handler are retained across attempts; only the unopened socket is replaced.

Retired sockets cannot deliver transcript events or close their replacements. Their HTTP responses and sockets are closed, and shutdown clears retry and transcript-collection timers. `voice-preview.ts` catches connection failures, prints the reason and HTTP guidance, sets a nonzero exit status, and disposes the Pi session. The Orb call must remain active and use the same OpenAI project as the backend credentials.

After a successful attachment, errors or closure stop the connection without automatic reattachment, history replay, or retrying a delegation. Initial-connection resilience is separate from the deferred delivery-recovery policy. A 503 is not evidence of a session-storage failure; before a delegated Pi prompt there may be no JSONL file yet.

### Incremental transcript policy

The first batch contains all valid fragments received since attachment. Each later batch contains only arrivals that were not reserved by a previous batch. Membership uses arrival order rather than an audio timestamp watermark: a delayed fragment must not be discarded simply because its `endMs` is earlier than a previously sent fragment. Sorting affects presentation within each batch, not membership.

Reserving happens at collection close, before queue insertion. A slow handler cannot cause later queued delegations to capture overlapping batches. The connector retains neither a second full transcript nor a cursor into Pi history. New assistant speech remains useful voice context even when it paraphrases an earlier backend reply. If no fragments arrived, the snapshot is empty and the entry point returns a clarification without prompting Pi or replaying the previous request.

A new delegation closes the preceding collection immediately and opens its own window. Both timers are cleared when a window finishes. User arrivals reset the 800 ms idle timer, while the 2-second maximum remains fixed. Assistant output does not extend either timer. This is a collection heuristic, not turn detection: a delivery gap is not proof of silence, and an unrelated utterance can arrive inside the window. Fragments after freezing wait for a later delegation and do not steer active work.

A reserved batch is not automatically replayed after handler or result-delivery failure: the underlying Pi session may already contain its prompt, even if generation failed. The error is reported and later requests keep their own batches. Pending buffers and queued batches are not durable and cannot be recovered after restart. This policy avoids blind duplicate prompts; it does not guarantee exactly-once delivery or lossless recovery.

Closing the connection or receiving a socket error aborts the shared signal and clears collection timers. Frozen requests waiting in the queue are skipped, and active results are not sent after abort. The entry point awaits Pi abort and disposes the session. Individual spoken cancellation and live task steering are not implemented. Result acknowledgement confirms submission to GPT-Live, not that the user heard it.

### Voice session lifetime and validation

The voice entry point supplies `createVoiceSessionManager(cwd, liveSessionId)` from `agents/ava/voice-session.ts`. It uses Pi's native `SessionManager.create` with ``join(getAgentDir(), "sessions", `ava-voice-${liveSessionId}`)`` and names the session `Ava voice: <LIVE_SESSION_ID>`. Live IDs are validated before use in a directory name. Startup logs show the selected Pi session ID and JSONL path. Each backend launch starts a fresh file, even for the same Live call. It does not automatically resume a voice conversation or share Telegram/terminal history. It reuses AVA's `.pi/SYSTEM.md`, context-file policy, and explicit model selection. Its explicit tool list enables `get_local_time` and `web_search`, plus `set_expression` when the local Orb bridge is configured. The Live voice model and the delegated Pi model are separate choices.

Pi creates the JSONL file only once a user or assistant message is recorded. Setup entries and transcript receipt alone do not create it. The current voice composition records non-empty delegations through `session.prompt`; the file contains those batches, Pi replies, and tool events, not the full independent GPT-Live conversation. Existing voice files in Pi's default project directory are preserved. No manual JSONL writer or second history store is introduced.

Three storage tests use the real Pi `SessionManager` in temporary directories to verify first-message file creation, reloading saved history, separation between launches/calls, and invalid path rejection. They do not call a model.

Local channel tests cover both speakers, collection deadlines, disjoint queued batches, late fragments with old or equal timestamps, empty batches, failure behavior, and shutdown. They inject a fake socket and a local conversation; they do not call Pi or GPT-Live. The owner confirmed the earlier Pi-backed round trip. Incremental delivery is locally verified and still needs a live voice check.

References: [Live transcript deltas](https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas), [Live delegation](https://developers.openai.com/api/docs/guides/live-delegation), and [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls).

### Voice expression tool

`agents/ava/tools/set-expression.ts` uses Pi's `defineTool` and TypeBox schema, exported by `pi-ai`. It accepts nine Portuguese expression names and an optional integer duration (800–15000 ms, default 3000). It receives an injected application callback; the Pi core does not depend on Orb. `channels/voice/orb-client.ts` implements that callback with a local, authenticated HTTP request scoped to the active Live session.

The native session factory forwards `customTools` and `tools`. In the installed SDK, an explicit `tools` list takes precedence over the `noTools: "all"` default. `voice-preview.ts` registers and selects `set_expression` when `AVA_ORB_BRIDGE_TOKEN` exists, alongside time and web search. Without the bridge token, only expressions are disabled and a warning is printed. The default URL is `http://127.0.0.1:3000`, configurable through `AVA_ORB_BRIDGE_URL`. Terminal and Telegram do not inherit voice capabilities.

The matching Ava Orb implementation lives in the separate `ava-orb` repository. Its local server registers a random browser credential when it creates a Live session, forwards expression commands over Server-Sent Events, and holds each backend request until the correct browser acknowledges it. The shared bridge token stays in server environments; the browser gets only its session-specific credential. Pi's tool result contains no credentials.

```mermaid
sequenceDiagram
    participant Pi as Pi AgentSession
    participant Tool as set_expression
    participant Server as Local Orb server
    participant Browser as Orb browser
    Pi->>Tool: expression + optional duration_ms
    Tool->>Server: POST expression, Live session ID, bearer token
    Server->>Browser: SSE command with request ID and expiry
    Browser->>Browser: Validate and call orb.setExpression
    Browser->>Server: POST acknowledgement with browser credential
    Server-->>Tool: Confirm application for this request
    Tool-->>Pi: Tool result: applied, expression, duration_ms
```

The browser ignores expired commands and keeps speech-driven expressions from overwriting an explicit expression during its requested duration. A newer explicit command can replace it. Disconnects reject pending calls, remove the browser session, and require a new voice call. Unattached sessions expire after 30 seconds; commands expire after 5 seconds, with a 6-second backend HTTP deadline. Aborting stops the wait but cannot undo an expression already applied. Neither side retries commands automatically; a lost acknowledgement is an unknown result, not a successful application.

The bridge uses Node's HTTP server and browser `EventSource`, without an additional transport framework or changes to GPT-Live's event schema. It is local-only and is not a multi-user deployment design. The time and web-search tools run in the Pi backend and do not use this bridge.

### Time and web-search tools

`get-local-time.ts` reads the system clock on every call and formats it with `Intl.DateTimeFormat` in `America/Sao_Paulo`. It returns both local fields and a UTC timestamp. The clock is injectable for deterministic boundary tests; the host's default time zone does not affect the result.

`web-search.ts` registers a callable Pi tool whose implementation makes one `fetch` request to OpenAI Responses with hosted `web_search`. The Pi SDK's function-tool contract is reused; no provider payload hooks, replacement session manager, or second application agent loop are introduced. The hosted service performs the search and returns its answer to Pi as a tool result.

The request contains only the query, requires search, and disables response storage with `store: false`. It uses `OPENAI_API_KEY` and `AVA_WEB_SEARCH_MODEL` (default `gpt-6-astra`), independently of the Pi model/provider. The query is limited to 2000 characters, output to 4096 tokens, and the request to 60 seconds. Errors and incomplete/non-search responses are rejected without exposing raw API errors or automatically retrying. Pi's abort signal propagates to the HTTP request.

The result retains the answer, its URL citations, and other consulted sources. Web content is treated as external evidence. Pi is prompted to cite sources, and GPT-Live is prompted to preserve those URLs when relaying the answer. The Orb renders relayed HTTP(S) links as safe, clickable DOM elements; link delivery still depends on the voice model's output.

```mermaid
sequenceDiagram
    participant Live as GPT-Live
    participant Pi as Pi AgentSession
    participant Time as get_local_time
    participant Search as web_search
    participant API as OpenAI Responses
    Live->>Pi: Delegate request through the existing voice adapter
    opt Resolve current date or time
        Pi->>Time: Native tool call
        Time-->>Pi: Sao Paulo date/time and UTC instant
    end
    opt Request requires web research
        Pi->>Search: Focused query
        Search->>API: Required hosted web_search, store false
        API-->>Search: Completed answer, citations, consulted sources
        Search-->>Pi: Native tool result
    end
    Pi-->>Live: Answer with source links when applicable
```

The session factory and handler are unchanged. The voice entry point composes the two tools with optional expressions. Terminal and Telegram have no tools enabled. Search and time have local automated coverage; live search permissions, model compatibility, and link relay require a manual test.

## Model and session setup

The terminal and voice entry points each call `createSession(modelConfig, options)` once at startup, creating separate sessions. Telegram calls it lazily for each chat's first ordinary message in the current process. The factory receives `provider`, `modelId`, and `thinkingLevel`, plus optional native Pi `cwd`, `resourceLoader`, and `sessionManager` options, and returns `Promise<AgentSession>`.

```mermaid
flowchart LR
    Config["Model configuration<br/>Provider + model ID + thinking level"]
    Runtime["Pi ModelRuntime<br/>Find the model definition"]
    Session["Pi AgentSession<br/>Use the selected model"]
    Config --> Runtime --> Session
```

`src/agents/ava/config.ts` reads and validates the environment. `src/core/session.ts` exports the `ModelConfig` interface and the `createSession` factory. The factory creates the Pi model runtime, resolves the supplied provider and model ID, rejects a missing model, and passes the supplied options to Pi's `createAgentSession` with the selected model and thinking level.

`ModelConfig.thinkingLevel` reuses `NonNullable<CreateAgentSessionOptions["thinkingLevel"]>` from the installed SDK. This keeps the supported values aligned with Pi and makes the field required in the application contract. Runtime environment validation remains in AVA's `config.ts`.

The second parameter uses `Pick<CreateAgentSessionOptions, "cwd" | "resourceLoader" | "sessionManager" | "customTools" | "tools">`. It reuses the SDK's types, and the core forwards these options to Pi. All three AVA entry points supply an already-loaded resource loader. Voice also injects its tools and an explicit selection. Telegram also selects its persistent manager; the terminal leaves manager creation to Pi's default. Without a supplied loader, Pi uses its default loader.

## AVA configuration and context policy

`src/agents/ava/config.ts` owns model selection from the environment. `src/agents/ava/resources.ts` owns AVA's resource-loading choices. Neither creates a session or implements an agent loop.

`createAvaResourceLoader(cwd)` constructs Pi's `DefaultResourceLoader` with the supplied working directory and `getAgentDir()`, awaits `loader.reload()`, and returns it. Reloading happens before session creation because the SDK does not reload a caller-supplied loader automatically.

| Resource or behavior | Current AVA policy |
| --- | --- |
| Model settings | Validate `AVA_MODEL_PROVIDER`, `AVA_MODEL_ID`, and `AVA_MODEL_THINKING_LEVEL` in `config.ts`. |
| Context files such as `AGENTS.md` | Set `noContextFiles: true` to disable automatic context-file discovery, including coding instructions from the repository, parent directories, and Pi's agent directory. |
| `.pi/SYSTEM.md` | Preserve Pi's native system-prompt discovery for the trusted project. No hardcoded `systemPromptOverride` is supplied. |
| `APPEND_SYSTEM.md` | Keep `appendSystemPromptOverride: () => []`, so these additions are omitted. |
| Skills and extensions | Leave Pi's normal discovery behavior unchanged. The context-file flag does not disable these resources. |
| Session history | Keep Pi's session storage and context assembly. Disabling context files does not disable history or make other saved sessions automatically available. |
| Tools | Default to `noTools: "all"`; voice alone selects `set_expression` when the Orb bridge is configured. |

```mermaid
flowchart LR
    Policy["agents/ava/resources.ts<br/>Native loader options"] --> Loader["Pi DefaultResourceLoader<br/>await reload()"]
    Persona[".pi/SYSTEM.md<br/>AVA persona"] -->|"Native discovery"| Loader
    Guidelines["AGENTS.md and other context files"] -.->|"Excluded by noContextFiles"| Excluded["Not added automatically"]
    Append["APPEND_SYSTEM.md"] -.->|"Empty append override"| Excluded
    Loader -->|"resourceLoader supplied through core/session.ts"| Session["Pi AgentSession"]
    History["Active session history"] --> Session
    Session --> Context["Pi context assembly"]
    Context --> Model["Selected model"]
```

These are application choices expressed through Pi's existing options. Pi still assembles the actual model context. The policy is applied when the entry point supplies AVA's loader; it is not a new global default for every core session, and it does not prevent extensions from contributing context through their own hooks.

## Terminal interface: implemented

```mermaid
flowchart LR
    User["You"] -->|"Type a message"| Terminal["Terminal interface"]
    Terminal -->|"handleMessage({ message, write, signal })"| Handler["createMessageHandler<br/>core/handler.ts"]
    Handler -->|"write(text chunk)"| Terminal
    Terminal -->|"Display reply"| User
    Entry["Pi application entry point"] -->|"Supplies the handler"| Handler
```

The `createMessageHandler` factory returns `Conversation["handleMessage"]` from `src/channels/contracts.ts`. Its input is structurally compatible with the existing terminal contract, so no terminal-interface changes were needed. It receives one object containing `message`, `write`, and `signal`:

- `message`: the trimmed, nonempty message entered by the user.
- `write(text)`: immediately appends a text chunk to the terminal. Call it repeatedly for streaming output.
- `signal`: is aborted when the terminal is interrupted or shuts down. A connected handler must cooperate with cancellation.

The terminal awaits each handler before starting the next message. Blank messages are skipped, `/exit` ends the conversation, and handler errors are displayed so another message can be entered. Ctrl+C or SIGTERM requests cancellation of an active handler. End of input finishes queued messages and closes the loop.

The terminal owns its input interface and listeners. It does not own or dispose a Pi session.

## Pi connection: implemented

`src/core/handler.ts` exports `createMessageHandler(session)`. This factory returns a handler that closes over the supplied Pi session; it does not create or dispose a session.

For each message, the handler:

1. Returns immediately if the request signal is already aborted.
2. Subscribes before prompting and forwards `message_update` / `text_delta` events to `write`, unless cancellation has been requested.
3. Bridges the abort signal to `session.abort()`.
4. Awaits `session.prompt(message)`.
5. Removes the abort listener and subscription in `finally`.

`src/terminal-preview.ts` creates one session with `createSession(modelConfig, { cwd, resourceLoader })`, passes it to `createMessageHandler`, and awaits `runTerminal(handleMessage)`. Its outer `finally` disposes the session when the terminal finishes.

The prompt and subscription must use the same live session object. Reuse that object across messages so Pi maintains the conversation history. The handler does not implement a queue: the terminal already awaits each invocation. If multiple channels later target one live session, serialization must be enforced across those callers; sharing handler code does not require sharing a session.

## Conversation sequence

```mermaid
sequenceDiagram
    actor User
    participant App as terminal-preview.ts
    participant Resources as AVA resource factory
    participant Loader as Pi DefaultResourceLoader
    participant Factory as createSession (core/session.ts)
    participant Terminal as Terminal interface
    participant Handler as createMessageHandler
    participant Pi as Pi AgentSession
    participant Model as Selected model
    Note over App: Import modelConfig from agents/ava/config.ts and choose cwd
    App->>Resources: await createAvaResourceLoader(cwd)
    Resources->>Loader: Construct with AVA resource options
    Resources->>Loader: await reload()
    Loader-->>Resources: Resources loaded
    Resources-->>App: resourceLoader
    App->>Factory: await createSession(modelConfig, { cwd, resourceLoader })
    Factory->>Pi: Create session with selected model and resources
    Factory-->>App: session
    App->>Handler: createMessageHandler(session)
    Handler-->>App: handleMessage
    App->>Terminal: await runTerminal(handleMessage)
    Note over Handler,Pi: Same live session across this terminal conversation
    loop Each user message (sequential)
        User->>Terminal: Enter a message
        Terminal->>Handler: await handleMessage({ message, write, signal })
        Handler->>Pi: Subscribe to session events
        Note over Handler,Pi: Request abort signal calls session.abort()
        Handler->>Pi: await session.prompt(message)
        Pi->>Pi: Assemble context from the active session
        Pi->>Model: Send model request
        loop Response text arrives
            Model-->>Pi: Text chunk
            Pi-->>Handler: message_update / text_delta
            Handler->>Terminal: write(delta), unless aborted
            Terminal-->>User: Display text chunk
        end
        Pi->>Pi: Record the completed message
        Pi-->>Handler: Prompt finishes
        Handler->>Pi: Unsubscribe in finally
        Note over Handler: Remove abort listener in finally
        Handler-->>Terminal: Handler finishes
    end
    User->>Terminal: /exit
    Terminal-->>App: Input loop finishes
    App->>Pi: Dispose session in finally
```

The sequence is simplified to ordinary text messages without tools. Pi also manages run events, retries, and context changes internally. Cancellation requests and prompt failures still pass through the handler's cleanup path.

## Files and responsibilities

```text
AGENTS.md                    Coding-agent guidelines
.pi/
  SYSTEM.md                  AVA runtime persona
src/
  agents/
    ava/
      config.ts              AVA environment validation and model configuration
      resources.ts           AVA policy through Pi DefaultResourceLoader
      voice-session.ts       Native Pi storage selection per Live call
  core/
    session.ts               ModelConfig and createSession(modelConfig, options)
    handler.ts               createMessageHandler: prompt, stream, and abort
  channels/
    contracts.ts             Conversation identity, handler, and cleanup contract
    telegram/
      settings.ts            Telegram environment validation
      bot-api.ts             Direct Telegram Bot API client
      channel.ts             Polling, authorization, queues, streaming, and cleanup
    voice/
      adapter.ts             Conversation callback to delegation result
      live-client.ts         GPT-Live attachment, collection timers, queue, and results
      transcript.ts          Pending transcript fragments and incremental batches
  terminal.ts                Input loop and streamed text output
  terminal-preview.ts        Create session and handler, run terminal, dispose session
  telegram.ts                AVA Telegram composition and per-chat Pi session resume
  telegram-identify.ts       Local Telegram user-ID discovery
  voice-preview.ts           Attach GPT-Live to one Pi-backed AVA conversation
test/
  terminal.test.mjs          Terminal behavior checks with local callbacks
  telegram.test.mjs          Telegram checks with a fake API
  voice.test.mjs             Voice checks with a fake socket and controlled timers
  voice-session.test.mjs     Real Pi file creation and reloading in temporary directories
  voice-connection.test.mjs  Handshake retries, shutdown, and a real loopback 503 recovery
```

| Module | Input | Responsibility | Output / lifecycle |
| --- | --- | --- | --- |
| `src/agents/ava/config.ts` | `AVA_*` environment values | Validate provider, model ID, and thinking level. | Export `modelConfig`; create no Pi runtime or session. |
| `src/agents/ava/resources.ts` | `cwd` | Apply AVA policy using native Pi options and await resource loading. | Return a loaded `DefaultResourceLoader`; create no session. |
| `src/agents/ava/voice-session.ts` | `cwd`, Live session ID, optional agent directory | Select a call-specific storage directory and session name through Pi. | Return a fresh persistent `SessionManager`; no model call or manual file serialization. |
| `src/core/session.ts` | `ModelConfig` and native `cwd` / `resourceLoader` / `sessionManager` options | Resolve the model and call Pi's `createAgentSession`. | Return a live `AgentSession`; the caller owns disposal. |
| `src/core/handler.ts` | A live `AgentSession` | Adapt channel messages to Pi prompting, streaming, and cancellation. | Return `Conversation["handleMessage"]`; clean up each message's listeners. |
| `src/terminal-preview.ts` | AVA config and resource factory, core factories, terminal interface | Compose one terminal conversation using the same `cwd` for resources and session. | Await resources, create session and handler, run the terminal, and dispose the session in `finally`. |
| `src/terminal.ts` | A message handler | Read input, process messages sequentially, display reply chunks, and signal shutdown. | Own the terminal interface and its listeners. |
| `src/channels/contracts.ts` | No runtime setup | Define channel messages, identity, conversation handling, and cleanup. | Supply types without a Pi dependency. |
| `src/channels/telegram/` | Telegram settings and an injected conversation factory | Authorize users, poll updates, queue per chat, and deliver replies. | Manage channel lifecycle and call each conversation's cleanup. |
| `src/telegram.ts` | Telegram settings, AVA config and resources, chat identity, core factories | Select each chat's persistent manager and compose its Pi conversation. | Return handler and session disposal to the channel; make real model calls through the handler. |
| `src/channels/voice/` | Live events and an injected conversation | Reserve new transcript fragments into disjoint batches, serialize delegations, and return results. | Keep only pending fragments per connection; abort timers and work on close. No Pi dependency. |
| `src/voice-preview.ts` | Live session ID, `OPENAI_API_KEY`, AVA settings/resources, core factories | Select and log a fresh Pi session in a Live-call-specific directory and explain the incremental transcript format before each prompt. | Own connection cleanup and Pi abort/disposal; make real model requests. |
| Pi SDK | Configuration, messages, and registered resources | Manage the agent loop, context, model requests, and session history. | Provide the live session used by the application. |

The terminal uses Pi's default persistent manager and creates a fresh session on each launch. Telegram supplies `SessionManager.continueRecent(cwd, sessionDir)` and resumes the most recent matching session in that chat's dedicated directory. Both reuse the same live object for messages within one conversation.

## Run the terminal application

From the repository root:

```sh
npm run terminal
```

The command builds the application and loads `.env` before importing the settings module. Configure `AVA_MODEL_PROVIDER`, `AVA_MODEL_ID`, and `AVA_MODEL_THINKING_LEVEL` as described in the README, and configure the selected provider's credentials through Pi. This entry point makes real model requests. Use `/exit` to finish or Ctrl+C to cancel and exit.

```sh
npm run typecheck
npm test
```

The tests check streamed output, sequential messages, empty input, exit handling, errors, end of input, and cooperative cancellation. They do not make model requests.

AVA's resource factory uses Pi's native `.pi/SYSTEM.md` discovery while excluding automatic context files and append-system additions, as described above. Keep credentials in your local environment or Pi's authentication storage.

## Decisions

- Keep the terminal independent of Pi through a small callback contract.
- Keep the extracted handler independent of AVA configuration; it receives an existing session.
- Pass model configuration, native resource options, and optional session-manager selection into `createSession`; keep AVA environment access and context policy in `src/agents/ava/`.
- Reuse `DefaultResourceLoader` and SDK types; do not create a parallel context manager. Keep `.pi/SYSTEM.md` in its native location.
- Keep session lifetime in application setup and per-message cleanup in the handler.
- Do not duplicate Pi's agent loop or persistent history. The voice prototype keeps only a temporary transcript buffer needed to assemble delegated requests.
- Use one Pi session per terminal conversation, one separate Pi session per Telegram chat, and one voice Pi session per backend launch.
- Keep chat identity routing in application setup and persistence/context reconstruction in Pi's `SessionManager`. Use a directory per Telegram chat and per Live call; no separate transcript or mapping database is needed for the current policy.
- Let Pi own context assembly and history; do not duplicate them in the terminal.
- Use Node's built-in readline and test tools. The voice attachment uses `ws`; no new framework is introduced.
- Default to no tools; enable voice expressions through a native Pi tool and a session-scoped Orb connection.

## Pi references

- [SDK: configuring a session](https://pi.dev/docs/latest/sdk#configuring-a-session)
- [Configuration: project Pi directory](https://pi.dev/docs/latest/configuration#project-pi-directory)
- [SDK: subscribing to events](https://pi.dev/docs/latest/sdk#subscribing-to-events)
- [SDK: session storage](https://pi.dev/docs/latest/sdk#session-storage)
- [Official session-management example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/11-sessions.ts)
- [Official minimal SDK example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/01-minimal.ts)

The API notes above were checked against the project's installed Pi SDK, version 1.1.0.

## Telegram channel milestone

The Telegram channel remains independent of Pi. Its entry point now supplies real AVA conversations: it loads AVA resources, selects each chat's persistent manager, calls `createSession`, and returns `createMessageHandler(session)` plus session disposal. Terminal and Telegram reuse the core and AVA configuration.

```mermaid
flowchart LR
    User["Private Telegram chat"] <--> API["Direct Bot API client"]
    API <--> Channel["Telegram channel"]
    Channel <--> Contract["Conversation contract"]
    App["telegram.ts<br/>Pi-backed conversation factory"] -->|"Handler + disposal"| Contract
    App --> Manager["Pi SessionManager<br/>Chat-specific resume"]
    Contract <--> Pi["createMessageHandler + per-chat Pi session"]
    Pi <--> History["Pi session JSONL files"]
```

- `src/channels/contracts.ts` defines the handler, abort signal, text-delta callback, identity, and cleanup function without importing Pi.
- `src/channels/telegram/bot-api.ts` owns HTTP calls and response validation. `fetch` is injectable for local tests; errors omit token-bearing request URLs.
- `src/channels/telegram/channel.ts` owns authorization, polling, queues, commands, coalesced streaming previews, final delivery, and lifecycle. Polling continues while a handler runs. Cancellation interrupts the active request and clears its chat's pending queue.
- `src/telegram.ts` wires the channel to the Pi handler and logs the chosen session ID and file path. Its model settings are loaded at startup; resources and sessions are initialized lazily per chat.
- `src/telegram-identify.ts` helps identify the owner locally before starting polling. It sends no messages and must not run alongside another poller for the same bot.

One live conversation object is reused per chat and disposed on shutdown. The handler must honor its abort signal; shutdown waits for active handlers to settle. Pending work and offsets are held in memory. Pi session persistence and conversation resume are supplied by application setup. Queue/offset recovery and delivery retries remain deferred. Advancing a polling offset acknowledges updates; it is not proof that their replies were delivered.

Validation: fourteen Telegram tests and four terminal tests exercise channel behavior without network or model requests. On 2026-10-12, the owner tested the real Pi-backed bot in Telegram and confirmed that the conversation resumed correctly after restarting. This is owner-confirmed live verification; the local channel tests do not exercise that restart path end to end.

## Telegram session persistence and restart sequence

`conversationId` is the Telegram chat ID supplied by the channel after its private-chat and allowed-user checks. `src/telegram.ts` derives the storage directory as:

```ts
join(getAgentDir(), "sessions", `ava-telegram-${conversationId}`)
```

With Pi's default agent directory, the layout is:

```text
~/.pi/agent/sessions/
  ava-telegram-<chat-id>/
    <timestamp>_<pi-session-id>.jsonl
```

The stable directory is the chat-to-history association. `SessionManager.continueRecent(cwd, sessionDir)` opens the most recent valid session matching the current `cwd`, or creates a new manager if none exists. Pi owns the JSONL format, writes conversation entries, and rebuilds the active branch and compacted context. AVA does not parse or replay transcript files manually.

```mermaid
sequenceDiagram
    actor User
    participant Channel as Telegram channel
    participant App as telegram.ts
    participant Manager as Pi SessionManager
    participant Disk as Chat session directory
    participant Core as createSession
    participant Pi as Per-chat AgentSession
    User->>Channel: Send an authorized private text message
    Channel->>App: createConversation with chat identity
    App->>App: Load AVA resources and derive chat directory
    App->>Manager: continueRecent(cwd, sessionDir)
    Manager->>Disk: Find most recent valid session for this cwd
    alt Matching session exists
        Disk-->>Manager: Saved session entries
    else No matching session
        Manager->>Manager: Initialize a new persistent session
    end
    Manager-->>App: sessionManager
    App->>Core: createSession(modelConfig, options with manager)
    Core->>Pi: Create session and reconstruct saved context
    Core-->>App: session
    App-->>Channel: handleMessage and dispose
    Channel->>Pi: Prompt through createMessageHandler
    Pi->>Disk: Persist conversation entries
    Pi-->>Channel: Stream text through the handler
    Channel-->>User: Draft previews and final reply
    Note over Channel,Pi: Reuse this live conversation for later messages
    Note over App,Disk: After restart, the same directory restores history into a new live session
```

Session persistence and delivery recovery are separate: pending channel requests and polling offsets remain in memory, and generated responses are not automatically redelivered after a restart. This milestone assumes one bot, one active process, and a stable `cwd` and agent directory. Explicit model and thinking settings still come from AVA's current environment configuration.

## Evolution: AVA settings and resource policy separated from Pi setup

Completed by the owner on 2026-10-12:

- Replaced `src/config/runtime.ts` with the reusable `src/core/session.ts` factory.
- Moved `src/config/settings.ts` to `src/agents/ava/config.ts`, preserving model validation.
- Added `src/agents/ava/resources.ts` to configure and reload Pi's native loader with AVA's context policy.
- Extended `createSession` to accept native `cwd` and `resourceLoader` options through `Pick<CreateAgentSessionOptions, "cwd" | "resourceLoader">`.
- Connected configuration, resource loading, session creation, and the existing handler in `src/terminal-preview.ts`.
- Preserved streaming, cancellation, cleanup, session persistence, and disabled tools. The core has no import from `agents/ava`.

The component and sequence diagrams above show the implemented setup and message flow. This step changes which module chooses resources; Pi still owns resource discovery, context assembly, and session storage.

## Evolution: Telegram connected to persistent Pi conversations

Completed by the owner on 2026-10-12:

- Added native `sessionManager` injection to `createSession`.
- Replaced the simulated Telegram conversation factory with AVA resources, a chat-specific `SessionManager.continueRecent`, the shared Pi handler, and session disposal.
- Kept terminal and Telegram histories separate, with stable storage paths derived from Telegram chat IDs.
- Updated the startup and welcome messages to reflect real conversations.
- Tested the real bot and confirmed session resume after restarting the application.

## Remaining steps

Validate the new time/search flow in a live voice call and confirm that GPT-Live preserves the returned source links in the Orb transcript. The expression flow already has owner-confirmed live validation.

1. Move the terminal interface and refactor its entry point when the owner is ready; the current path still works.
2. Add focused automated coverage for per-chat Pi persistence and resume. Current automated tests cover channel behavior through injected conversations.
3. Implement the deferred delivery recovery policy when requested. Calendar tools, personal memory, and Pi Durable remain separate future milestones.
4. Test incremental voice delivery with the live Orb call. The voice adapter is connected to Pi; automatic voice-session resume, task steering, and durable delivery remain future work.

Further integration remains owner-led unless implementation is explicitly delegated. Terminal, Telegram, and voice are connected to Pi with separate session lifetimes. Telegram conversation resume is implemented and confirmed by the owner.

## Latest verification

On 2026-10-13, `npm run typecheck` and `npm test` passed: 56 local tests (four terminal, fourteen Telegram, thirteen voice delegation, nine voice connection, three voice storage, five expression tool/client, and eight time/search). The test command also compiles the project. Voice tests use the real adapter with an injected fake WebSocket, a local conversation, and controlled timers. Storage tests additionally write and reopen real Pi JSONL files in temporary directories. One connection test reproduces HTTP 503 and recovery with real `ws` against a loopback server. No OpenAI or model requests are made, so these checks do not verify live GPT-Live delivery or the complete voice-to-model integration.

Earlier live checks were performed by the owner: Telegram session resume after restarting, the simulated voice round trip, and then Pi-backed voice responses confirmed in the supplied logs. The incremental transcript update has local coverage and awaits a live check. The owner's Pi integration was preserved; only the voice prompt wrapper and log wording changed to describe incremental input.

The expression implementation additionally passed five tests in the Orb repository and an integration smoke test across both projects using real loopback HTTP/SSE, the Pi tool definition, and a rendering callback. These checks confirm command routing and acknowledgement, not browser pixels or model tool selection. No OpenAI API calls were made.

On 2026-10-12, the owner also followed the `set_expression` voice test and confirmed that the integration worked in a live call. This manual result complements the local tests; it does not establish coverage of every expression or failure path.
