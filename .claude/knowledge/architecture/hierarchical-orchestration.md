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
Human → Arbiter (manager, structured outputs) → Orchestrators (workers) → Subagents (do actual work)
```

## How Orchestrator Spawning Works (Intent-Based)

The system uses intent-based structured outputs instead of MCP tools:

1. Arbiter's query uses `outputFormat` with Zod schema requiring `intent` field
2. When Arbiter wants to spawn an orchestrator, it returns `intent: 'summon_orchestrator'`
3. Router extracts `structured_output` from result message
4. Router switches on intent and spawns Orchestrator session
5. This is deterministic - no "forgetting" to call tools

See [Intent-Based Routing](intent-based-routing.md) for full details on the routing architecture.

## UI Model - Each Other's Users

The UI is NOT relaying messages between sessions. It's showing THE ARBITER'S CONVERSATION with its "user" correctly labeled.

**Main Chat = Arbiter's perspective:**
- At first, the human is the Arbiter's user → shows as "You:"
- Once orchestrator spawned, they become EACH OTHER'S USERS:
  - Orchestrator is the user of Arbiter → shows as "Orchestrator I:"
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

## Macro-Delegation Pattern

The Arbiter's context is precious - it needs to last across potentially dozens of Orchestrators over days of work. Every handoff consumes Arbiter context, so we minimize the NUMBER of handoffs, not their thoroughness.

### The Right Pattern

1. **Arbiter gives ENTIRE projects** - All phases, full scope, complete context to one Orchestrator
2. **Thorough upfront conversation** - Orchestrator asks ALL questions, as many exchanges as needed
3. **Independent work after alignment** - Orchestrator works until context exhausted (not forbidden from asking, just shouldn't need to)
4. **Thorough handoff when it happens** - Back-and-forth, detailed conversation to preserve context for next Orchestrator
5. **Arbiter manages all handoffs** - No auto-chaining; Arbiter maintains vision and decides next steps

### The Wrong Pattern (Micromanagement)

- Give phase 1 → handoff → give phase 2 → handoff → ... → give phase 8
- Burns 8 handoffs worth of context for one project

### Key Distinctions

- Orchestrators SHOULD ask questions during upfront conversation
- Orchestrators should NOT need to surface mid-work because everything was established upfront
- If something genuinely unexpected arises, asking is fine - it should just be rare
- Handoffs should be thorough and conversational, not brief
- The goal is 2-3 handoffs per large project instead of 8+

### What Counts as a Genuine Blocker

- Missing credentials/access
- Fundamental ambiguity that would waste significant work if guessed wrong
- External dependency requiring Human input

### NOT Blockers (Use Judgment)

- Minor implementation decisions
- Choosing between reasonable approaches
- Edge cases not explicitly covered

## Key Files

- src/arbiter.ts: Arbiter system prompt and output schema (intent-based, no MCP tools)
- src/router.ts: Message routing, session management, intent-based switching
- src/orchestrator.ts: Orchestrator session with full tools + blocking subagents
