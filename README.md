# The Arbiter

> OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE

A hierarchical AI orchestration system that extends Claude's effective context window by managing a chain of Claude sessions through the Agent SDK.

## Warning

**This tool runs with full permissions (`permissionMode: 'bypassPermissions'`).**

It is designed for controlled environments where you trust the AI agents to have full access to your system. Do not run on systems with sensitive data you don't want AI agents to access.

## How It Works

```
Human (you)
   ↕ conversation
Arbiter (Claude session - the manager)
   ↕ conversation
Orchestrators (Claude sessions - the workers)
   ↓ spawns subagents
   Subagents (do the actual work)
```

Each layer has its own ~200K context window. By delegating work downward, we can accomplish tasks that would be impossible in a single session.

## Running

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Production (after build)
npm run build
npm start
```

## Usage

1. The Arbiter greets you and asks what task you need
2. Clarify your requirements through conversation
3. The Arbiter spawns Orchestrators to do the work
4. Orchestrators use subagents for discrete tasks
5. Results flow back up through the hierarchy

## Key Controls

- Type your message and press Enter
- `Tab` - Toggle logbook (raw log view)
- `Ctrl+C` or `q` - Quit

## Testing

### Headless End-to-End Test

There's a headless test that exercises the full system without the TUI:

```bash
npm run test:headless
```

This test:
1. Creates initial state and a mock router with console-logging callbacks
2. Starts the Arbiter session
3. Sends a test message ("Hello, what are you?")
4. Waits for and logs the Arbiter response
5. Sends a second message asking to spawn an orchestrator
6. Watches the orchestrator spawn, do work, and report back
7. Logs all context percentages, tool usage, and messages

**Why this is useful:**
- Tests the full SDK integration without needing an interactive terminal
- Verifies Arbiter → Orchestrator → Subagent flow works
- Can run in CI or non-TTY environments
- Great for debugging routing and session issues

The test file is at `src/test-headless.ts` - you can modify it to test specific scenarios.

## Architecture

See `arbiter-architecture.md` for detailed architecture documentation.
See `docs/tui-redesign.md` for the upcoming RPG-style TUI redesign.

## Session Persistence

On exit, session IDs are output to stderr:
```json
{"arbiter": "session-abc", "lastOrchestrator": "session-xyz", "orchestratorNumber": 3}
```

These can be used to resume sessions in future versions.
