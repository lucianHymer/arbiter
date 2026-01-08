### [21:31] [architecture] SDK context calculation - combined metric formula
**Details**: The correct formula for calculating context window usage from Claude Agent SDK messages is:

**total = baseline + max(cache_read + cache_create) - first(cache_read + cache_create)**

Key insight: Track (cache_read + cache_create) as a COMBINED metric, not separately.

Why this works:
1. cache_read + cache_create at any point = total cacheable content
2. first(combined) ~= 15,372 tokens (consistent "cached system overhead")
3. max(combined) - first(combined) = message content growth
4. baseline from /context at startup ~= 18,500 tokens

The previous formula (baseline + max(cache_read) - first(cache_read) + last(cache_create)) failed badly with heavy tool use:
- Low-tool: ~0.4% error (acceptable)
- Heavy-tool: 11-25% error (UNACCEPTABLE)

New formula accuracy:
- Low-tool: ~0.55% error
- Heavy-tool: ~0.85-0.93% error

Both scenarios now within 1% error!

The combined metric handles:
- Non-monotonic cache_read drops (cache expiry, session resume)
- cache_create absorption into future cache_read
- Variable caching states across sessions
**Files**: src/router.ts, src/context-analyzer.ts, .claude/knowledge/architecture/context-calculation.md
---

