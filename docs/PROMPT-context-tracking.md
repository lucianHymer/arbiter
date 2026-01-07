# Prompt for Next Session: Implement Context Tracking

## Task: Implement Context Tracking in Router

We figured out how to accurately calculate context window usage from SDK messages. The formula is:

```
context = max(cache_read) + sum(input) + sum(output)
```

All values from `assistant.message.usage`, **deduped by `message.id` (NOT `uuid`)**.

### Key Files to Read First:
1. `docs/HANDOFF-context-tracking.md` - Full implementation guide with code snippets
2. `.claude/knowledge/architecture/context-calculation.md` - Detailed derivation and why it works

### What to Implement:
1. **At startup**: Run `/context` via SDK in a fresh session to get system baseline (~27k tokens)
2. **Track context** using the formula above, deduped by `message.id`
3. **Log all four values** separately for auditing: `max_cache_read`, `sum_input`, `sum_output`, `sum_cache_create`
4. **Also log audit formula**: `sum(cache_create) + sum(in) + sum(out)` for comparison

### Critical Gotchas:
- **Dedupe by `message.id`**, not `uuid` - uuid is per streaming chunk, message.id is per API call. Using uuid overcounts by 2-3x!
- **cache_read is NOT monotonic** - it can drop on session resume. Use `max()` across all messages.
- **Don't include cache_creation in primary formula** - it gets absorbed into future cache_read values (double-counting)
- **Use assistant messages, NOT result messages** - results include subagent overhead

### Current State:
`src/router.ts` has partial implementation that needs updating - it's using `uuid` instead of `message.id` and has the wrong formula.
