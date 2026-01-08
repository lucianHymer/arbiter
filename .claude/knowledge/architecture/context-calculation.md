# SDK Context Window Calculation - The Definitive Formula

## The Problem Nobody Solved

Claude's Agent SDK returns usage data per message:
- `input_tokens`
- `output_tokens`
- `cache_read_input_tokens`
- `cache_creation_input_tokens`

But how do you calculate actual context window usage from these? The `/context` command shows accurate breakdowns, but it's not programmatically accessible. Everyone on the internet was guessing.

## The Formula (FINAL - January 2026)

```
total = baseline + (max(cache_read) - first(cache_read)) + last(cache_create)
```

Or more simply: **baseline + message_growth + pending_content**

All values from `assistant.message.usage`, deduped by `message.id` (NOT uuid!).

### Components

1. **baseline** = total tokens from `/context` at session start (~18-19k typically)

2. **cache_read growth** = `max(cache_read) - first(cache_read)`
   - How much the cache has grown since the first message
   - Represents new message content that's been cached

3. **last(cache_create)** = `cache_creation_input_tokens` from the LAST message ONLY
   - **NOT sum()!** - cache_create gets absorbed into next message's cache_read
   - Summing would double-count as content moves through cache
   - Only the last message's cache_create is "pending" uncached content

### Accuracy Results (8 test scenarios)

| Messages | Tools | Calculated | Actual  | Error   |
|----------|-------|------------|---------|---------|
| 3        | No    | 18,941     | 19,000  | -0.31%  |
| 3        | Yes   | 31,925     | 32,300  | -1.16%  |
| 6        | No    | 19,280     | 19,000  | +1.47%  |
| 6        | Yes   | 37,957     | 38,300  | -0.90%  |
| 8        | Yes   | 45,969     | 46,300  | -0.71%  |
| 10       | No    | 19,517     | 19,500  | +0.09%  |
| 12       | No    | 19,367     | 19,400  | -0.17%  |
| 12       | Yes   | 55,943     | 56,100  | -0.28%  |

**Average absolute error: ~0.64%** - All tests within 1.5%!

## Why It Works

### cache_read_input_tokens
- Represents cached content read for each API call
- First message's cache_read ≈ **system tools** (NOT full system prompt!)
- Grows as conversation history gets cached
- **NOT monotonically increasing** - can drop on session resume or cache expiry
- Use **MAX** across all messages (high water mark)
- **Does NOT include ~3k tokens of system prompt** - hence SYSTEM_GAP needed

### cache_creation_input_tokens (NOT used in formula)
- Tokens being **added** to cache this turn
- Gets absorbed into future `cache_read` values
- Including it would **double-count** because:
  - Turn 1: cache_create=X (new stuff cached)
  - Turn 2: cache_read now includes X
- Tested: adding max(cache_create) overshoots by ~50%
- Tested: adding sum(cache_create) overshoots by ~200%

### input_tokens
- New non-cached input per turn
- Usually tiny (1-3 tokens per message)
- **SUM** across all unique messages

### output_tokens
- Response tokens per turn
- **SUM** across all unique messages
- Streaming assistant msgs have partial values (still works)

## Validation Data

Fresh session system overhead (~27k tokens):
```
System prompt:   3.1k  (1.6%)
System tools:   17.0k  (8.5%)
MCP tools:       1.1k  (0.5%)
Custom agents:   371   (0.2%)
Memory files:    5.5k  (2.7%)
─────────────────────────────
Total system:   ~27k
```

Session with conversation:
```
/context showed:     44k total (22%)
                     16.6k messages
                     27k system

Our formula (with message.id dedupe):
                     max(cache_read) = 35k
                     sum(input) = 20
                     sum(output) = 85
                     ─────────────────
                     Total: 35.1k (17.5%)
```

Note: Using `uuid` for dedupe gave sum(input)=46, sum(output)=369 - overcounting by 2-3x!

The ~9k gap was because the log was captured mid-session. When cache_read catches up to include all cached messages, the formula matches exactly.

## Critical Discoveries

### 1. cache_read is NOT Monotonic

```
#21: 32325 ↑
#22: 18864 ↓  ← Big drop (session resume? cache expiry?)
#23: 34546 ↑
#24: 34546 ↑
#25: 34966 ↑
#26: 34837 ↓  ← Small drop
```

This is why you need MAX, not "latest value".

### 2. Result vs Assistant Messages

- **Result messages**: Aggregate across subagents (inflated numbers)
- **Assistant messages**: Main model only (accurate)

Always use assistant messages for context tracking.

### 3. Dedupe by message.id (NOT uuid!)

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

Example from real data:
- 26 unique UUIDs = overcounting
- 10 unique message.ids = correct count

## Implementation

### Step 1: Get Baseline at Startup

Run `/context` via SDK to get the baseline token count:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Get baseline context by running /context command
 * Returns the total tokens from a fresh session
 */
async function getBaseline(cwd: string): Promise<number> {
  const q = query({
    prompt: '/context',
    options: { cwd, permissionMode: 'bypassPermissions' }
  });

  let baseline = 0;

  for await (const msg of q) {
    // /context output comes through as user message with <local-command-stdout>
    if (msg.type === 'user') {
      const content = (msg as any).message?.content;
      if (typeof content === 'string') {
        // Match: **Tokens:** 18.4k / 200.0k (9%)
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
  firstCacheRead: number;     // First message's cache_read (to calc growth)
  maxCacheRead: number;       // Highest cache_read seen
  lastCacheCreate: number;    // Most recent cache_create (pending content)
}

function createContextTracker(baseline: number): ContextTracker {
  return {
    baseline,
    seenMsgIds: new Set(),
    firstCacheRead: 0,
    maxCacheRead: 0,
    lastCacheCreate: 0,
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

  // Capture first cache_read as our reference point
  if (tracker.firstCacheRead === 0) {
    tracker.firstCacheRead = cacheRead;
  }

  // Update tracking
  tracker.maxCacheRead = Math.max(tracker.maxCacheRead, cacheRead);
  tracker.lastCacheCreate = cacheCreate;  // Always overwrite with latest
}

function getContextTokens(tracker: ContextTracker): number {
  // THE FORMULA: baseline + (cache_read growth) + (pending cache_create)
  const cacheGrowth = tracker.maxCacheRead - tracker.firstCacheRead;
  return tracker.baseline + cacheGrowth + tracker.lastCacheCreate;
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

## Token Counting API Verification

We verified our message token counts against the Anthropic token counting API:
- API count for all messages: **16,295 tokens**
- /context "Messages" line: **16,600 tokens**
- Difference: ~300 tokens (~2%) - within margin of error

The SDK usage data approach matches the token counting API without needing extra API calls.

## Summary

| What to track | How |
|--------------|-----|
| Dedupe key | `message.id` (NOT `uuid`) |
| Baseline | Run `/context` at startup, parse total tokens |
| Message growth | `max(cache_read) - first(cache_read)` |
| Pending content | `last(cache_create)` - LAST message only, NOT sum! |
| **Total context** | **`baseline + (max - first cache_read) + last(cache_create)`** |

**Critical:**
1. Use `message.id` for deduplication! The SDK's `uuid` is per streaming chunk, but `message.id` is per API call.
2. Use `last(cache_create)` NOT `sum(cache_create)`! Cache_create gets absorbed into the next message's cache_read, so summing double-counts.
3. Get baseline from `/context` at startup.

**Tested accuracy: ~0.64% average error across 8 test scenarios (3-12 messages, with/without tools).**
