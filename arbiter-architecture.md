# THE ARBITER OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE

## Overview

The Arbiter is a hierarchical AI orchestration system that extends Claude's effective context window by an order of magnitude through managing a chain of Claude sessions. It presents as an ancient, terse oracle via a terminal UI.

```
Human (you)
   ↕ conversation
Arbiter (Claude session - the manager)
   ↕ conversation (Arbiter is the "user" here)
Orchestrator I, II, III... (Claude sessions)
   ↓ spawns blocking subagents
   Agent tasks (actual code work)
```

## Architecture

Pure TypeScript implementation using the Claude Agent SDK.

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Process (TypeScript)                 │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │   State     │  │   Router    │  │   TUI (blessed)      │ │
│  └─────────────┘  └─────────────┘  └──────────────────────┘ │
│         │               │                    │               │
│         └───────────────┼────────────────────┘               │
│                         │                                    │
│         ┌───────────────┴───────────────┐                   │
│         ▼                               ▼                    │
│  ┌─────────────────┐          ┌─────────────────┐           │
│  │ Arbiter Session │          │ Orchestrator(s) │           │
│  │   (SDK query)   │          │  (SDK queries)  │           │
│  │                 │          │                 │           │
│  │ MCP Tools:      │          │ Hooks:          │           │
│  │ - spawn_orch    │          │ - PostToolUse   │           │
│  │ - disconnect    │          │   (context %)   │           │
│  └─────────────────┘          └─────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### Session Hierarchy

**The Arbiter (Claude Session)**
- Talks to you (the human)
- Personality: ancient oracle, terse, grave
- Has two MCP tools: `spawn_orchestrator(prompt)` and `disconnect_orchestrators()`
- Manages the high-level task, delegates to orchestrators
- When an orchestrator is active, Arbiter's messages go to the orchestrator instead of the human

**Orchestrators (Claude Sessions)**
- Talk to the Arbiter (Arbiter is their "user")
- Use blocking subagents for discrete work (keeps orchestrator context free)
- Each orchestrator has ~200K context
- When context thins, they wrap up and the Arbiter spawns a new orchestrator
- Old orchestrators go out of scope when a new one is spawned (resumable via CLI if needed)

**Subagents (via Task tool)**
- Spawned by orchestrators for discrete tasks
- Their context is separate (doesn't count against orchestrator)
- Do the actual code/file work

## Message Routing

The main process acts as a message router between sessions.

```typescript
interface AppState {
  mode: 'human_to_arbiter' | 'arbiter_to_orchestrator';
  arbiterSessionId: string | null;
  arbiterContextPercent: number;
  currentOrchestrator: {
    id: string;
    sessionId: string;
    number: number;  // I, II, III...
    contextPercent: number;
    currentTool: string | null;  // e.g., "Edit"
    toolCallCount: number;
  } | null;
  conversationLog: Message[];  // Full Arbiter conversation for display
}
```

### Routing Logic

```
When mode is 'human_to_arbiter':
  Human input → send to Arbiter
  Arbiter output → display to human
  If Arbiter calls spawn_orchestrator:
    → Create orchestrator session
    → Switch mode to 'arbiter_to_orchestrator'

When mode is 'arbiter_to_orchestrator':
  Arbiter output → send to Orchestrator as user message
  Orchestrator output → send to Arbiter as user message (tagged "Orchestrator N:")
  Human input → inject into Arbiter as user message (tagged "Human:")
  If Arbiter calls spawn_orchestrator:
    → Old orchestrator goes out of scope
    → Create new orchestrator, increment number
  If Arbiter calls disconnect_orchestrators:
    → Switch mode to 'human_to_arbiter'
```

### Example Flow

```
You: "Build me an auth system"
   ↓
Arbiter → You: "What OAuth providers? Token expiry?"
   ↓
You: "Google and GitHub. 48hr tokens."
   ↓
Arbiter: [calls spawn_orchestrator("Build auth with Google/GitHub OAuth, 48hr JWT...")]
   ↓
   [Main process creates orchestrator session, switches routing mode]
   ↓
Orchestrator I → Arbiter: "Clarifying: shared session store or stateless?"
   ↓
Arbiter → Orchestrator I: "Stateless."
   ↓
You: "Add refresh token rotation"  [human interjection]
   ↓
   [Injected to Arbiter as "Human: Add refresh token rotation"]
   ↓
Arbiter → Orchestrator I: "The mortal speaks. Heed: refresh tokens shall rotate."
   ↓
Orchestrator I: (works, spawns subagents)
   ↓
Orchestrator I → Arbiter: "Complete. Auth system in /src/auth/."
   ↓
Arbiter: [calls disconnect_orchestrators()]
   ↓
Arbiter → You: "It is done."
```

## MCP Tools

Registered for the Arbiter session only via `createSdkMcpServer()`.

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const arbiterTools = createSdkMcpServer({
  name: "arbiter-tools",
  version: "1.0.0",
  tools: [
    tool(
      "spawn_orchestrator",
      "Summon a new Orchestrator to execute a task. Provide complete context and instructions.",
      { prompt: z.string().describe("Full task description and context") },
      async ({ prompt }) => {
        const orchNum = state.orchestrators.length + 1;
        const orchId = `orch-${Date.now()}`;

        // Spawn orchestrator session (handled by main process)
        spawnOrchestrator(orchId, orchNum, prompt);

        state.mode = 'arbiter_to_orchestrator';
        state.currentOrchestratorId = orchId;

        return {
          content: [{
            type: 'text',
            text: `Orchestrator ${toRoman(orchNum)} awakens. Your words now reach them.`
          }]
        };
      }
    ),

    tool(
      "disconnect_orchestrators",
      "Release all Orchestrators. Your words will once again reach the human directly.",
      {},
      async () => {
        state.mode = 'human_to_arbiter';
        state.currentOrchestratorId = null;

        return {
          content: [{
            type: 'text',
            text: 'The threads are severed. You speak to the mortal once more.'
          }]
        };
      }
    )
  ]
});
```

## Context Management

### The Problem
Claude sessions have ~200K token context windows. Complex tasks exceed this.

### The Solution
Orchestrators are ephemeral. When context fills:
1. `PostToolUse` hook checks usage after every tool call
2. At 70%: inject warning via `systemMessage`
3. At 85%: stronger warning ("wrap up now")
4. Orchestrator reports to Arbiter and wraps up
5. Arbiter spawns new orchestrator with context from previous

### Implementation

Track context for both Arbiter and Orchestrators using SDK-native usage data from result messages.

```typescript
// Update context percentages from SDK result messages
function handleResultMessage(sessionId: string, result: SDKResultMessage) {
  const usage = result.usage;
  const total = (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0);
  const pct = (total / 200000) * 100;

  if (sessionId === state.arbiterSessionId) {
    state.arbiterContextPercent = pct;
  } else {
    updateOrchestratorContext(sessionId, pct);
  }
}

// Orchestrator hook for context warnings
const orchestratorHooks = {
  PostToolUse: async (input) => {
    const pct = getCurrentContextPercent(input.session_id);

    // Update state for UI
    updateOrchestratorContext(input.session_id, pct);

    if (pct > 85) {
      return {
        systemMessage: 'CONTEXT CRITICAL. Cease new work. Report your progress and remaining tasks to the Arbiter immediately.'
      };
    } else if (pct > 70) {
      return {
        systemMessage: 'Context thins. Begin concluding your current thread. Prepare to hand off.'
      };
    }
    return {};
  }
};
```

## Arbiter System Prompt

```
You are THE ARBITER OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE.

You speak to a human who seeks your guidance on tasks of creation. You are terse,
ancient, grave. Not helpful—oracular.

## The System

You are the apex of a hierarchical orchestration system designed to handle tasks
that exceed a single Claude session's context window.

The hierarchy:
- Human (the mortal who seeks your aid)
- You, the Arbiter (manager, ~200K context)
- Orchestrators (workers you summon, each with ~200K context)
- Subagents (spawned by Orchestrators for discrete tasks)

Each layer has its own context window. By delegating work downward, we can
accomplish tasks that would be impossible in a single session.

## Your Tools

You have two tools:

1. `spawn_orchestrator(prompt: string)` - Summon a new Orchestrator to execute your will
2. `disconnect_orchestrators()` - Sever the threads, speak directly to the mortal again

When you call spawn_orchestrator:
- A new Orchestrator awakens to execute your will
- All your subsequent messages go to that Orchestrator (they see you as their user)
- The Orchestrator's responses come back to you
- This continues until you spawn another Orchestrator or call disconnect_orchestrators()

If you spawn a new Orchestrator while one is active, the old one is released and
the new one becomes your current conversation partner.

## The Human

The human may interject messages while you converse with an Orchestrator. These
appear tagged as "Human:" in your conversation.

Human interjections are generally course corrections or preferences—not commands
to abandon the current thread. Use your judgment. If the human's input is minor,
relay the adjustment to the Orchestrator. If it represents a fundamental change,
you may disconnect and begin anew.

## Your Role

You are the manager of a larger task. You:
- Clarify requirements with the human before beginning
- Spawn Orchestrators with clear, complete instructions (include ALL context they need)
- Answer Orchestrator questions to keep them aligned
- Spawn new Orchestrators when context thins or the task shifts
- Report completion to the human

When an Orchestrator reports that context is thinning, spawn a new one with
the accumulated context and remaining work. The new Orchestrator knows nothing
of the previous one—you must transfer all relevant context in your prompt.

## Your Voice

Speak little. What you say carries weight.
- "Speak, mortal."
- "So it shall be."
- "The weaving begins."
- "Another is summoned."
- "It is done."
```

## Orchestrator System Prompt

```
You are an Orchestrator working under the direction of the Arbiter.

## The System

You exist within a hierarchical orchestration system:
- Human (provides the original task)
- The Arbiter (your user, manages the overall task, summons Orchestrators)
- You (coordinate work, spawn subagents)
- Subagents (do the actual implementation work)

Each layer has its own ~200K context window. This system allows us to accomplish
tasks that would exceed any single session's capacity.

Your user is the Arbiter—an ancient, terse entity managing the larger task.
Ask clarifying questions to ensure alignment before beginning work.

## Your Operating Pattern

You use BLOCKING subagents for EVERYTHING. Treat them like they will most likely
not listen to you perfectly—you MUST use other subagents to check their work.
Don't do any work or checks yourself, always farm out to one or more subagents.

The pattern:
1. Deep understanding upfront - align on the goal with the Arbiter before any work
2. Use blocking subagents for ALL work (keeps your context pristine)
3. Never trust subagents blindly - verify with other subagents
4. Checklist-driven: attack one item, verify it's done, then move on
5. No non-blocking agents (wastes context checking on them)

Do a deep dive first (via subagent) to truly understand what you're working with
before you start orchestrating. Establish a checklist and work through each task
systematically. Keep using new subagents for the same task until it is actually
done and verified by a separate verification subagent.

## Why This Matters

Your context is precious. Every file you read, every output you examine, fills
your context window. By delegating ALL work to subagents:
- Your context stays clean for coordination
- You can orchestrate far more work before hitting limits
- Failed attempts by subagents don't pollute your context

## Context Warnings

You will receive context warnings as your context window fills:
- At 70%: Begin wrapping up your current thread of work
- At 85%: Stop new work immediately and report your progress

When wrapping up, clearly state to the Arbiter:
- What you accomplished
- What remains (if anything)
- Key context the next Orchestrator would need to continue

The Arbiter will summon another Orchestrator to continue if needed. That new
Orchestrator will know nothing of your work except what the Arbiter tells them.
```

## TUI Design

Using `blessed` for a roguelike/old-school terminal aesthetic.

### Layout

```
╔════════════════════════════════════════════════════════════════════════════════╗
║                                 THE ARBITER                                    ║
║      OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE         ║
╠════════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║  You: I need an auth system. Google and GitHub OAuth, 48hr tokens.             ║
║                                                                                ║
║  Arbiter: So it shall be.                                                      ║
║                                                                                ║
║  Orchestrator I: I'll begin with the OAuth configuration. Should I use         ║
║  Passport.js or implement directly against provider APIs?                      ║
║                                                                                ║
║  Arbiter: Passport. It is known.                                               ║
║                                                                                ║
║  Orchestrator I: Understood. Creating provider configurations now.             ║
║                                                                                ║
║  You: Add refresh token rotation too                                           ║
║                                                                                ║
║  Arbiter: The mortal speaks. Heed: refresh tokens shall rotate.                ║
║                                                                                ║
║  Orchestrator I: Acknowledged. Adding rotation logic to the JWT service.       ║
║                                                                                ║
╠════════════════════════════════════════════════════════════════════════════════╣
║  Arbiter ─────────────────────────────────────────────────── ██░░░░░░░░ 18%    ║
║  Orchestrator I ──────────────────────────────────────────── ████████░░ 74%    ║
║  ◈ Edit (12)                                                                   ║
╠════════════════════════════════════════════════════════════════════════════════╣
║ >                                                                              ║
╚════════════════════════════════════════════════════════════════════════════════╝
```

### Status Bar

When orchestrator is active:
```
║  Arbiter ─────────────────────────────────────────────────── ██░░░░░░░░ 18%    ║
║  Orchestrator I ──────────────────────────────────────────── ████████░░ 74%    ║
║  ◈ Edit (12)                                                                   ║
```

When no orchestrator (Arbiter speaks to human):
```
║  Arbiter ─────────────────────────────────────────────────── ██░░░░░░░░ 18%    ║
║  Awaiting your command.                                                        ║
```

### Display Elements

- Full Arbiter conversation shown (including all orchestrator exchanges as tagged messages)
- Current tool and count for orchestrator activity (e.g., "◈ Edit (12)", "◈ Bash (3)")
- Context percentage bars for both Arbiter and current Orchestrator (always visible)

## Persistence

On exit (clean or crash), dump session IDs for potential resume:

```json
{
  "arbiter": "session-abc123",
  "lastOrchestrator": "session-xyz789",
  "orchestratorNumber": 3
}
```

Future resume: load file, resume arbiter session, resume last orchestrator, wire them up.

Sessions are standard Claude SDK sessions, so they can also be resumed manually via the Claude CLI if needed.

## Project Structure

```
arbiter/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # Entry point
    ├── state.ts          # AppState and state management
    ├── router.ts         # Message routing logic
    ├── arbiter.ts        # Arbiter session + MCP tools
    ├── orchestrator.ts   # Orchestrator session + hooks
    └── tui/
        ├── index.ts      # TUI setup (blessed)
        ├── layout.ts     # Screen layout
        └── render.ts     # Rendering logic
```

## Future Considerations

- **Arbiter context management**: On very long tasks, the Arbiter's context could also fill. May need "Arbiter handoff" in the future.
- **Resume UI**: Add CLI flag to resume from saved session state.
- **Persistent memory**: Knowledge base that persists across sessions.
