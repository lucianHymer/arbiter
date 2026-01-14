# Router Refactor Handoff

## Context

We're refactoring the message routing between Arbiter and Orchestrator sessions to be cleaner and more natural.

## The Mental Model

**Arbiter and Orchestrator are EACH OTHER'S USERS:**
- When Orchestrator outputs something → it goes to Arbiter as a user message (Arbiter's user = Orchestrator)
- When Arbiter outputs something (while orchestrator active) → it goes to Orchestrator as a user message (Orchestrator's user = Arbiter)
- This bidirectional flow is THE WHOLE POINT - don't remove it!

**The UI shows the Arbiter's conversation:**
- At first, human is Arbiter's user → label as "You:"
- Once orchestrator spawns, orchestrator is Arbiter's user → label as "Orchestrator I:"
- "Arbiter:" = Arbiter's responses
- The UI is just showing Arbiter's chat with correct labels

## Current Problem

The current implementation adds TEXT TAGS when forwarding:
```typescript
// In handleOrchestratorOutput (router.ts ~line 500):
await this.sendToArbiter(`${orchLabel}: ${text}`);  // BAD - adds "Orchestrator I: " prefix

// In sendHumanMessage when orchestrator active:
await this.sendToArbiter(`Human: ${text}`);  // BAD - adds "Human: " prefix
```

This causes:
1. Arbiter sees "Orchestrator I: blah" and sometimes responds to the tag itself
2. Echo filtering was added as a band-aid (lines ~446-460)
3. Complexity and confusion

## The Fix

### 1. spawn_orchestrator MCP tool → Zero input (DONE in this session)
- Changed from `{ prompt: z.string() }` to `{}`
- Orchestrator will introduce itself to Arbiter
- Arbiter knows to wait for introduction after calling tool

### 2. Remove text tagging when forwarding messages
**File:** `src/router.ts`

In `handleOrchestratorOutput()` (~line 500):
```typescript
// BEFORE:
await this.sendToArbiter(`${orchLabel}: ${text}`);

// AFTER:
await this.sendToArbiter(text);  // Just forward the text, no prefix
```

In `sendHumanMessage()` when orchestrator active (~line 144-147):
```typescript
// BEFORE:
await this.sendToArbiter(`Human: ${text}`);

// AFTER:
await this.sendToArbiter(text);  // Just forward, no prefix
```

### 3. Remove echo filtering
**File:** `src/router.ts`

In `handleArbiterOutput()` (~lines 446-460), remove:
```typescript
// DELETE THIS ENTIRE BLOCK:
const looksLikeEcho = this.state.mode === "arbiter_to_orchestrator" &&
  (text.includes("Orchestrator") && text.includes(":") ||
   text.startsWith("Human:") ||
   text.includes("Human: Orchestrator"));

if (!looksLikeEcho) {
  this.callbacks.onArbiterMessage(text);
}

// REPLACE WITH:
this.callbacks.onArbiterMessage(text);  // Always show, let them figure it out
```

### 4. Track message source for UI labeling (instead of text parsing)
**File:** `src/router.ts`

The router should track who the current "user" of Arbiter is:
- `mode === 'human_to_arbiter'` → user is human → UI labels as "You:"
- `mode === 'arbiter_to_orchestrator'` → user is orchestrator → UI labels as "Orchestrator N:"

The UI callbacks already receive this context - just use mode to determine labels instead of parsing text.

### 5. Update system prompts
**File:** `src/orchestrator.ts`
- Add instruction: "Introduce yourself to the Arbiter when you first connect"

**File:** `src/arbiter.ts`
- Update to explain: "After you call spawn_orchestrator, the Orchestrator will introduce themselves. Then give them instructions."
- Remove any instructions about text formatting/prefixes
- Tell Arbiter: "If you have nothing to say, you can stay silent and let the Orchestrator work"

### 6. Update ArbiterCallbacks type
**File:** `src/arbiter.ts`

Change:
```typescript
onSpawnOrchestrator: (prompt: string, orchestratorNumber: number) => void;
```
To:
```typescript
onSpawnOrchestrator: (orchestratorNumber: number) => void;  // No prompt
```

And update `src/router.ts` to match (the callback handler).

## Files to Modify

1. `src/arbiter.ts` - MCP tool (DONE), system prompt, callback type
2. `src/orchestrator.ts` - system prompt (introduce yourself)
3. `src/router.ts` - remove tagging, remove echo filter, update callback
4. `src/tui/index.ts` - may need to adjust how labels are determined

## Testing

After changes:
1. Run `npm run build` to verify compilation
2. Run `npm run dev` and spawn an orchestrator
3. Verify orchestrator introduces itself
4. Verify messages flow naturally without "Orchestrator I:" prefixes in the raw messages
5. Verify UI still labels correctly
6. Verify no echoes or weird loops (if they do loop, that's fine - let them figure it out)

## Key Principle

LET THEM RIP. If Arbiter and Orchestrator want to have a polite conversation, let them. The system prompt can guide behavior, but we don't need to filter or manipulate messages. They're each other's users - let them talk.
