# Handoff: Context Tracking Implementation

## Overview

Implement accurate context window tracking for Arbiter and Orchestrator sessions using SDK usage data. This replaces the current broken implementation in `src/router.ts`.

## The Formula

```
context = max(cache_read) + sum(input) + sum(output)
```

All values from `assistant.message.usage`, deduped by `message.id` (NOT `uuid`).

See `.claude/knowledge/architecture/context-calculation.md` for full derivation and why this works.

## Implementation Steps

### Step 1: Get System Baseline at Startup

Before starting the Arbiter session, get the system overhead by running `/context` in a fresh SDK session:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

async function getSystemBaseline(cwd: string): Promise<number> {
  const q = query({
    prompt: '/context',
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
    }
  });

  let baseline = 0;

  for await (const msg of q) {
    // /context output comes through as a user message with <local-command-stdout>
    if (msg.type === 'user') {
      const content = msg.message?.content;
      if (typeof content === 'string' && content.includes('local-command-stdout')) {
        // Parse the total tokens line, e.g., "27k/200k tokens (14%)"
        const match = content.match(/(\d+)k\/200k tokens/);
        if (match) {
          baseline = parseInt(match[1]) * 1000;
        }
      }
    }
  }

  return baseline;
}
```

This gives you the system overhead (~27k tokens typically) which includes:
- System prompt
- System tools
- MCP tools
- Custom agents
- Memory files

### Step 2: Track Context from Assistant Messages

For each agent (Arbiter and Orchestrator), maintain separate tracking state:

```typescript
interface ContextTracker {
  seenMsgIds: Set<string>;
  maxCacheRead: number;
  sumInput: number;
  sumOutput: number;
  // For auditing - secondary formula
  sumCacheCreate: number;
}

function createContextTracker(): ContextTracker {
  return {
    seenMsgIds: new Set(),
    maxCacheRead: 0,
    sumInput: 0,
    sumOutput: 0,
    sumCacheCreate: 0,
  };
}
```

### Step 3: Update on Each Assistant Message

```typescript
function updateContext(tracker: ContextTracker, msg: SDKAssistantMessage): void {
  const usage = (msg.message as any).usage;
  if (!usage) return;

  // CRITICAL: Dedupe by message.id, NOT uuid
  // uuid is per streaming chunk, message.id is per API call
  const msgId = (msg.message as any).id;
  if (tracker.seenMsgIds.has(msgId)) return;
  tracker.seenMsgIds.add(msgId);

  // Primary formula: max(cache_read) + sum(input) + sum(output)
  tracker.maxCacheRead = Math.max(tracker.maxCacheRead, usage.cache_read_input_tokens || 0);
  tracker.sumInput += usage.input_tokens || 0;
  tracker.sumOutput += usage.output_tokens || 0;

  // Audit formula: sum(cache_create) + sum(input) + sum(output)
  tracker.sumCacheCreate += usage.cache_creation_input_tokens || 0;

  // Log all four values for debugging
  const primaryTokens = tracker.maxCacheRead + tracker.sumInput + tracker.sumOutput;
  const auditTokens = tracker.sumCacheCreate + tracker.sumInput + tracker.sumOutput;
  console.log(`Context update: max_cache_read=${tracker.maxCacheRead}, sum_in=${tracker.sumInput}, sum_out=${tracker.sumOutput}, sum_cache_create=${tracker.sumCacheCreate}`);
  console.log(`  Primary: ${primaryTokens} (${(primaryTokens/200000*100).toFixed(1)}%), Audit: ${auditTokens} (${(auditTokens/200000*100).toFixed(1)}%)`);
}
```

### Step 4: Calculate Context Percentage

```typescript
const MAX_CONTEXT = 200_000;

function getContextTokens(tracker: ContextTracker): number {
  // Primary formula
  return tracker.maxCacheRead + tracker.sumInput + tracker.sumOutput;
}

function getContextPercent(tracker: ContextTracker): number {
  return (getContextTokens(tracker) / MAX_CONTEXT) * 100;
}

// For auditing - compare with secondary formula
function getAuditContextTokens(tracker: ContextTracker): number {
  return tracker.sumCacheCreate + tracker.sumInput + tracker.sumOutput;
}
```

### Step 5: Integration Points in Router

In `src/router.ts`:

1. **Add tracker state** to the Router class:
```typescript
private arbiterContextTracker = createContextTracker();
private orchestratorContextTracker = createContextTracker();
```

2. **Update in handleArbiterMessage()** when `message.type === 'assistant'`:
```typescript
updateContext(this.arbiterContextTracker, message as SDKAssistantMessage);
const pct = getContextPercent(this.arbiterContextTracker);
// ... notify callbacks
```

3. **Same for handleOrchestratorMessage()**

4. **Reset orchestrator tracker** when spawning a new one:
```typescript
this.orchestratorContextTracker = createContextTracker();
```

## Key Gotchas

### 1. Dedupe by `message.id`, NOT `uuid`

```typescript
// WRONG - overcounts by 2-3x:
if (seenUuids.has(msg.uuid)) return;

// CORRECT:
if (seenMsgIds.has(msg.message.id)) return;
```

The SDK's `uuid` is unique per streaming chunk. Multiple chunks from the same API call share the same `message.id`.

### 2. cache_read is NOT Monotonically Increasing

It can drop on session resume or cache expiry. That's why we use `max()`:
```typescript
maxCacheRead = Math.max(maxCacheRead, usage.cache_read_input_tokens || 0);
```

### 3. Don't Include cache_creation in Primary Formula

`cache_creation` gets absorbed into future `cache_read` values. Including both would double-count. We track it separately for auditing only.

### 4. Use Assistant Messages, NOT Result Messages

Result messages aggregate across subagents (inflated). Assistant messages are main model only.

## Debug Logging

Log ALL four metrics separately so we can audit and compare:

```typescript
this.callbacks.onDebugLog?.({
  type: 'system',
  agent: 'arbiter', // or 'orchestrator'
  text: `Context: ${primaryPct.toFixed(1)}% (${primaryTokens} tokens)`,
  details: {
    messageId: msgId,
    // All four raw values
    max_cache_read: tracker.maxCacheRead,
    sum_input: tracker.sumInput,
    sum_output: tracker.sumOutput,
    sum_cache_create: tracker.sumCacheCreate,
    // Computed formulas
    primary_tokens: tracker.maxCacheRead + tracker.sumInput + tracker.sumOutput,
    primary_percent: primaryPct,
    audit_tokens: tracker.sumCacheCreate + tracker.sumInput + tracker.sumOutput,
    audit_percent: auditPct,
    // Message count
    unique_api_calls: tracker.seenMsgIds.size,
  },
});
```

This lets us:
1. See each component separately
2. Compare primary vs audit formula in real-time
3. Verify the formula is working over time

In our testing:
- max(cache_read) alone: 34,966 (17.5%)
- + sum(in) + sum(out): 35,071 (17.5%) - only ~100 tokens more
- sum(cache_create) formula: 32,165 (16.1%) - undershoots
- Target: 35k (17.5%) ✓

## Files to Modify

- `src/router.ts` - Main implementation
- `src/state.ts` - May need to update state types

## Reference

Full documentation with derivation: `.claude/knowledge/architecture/context-calculation.md`
