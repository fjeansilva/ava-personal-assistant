# Ava personal assistant

A personal assistant built with TypeScript and Pi as its harness.

## Current step: terminal conversation

The terminal connects to one Pi agent session, streams replies, and supports cancellation and cleanup. Tools are disabled for this first milestone.

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

AVA's persona is in `.pi/SYSTEM.md`, loaded by Pi for the trusted project. `AGENTS.md` contains guidelines for coding agents working on this repository.

Each application run creates a new Pi session. Messages within that run share one session; resuming a previous session is not implemented yet.

## Development

```sh
npm run build
npm run typecheck
npm test
```

The tests use local callbacks and make no model requests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module responsibilities, diagrams, the terminal callback contract, and the Pi connection. See [AGENTS.md](./AGENTS.md) for coding guidelines.
