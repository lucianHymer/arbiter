### [14:54] [gotcha] SDK cache_read doesn't include full system overhead
**Details**: The SDK's cache_read_input_tokens value from assistant.message.usage does NOT include the full system overhead. Testing shows:

- /context reports system ~18.6k tokens
- First SDK cache_read ~15.3k tokens
- SYSTEM_GAP = ~3.3k tokens (system prompt tokens not in cache)

This means the formula `max(cache_read) + sum(input) + sum(output)` will undercount by ~17-19%.

The corrected formula requires calculating SYSTEM_GAP at startup:
```
SYSTEM_GAP = baseline_system_from_context - first_cache_read
total = max(cache_read) + sum(input) + sum(output) + SYSTEM_GAP
```

Accuracy with correction:
- Simple conversations: -0.3% error
- Tool-heavy conversations: -2.3% error

The slight undershoot with tools is due to pending tool results not yet cached.
**Files**: src/router.ts, src/context-analyzer.ts
---

### [17:44] [architecture] Context calculation formula - FINAL WORKING VERSION
**Details**: The definitive formula for calculating context window usage from SDK metrics:

```
total = system_gap + max(cache_read) + last(cache_create)
```

Where:
- `system_gap = baseline_from_context - first_cache_read` (~3.2-3.6k typically)
- `max(cache_read)` = highest cache_read_input_tokens across all messages (dedupe by message.id)
- `last(cache_create)` = cache_creation_input_tokens from the LAST message only (NOT sum!)

WHY last() instead of sum():
- cache_create gets absorbed into the next message's cache_read
- Summing would double-count as content moves through the cache
- Only the last message's cache_create represents "pending" uncached content

Tested across 8 scenarios (3-12 messages, with/without tools):
- All results within 1.5% error
- Most within 1% error
- Average absolute error: ~0.64%

To get baseline: Run `/context` command via SDK at session start and parse the total tokens.
**Files**: src/router.ts, src/context-analyzer.ts, .claude/knowledge/architecture/context-calculation.md
---

