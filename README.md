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

## Architecture

See `arbiter-architecture.md` for detailed architecture documentation.
See `docs/tui-redesign.md` for the upcoming RPG-style TUI redesign.

## Session Persistence

On exit, session IDs are output to stderr:
```json
{"arbiter": "session-abc", "lastOrchestrator": "session-xyz", "orchestratorNumber": 3}
```

These can be used to resume sessions in future versions.
