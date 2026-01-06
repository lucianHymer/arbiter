# Hierarchical AI Orchestration - Context Management Design

The Arbiter is a hierarchical AI orchestration system that extends effective context by managing a chain of Claude sessions.

## The Core Insight

- Arbiter keeps Orchestrators on task
- Orchestrators keep their Subagents on task
- Each layer has ~200k context window
- Top level (Arbiter) holds the vision and problem understanding
- Lower levels do detailed work without losing the forest for the trees

## Why This Beats Serial Chaining

Serial handoffs lose context and vision. No one stays on task. The Arbiter pattern maintains an "overarching person" who has the full vision in one context window and keeps everyone aligned.

## Message Flow

```
Human → Arbiter (manager, MCP tools) → Orchestrators (workers) → Subagents (do actual work)
```

## How spawn_orchestrator MCP Tool Works

1. Tool defined with Claude Agent SDK's `tool()` helper + Zod schema
2. Registered as MCP server with Arbiter's query session
3. Claude (the AI) decides to call it via standard tool_use mechanism
4. Handler is async - stores prompt in `pendingOrchestratorPrompt`
5. After Arbiter turn completes, Router spawns the Orchestrator session
6. This is EVENT-DRIVEN with callbacks, NOT a state machine

## UI Model - Each Other's Users

The UI is NOT relaying messages between sessions. It's showing THE ARBITER'S CONVERSATION with its "user" correctly labeled.

**Main Chat = Arbiter's perspective:**
- At first, the human is the Arbiter's user → shows as "You:"
- Once orchestrator spawned, they become EACH OTHER'S USERS:
  - Orchestrator is the user of Arbiter → shows as "Conjuring I:"
  - Arbiter is the user of Orchestrator (watching/guiding)
- "Arbiter:" = Arbiter's responses to whoever is its current user

**This is NOT message relaying.** It's:
1. Human talks to Arbiter (human = user)
2. Arbiter spawns orchestrator → they hook up as each other's users
3. Now orchestrator talks to Arbiter (orchestrator = user)
4. UI just shows Arbiter's chat with correct user labels

**Debug Log = ALL raw SDK messages:**
- Both Arbiter session AND active Orchestrator session
- Every message flowing through the SDK
- Properly labeled by source session
- NOT filtered or processed versions

## Key Files

- src/arbiter.ts: MCP tool definitions (spawn_orchestrator, disconnect_orchestrators)
- src/router.ts: Message routing, session management, deferred spawning
- src/orchestrator.ts: Orchestrator session with full tools + blocking subagents
