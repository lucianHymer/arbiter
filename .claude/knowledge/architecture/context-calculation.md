# SDK Context Window Tracking - Session Fork Polling

## The Problem

Claude's Agent SDK returns usage data per message, but calculating accurate context window usage from these values proved unreliable. The `/context` command shows accurate breakdowns, but isn't directly accessible programmatically.

Previous approaches tried to calculate from usage tokens (`cache_read_input_tokens`, `cache_creation_input_tokens`, etc.) but these calculations had accuracy issues under heavy tool use.

## The Solution: Session Fork Polling

Instead of calculating context from usage data, we poll the actual context by forking sessions and running `/context`:

1. **Fork the session** using `resume: sessionId` + `forkSession: true`
2. **Run `/context`** in the forked session
3. **Parse the output** to get the actual token count/percentage
4. **Discard the fork** (it was just for checking)

This gives us the actual authoritative context value without polluting the main conversation.

## Implementation

### Polling Function

```typescript
async function pollContextForSession(sessionId: string): Promise<number | null> {
  try {
    const q = query({
      prompt: '/context',
      options: {
        resume: sessionId,
        forkSession: true,  // Fork to avoid polluting main session
        permissionMode: 'bypassPermissions',
      },
    });

    let percent: number | null = null;

    for await (const msg of q) {
      if (msg.type === 'user') {
        const content = msg.message?.content;
        if (typeof content === 'string') {
          // Match: **Tokens:** 18.4k / 200.0k (9%)
          const match = content.match(/\*\*Tokens:\*\*\s*([0-9.]+)k\s*\/\s*200\.?0?k\s*\((\d+)%\)/i);
          if (match) {
            percent = parseInt(match[2], 10);
          }
        }
      }
    }

    return percent;
  } catch (error) {
    // Silently fail - context polling is best-effort
    return null;
  }
}
```

### Periodic Polling

Poll both Arbiter and Orchestrator (if active) once per minute:

```typescript
const CONTEXT_POLL_INTERVAL_MS = 60_000;

private startContextPolling(): void {
  // Poll immediately, then every minute
  this.pollAllContexts();
  this.contextPollInterval = setInterval(() => {
    this.pollAllContexts();
  }, CONTEXT_POLL_INTERVAL_MS);
}

private async pollAllContexts(): Promise<void> {
  // Poll Arbiter
  if (this.state.arbiterSessionId) {
    const percent = await pollContextForSession(this.state.arbiterSessionId);
    if (percent !== null) {
      updateArbiterContext(this.state, percent);
    }
  }

  // Poll Orchestrator if active
  if (this.currentOrchestratorSession?.sessionId) {
    const percent = await pollContextForSession(this.currentOrchestratorSession.sessionId);
    if (percent !== null) {
      updateOrchestratorContext(this.state, percent);
    }
  }
}
```

## Why This Approach

### Advantages

1. **100% Accurate** - Uses the authoritative `/context` command
2. **Simple** - No complex calculations or tracking state
3. **Robust** - Works regardless of caching behavior or tool use patterns
4. **Non-polluting** - `forkSession: true` creates a throwaway branch

### Tradeoffs

1. **Polling Latency** - Values update once per minute, not per-message
2. **Extra API Calls** - One fork + /context per active session per minute
3. **Async Updates** - Context values may lag behind actual usage

For the Arbiter project, the 1-minute polling interval is acceptable since:
- Context warnings are informational, not critical
- The polling approach is simpler to maintain
- Accuracy is more important than real-time updates

## Related Files

- src/router.ts: `pollContextForSession()`, `startContextPolling()`, `pollAllContexts()`
- src/state.ts: `updateArbiterContext()`, `updateOrchestratorContext()`

## Historical Note

The previous calculation-based approach (documented in earlier versions of this file) attempted to derive context from SDK usage tokens using formulas like:

```
total = baseline + max(cache_read + cache_create) - first(cache_read + cache_create) + sum(input) + sum(output)
```

While this achieved ~0.3% accuracy in controlled tests, it proved unreliable in production with varying cache states and heavy tool use. The polling approach eliminates these edge cases entirely.
