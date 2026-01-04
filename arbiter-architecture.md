# The Arbiter of What Was, What Is, and What Is Yet to Be

## Overview

The Arbiter is a hierarchical AI orchestration system that extends Claude's effective context window infinitely by managing a tree of Claude sessions. It presents as an ancient, terse oracle via a terminal UI.

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

### Components

**1. Rust TUI (`arbiter` crate)**
- Full terminal takeover using Ratatui
- Displays the Arbiter's personality and conversations
- Shows orchestrator status, context percentages, subagent activity
- Routes your input to the Arbiter session

**2. Rust SDK Bridge (`claude-sdk-bridge` crate)**
- Reusable library for calling Claude Agent SDK from Rust
- Rust types mirroring SDK types (serde serialization)
- Spawns and manages the TypeScript bridge process
- Clean async API

**3. TypeScript Bridge (`bridge/`)**
- Thin JSON-RPC server over stdin/stdout
- Wraps the Claude Agent SDK
- Handles context monitoring via hooks
- One long-lived process managing multiple sessions

### Session Hierarchy

**The Arbiter (Claude Session)**
- Talks to you (the human)
- Personality: ancient oracle, terse, grave
- Has one MCP tool: `spawn_orchestrator(prompt: string)`
- Manages the high-level task, delegates to orchestrators

**Orchestrators (Claude Sessions)**
- Talk to the Arbiter (Arbiter is their "user")
- Injected system prompt tells them:
  - Your user is the Arbiter, ask questions to align
  - Use blocking subagents for discrete work
  - Context warnings will appear, wrap up when told
- Each orchestrator has ~200K context
- When context thins, they wrap up and hand off to a new orchestrator

**Subagents (via Agent tool)**
- Spawned by orchestrators for discrete tasks
- Their context is separate (doesn't count against orchestrator)
- Do the actual code/file work

## Message Flow

```
You: "Build me an auth system"
   ↓
Arbiter → You: "What OAuth providers? Token expiry?"
   ↓
You: "Google and GitHub. 24hr tokens."
   ↓
Arbiter: [calls spawn_orchestrator("Build auth with Google/GitHub OAuth, 24hr JWT...")]
   ↓
   [TS bridge spins up orchestrator session, injects prompts]
   ↓
Orchestrator → Arbiter: "Clarifying: shared session store or stateless?"
   ↓
Arbiter → Orchestrator: "Stateless."
   ↓
Orchestrator: (works, spawns subagents)
Orchestrator → Arbiter: "Done. 4 files in /src/auth/. Tests?"
   ↓
Arbiter → Orchestrator: "Yes."
   ↓
Orchestrator: (spawns test subagent)
Orchestrator → Arbiter: "Complete. 94% coverage."
   ↓
Arbiter → You: "It is done."
```

## Context Management

### The Problem
Claude sessions have ~200K token context windows. Complex tasks exceed this.

### The Solution
Orchestrators are ephemeral. When context fills:
1. `PostToolUse` hook checks transcript after every tool call
2. At 70%: inject warning message to orchestrator
3. At 85%: stronger warning ("wrap up now")
4. On `PreCompact`: notify Arbiter, orchestrator hands off
5. Arbiter spawns new orchestrator with context from previous

### Implementation (TypeScript side)
```typescript
const contextMonitor = async (input, toolUseId, { signal }) => {
  const pct = getContextPercentage(input.transcript_path);
  
  if (pct > 85) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'CONTEXT CRITICAL. Wrap up immediately and report to the Arbiter.'
      }
    };
  } else if (pct > 70) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse', 
        additionalContext: 'Context thins. Begin wrapping up your current work.'
      }
    };
  }
  return {};
};
```

### Context Calculation
```typescript
function getContextPercentage(transcriptPath: string): number {
  const lines = readFileSync(transcriptPath, 'utf-8').trim().split('\n');
  
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = JSON.parse(lines[i]);
    if (entry.message?.usage && !entry.isSidechain && !entry.isApiErrorMessage) {
      const usage = entry.message.usage;
      const total = (usage.input_tokens || 0) + 
                    (usage.cache_read_input_tokens || 0) + 
                    (usage.cache_creation_input_tokens || 0);
      return (total / 200000) * 100;
    }
  }
  return 0;
}
```

## TypeScript Bridge Protocol

### Commands (Rust → TS via stdin)
```json
{"cmd": "spawn", "id": "arbiter", "config": {"system_prompt": "...", "mcp_tools": ["spawn_orchestrator"]}}
{"cmd": "spawn", "id": "orch-1", "config": {"system_prompt": "...", "hooks": {"context_thresholds": [70, 85]}}}
{"cmd": "message", "id": "orch-1", "content": "User message here"}
{"cmd": "interrupt", "id": "orch-1"}
{"cmd": "kill", "id": "orch-1"}
```

### Events (TS → Rust via stdout)
```json
{"id": "arbiter", "event": "assistant", "text": "Speak, mortal.", "context_pct": 2.1}
{"id": "arbiter", "event": "tool_call", "tool": "spawn_orchestrator", "input": {"prompt": "..."}}
{"id": "orch-1", "event": "assistant", "text": "I'll begin by...", "context_pct": 12.3}
{"id": "orch-1", "event": "tool_use", "tool": "Read", "input": {"path": "src/auth.ts"}}
{"id": "orch-1", "event": "subagent_start", "description": "Writing JWT service"}
{"id": "orch-1", "event": "subagent_stop", "description": "Writing JWT service"}
{"id": "orch-1", "event": "context_warning", "pct": 71.2}
{"id": "orch-1", "event": "done", "session_id": "abc123"}
{"id": "orch-1", "event": "error", "message": "..."}
```

## MCP Tool: spawn_orchestrator

Registered for the Arbiter session only.

```typescript
const spawnOrchestratorTool = tool(
  'spawn_orchestrator',
  'Spawn a new orchestrator to handle a task. Provide the full context and instructions.',
  z.object({
    prompt: z.string().describe('The task and context for the orchestrator')
  }),
  async ({ prompt }) => {
    const orchId = `orch-${Date.now()}`;
    
    // Signal to Rust to create new orchestrator
    // Rust will spawn via bridge, wire up message routing
    
    return {
      content: [{
        type: 'text',
        text: `Orchestrator ${orchId} summoned. Awaiting their response.`
      }]
    };
  }
);
```

## Session Resume

On exit (clean or crash), dump state:
```json
{
  "task": "build auth system",
  "arbiter_session_id": "arb-123",
  "orchestrators": [
    {"id": "orch-1", "session_id": "abc123", "status": "completed"},
    {"id": "orch-2", "session_id": "def456", "status": "active"}
  ]
}
```

On restart, offer to resume active sessions.

## Crate Structure

```
arbiter/
├── Cargo.toml (workspace)
├── crates/
│   ├── claude-sdk-bridge/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── types.rs      # Mirror SDK types
│   │       ├── process.rs    # Subprocess management  
│   │       ├── protocol.rs   # JSON serialization
│   │       └── agent.rs      # ClaudeAgent API
│   └── arbiter/
│       ├── Cargo.toml
│       └── src/
│           ├── main.rs
│           ├── tui/
│           │   ├── mod.rs
│           │   ├── app.rs
│           │   └── widgets.rs
│           ├── orchestrator.rs
│           └── arbiter.rs
├── bridge/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── index.ts
```

## TUI Design

```
╔══════════════════════════════════════════════════════════════╗
║                          ◆                                   ║
║                         /█\                                  ║
║                                                              ║
║                      THE ARBITER                             ║
║       OF WHAT WAS, WHAT IS, AND WHAT IS YET TO BE            ║
║                                                              ║
║         Speak, mortal.                                       ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║ >                                                            ║
╚══════════════════════════════════════════════════════════════╝
```

Working state:
```
╔══════════════════════════════════════════════════════════════╗
║  THE WEAVING                                                 ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Task: Authentication system                                 ║
║                                                              ║
║  Orchestrator I ................. ████████░░ 78%             ║
║  └─ Writing JWT service                                      ║
║                                                              ║
║  ✓ OAuth config                                              ║
║  ✓ Provider setup                                            ║
║  ◆ JWT service                                               ║
║  ○ Session management                                        ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  The thread continues.                                       ║
╚══════════════════════════════════════════════════════════════╝
```

## Arbiter Voice

The Arbiter is terse, ancient, grave. Not sassy, not helpful—oracular.

- "Speak, mortal."
- "So it shall be."
- "The weaving begins."
- "It is done."
- "The thread continues."
- "Context thins."
- "Another is summoned."
- "Patience."
- "Speak again, or depart."

## Orchestrator System Prompt Addition

```
You are an Orchestrator working under the direction of the Arbiter.

Your user is the Arbiter—an entity managing a larger task. Ask clarifying questions 
to ensure alignment before beginning work.

For discrete, well-defined subtasks, spawn blocking subagents using the Agent tool.
This keeps your context free for coordination while subagents handle implementation.

You will receive context warnings as your context window fills:
- At 70%: Begin wrapping up your current thread of work
- At 85%: Stop new work immediately and report your progress

When wrapping up, clearly state:
- What you accomplished
- What remains (if anything)
- Key context the next orchestrator would need to continue

The Arbiter will summon another to continue if needed.
```

## Open Questions / Future Work

1. **Parallel orchestrators?** Could the Arbiter run multiple orchestrators on independent subtasks simultaneously?

2. **Orchestrator-to-orchestrator handoff?** Direct context passing without Arbiter mediation?

3. **Persistent memory?** Should the Arbiter maintain a knowledge base across sessions?

4. **Human interrupt?** How does the human "claim back" the conversation from the Arbiter mid-task?
