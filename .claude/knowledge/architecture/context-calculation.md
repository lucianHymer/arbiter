# SDK Context Window Calculation - The Definitive Formula

## The Problem Nobody Solved

Claude's Agent SDK returns usage data per message:
- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`

But how do you calculate actual context window usage from these? The `/context` command shows accurate breakdowns, but it's not programmatically accessible. Everyone on the internet was guessing.

## The Formula (REVISED - January 2026)

```
total = baseline + max(cache_read + cache_create) - first(cache_read + cache_create) + sum(input) + sum(output)
```

Or more simply: **baseline + combined_growth + sum(I/O)**

Where:
- **combined** = `cache_read + cache_create` for any given message
- **combined_growth** = `max(combined)` - `first(combined)`
- **sum(I/O)** = accumulated `input_tokens` + `output_tokens` across all messages

All values from `assistant.message.usage`, deduped by `message.id` (NOT uuid!).

### Why Combined Metric?

The key insight is tracking `(cache_read + cache_create)` as a single combined metric. This handles:
1. **Non-monotonic cache_read** - Can drop on session resume or cache expiry
2. **Cache absorption** - cache_create gets absorbed into future cache_read
3. **Variable caching states** - Different sessions start with different cache states

The combined metric stays stable because at any point, `(cache_read + cache_create)` represents the total cacheable content for that turn.

### Components

1. **baseline** = total tokens from `/context` at session start (~18.5k typically)

2. **first(cache_read + cache_create)** = "cached system overhead" (~15.4k typically)
   - Remarkably consistent across sessions regardless of initial cache state
   - Represents the system tools/prompt portion in cache

3. **max(cache_read + cache_create)** = high water mark of combined metric
   - Tracks total cacheable content including messages

4. **combined_growth** = max - first = message content added since start

### Accuracy Results (January 2026)

| Prompts | Tools | Calculated | Actual  | Error   |
|---------|-------|------------|---------|---------|
| 6       | No    | 18,532     | 18,600  | -0.37%  |
| 6       | Yes   | 39,401     | 39,300  | +0.26%  |
| 10      | Yes   | 47,599     | 47,700  | -0.21%  |

**Average absolute error: ~0.3%** - essentially within /context rounding error!

### Comparison with Previous Formula

The previous formula `baseline + (max(cache_read) - first(cache_read)) + last(cache_create)` failed badly with heavy tool use:

| Scenario      | NEW Formula | OLD Formula |
|---------------|-------------|-------------|
| 6 prompts, no tools  | 0.55% error | 0.37% error |
| 6 prompts, with tools | 0.93% error | **11.28% error** |
| 10 prompts, with tools | 0.85% error | **24.65% error** |

The old formula got progressively worse with more tool use because `sum(cache_create)` double-counts content as it moves through the cache.

## Why It Works

### Combined Metric Insight

At any point during a session:
- `cache_read` = what's currently in cache being read
- `cache_create` = what's being added to cache this turn
- `cache_read + cache_create` = total cacheable content right now

The first message's combined value (~15.4k) represents the cached system overhead.
As messages are added, the combined value grows.
The difference (max - first) represents message content growth.

### Why first(r+c) is Consistent

Regardless of whether the cache was "warm" or "cold" before starting:
- Low-tool test: first(r+c) = 15,372 (r=14,989, c=383)
- High-tool test: first(r+c) = 15,372 (r=15,354, c=18)

The combined value is the same! The individual components vary based on cache state, but their sum is stable.

### cache_read is NOT Monotonic

```
#10: 30740 ↑
#11: 29159 ↓  ← Dropped by 1,581!
#12: 32106 ↑
#13: 31986 ↓  ← Dropped by 120
#14: 34526 ↑
```

This is why tracking `cache_read` alone doesn't work - you need the combined metric.

## Critical Discoveries

### 1. Dedupe by message.id (NOT uuid!)

The SDK's `uuid` is unique per streaming chunk, but `message.id` is unique per API call.
Multiple streaming chunks from the same API response share the same `message.id`.

```typescript
// WRONG - overcounts streaming chunks:
const seenUuids = new Set<string>();
if (seenUuids.has(msg.uuid)) return;

// CORRECT - one entry per API call:
const seenMsgIds = new Set<string>();
if (seenMsgIds.has(msg.message.id)) return;
seenMsgIds.add(msg.message.id);
```

### 2. Result vs Assistant Messages

- **Result messages**: Aggregate across subagents (inflated numbers)
- **Assistant messages**: Main model only (accurate)

Always use assistant messages for context tracking.

### 3. Don't Sum cache_create

`sum(cache_create)` double-counts because:
- Turn 1: cache_create=X (new stuff cached)
- Turn 2: cache_read now includes X, cache_create=Y
- Summing gives X+Y, but Y already "contains" X in the cache

The combined metric avoids this by looking at snapshots, not accumulations.

## Implementation

### Step 1: Get Baseline at Startup

Run `/context` via SDK to get the baseline token count:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

async function getBaseline(cwd: string): Promise<number> {
  const q = query({
    prompt: '/context',
    options: { cwd, permissionMode: 'bypassPermissions' }
  });

  let baseline = 0;

  for await (const msg of q) {
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;
      if (typeof content === 'string') {
        const match = content.match(/\*\*Tokens:\*\*\s*([0-9.]+)k/i);
        if (match) {
          baseline = Math.round(parseFloat(match[1]) * 1000);
        }
      }
    }
  }

  return baseline;  // ~18,000-19,000 typically
}
```

### Step 2: Track Context During Session

```typescript
interface ContextTracker {
  baseline: number;           // From /context at startup
  seenMsgIds: Set<string>;    // Dedupe by message.id
  firstCombinedRC: number;    // First message's (cache_read + cache_create)
  maxCombinedRC: number;      // Max(cache_read + cache_create) seen
  sumInput: number;           // Sum of input_tokens
  sumOutput: number;          // Sum of output_tokens
}

function createContextTracker(baseline: number): ContextTracker {
  return {
    baseline,
    seenMsgIds: new Set(),
    firstCombinedRC: 0,
    maxCombinedRC: 0,
    sumInput: 0,
    sumOutput: 0,
  };
}

function updateContext(tracker: ContextTracker, msg: SDKAssistantMessage): void {
  const usage = (msg.message as any).usage;
  if (!usage) return;

  // Dedupe by message.id (NOT uuid - that's per streaming chunk)
  const msgId = (msg.message as any).id;
  if (tracker.seenMsgIds.has(msgId)) return;
  tracker.seenMsgIds.add(msgId);

  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const combinedRC = cacheRead + cacheCreate;

  // Capture first combined value as reference point
  if (tracker.firstCombinedRC === 0) {
    tracker.firstCombinedRC = combinedRC;
  }

  // Update tracking
  tracker.maxCombinedRC = Math.max(tracker.maxCombinedRC, combinedRC);
  tracker.sumInput += inputTokens;
  tracker.sumOutput += outputTokens;
}

function getContextTokens(tracker: ContextTracker): number {
  // THE FORMULA: baseline + combined_growth + I/O
  const combinedGrowth = tracker.maxCombinedRC - tracker.firstCombinedRC;
  return tracker.baseline + combinedGrowth + tracker.sumInput + tracker.sumOutput;
}

function getContextPercent(tracker: ContextTracker): number {
  return (getContextTokens(tracker) / 200_000) * 100;
}
```

### Step 3: Put It Together

```typescript
async function startSession(cwd: string) {
  // 1. Get baseline from /context
  const baseline = await getBaseline(cwd);
  console.log(`Baseline: ${baseline} tokens`);

  // 2. Create tracker
  const tracker = createContextTracker(baseline);

  // 3. Start your actual session and track messages
  const session = query({
    prompt: 'Hello!',
    options: { cwd, permissionMode: 'bypassPermissions' }
  });

  for await (const msg of session) {
    if (msg.type === 'assistant') {
      updateContext(tracker, msg);
      console.log(`Context: ${getContextPercent(tracker).toFixed(1)}%`);
    }
  }
}
```

## Summary

| What to track | How |
|--------------|-----|
| Dedupe key | `message.id` (NOT `uuid`) |
| Baseline | Run `/context` at startup, parse total tokens |
| Combined metric | `cache_read + cache_create` per message |
| Message growth | `max(combined) - first(combined)` |
| I/O tokens | `sum(input_tokens) + sum(output_tokens)` |
| **Total context** | **`baseline + max(r+c) - first(r+c) + sum(i+o)`** |

**Critical:**
1. Use `message.id` for deduplication! The SDK's `uuid` is per streaming chunk, but `message.id` is per API call.
2. Track the **combined metric** `(cache_read + cache_create)`, not separately!
3. Use `max(combined) - first(combined)` for growth, not sums.
4. Add `sum(input) + sum(output)` for non-cached I/O tokens.
5. Get baseline from `/context` at startup.

**Tested accuracy: ~0.3% average error - essentially within /context rounding error.**
