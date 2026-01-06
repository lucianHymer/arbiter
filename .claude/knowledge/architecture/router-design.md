# Router Design - Message Forwarding

## Critical Principle

The forwarding of messages between Arbiter and Orchestrator is CORRECT and MUST STAY.

## The Problem: Text Tagging

Bad patterns that were removed:
- `"Orchestrator I: " + text` when forwarding to Arbiter
- `"Human: " + text` when forwarding human messages
- Echo filtering as band-aid

## The Fix

- Keep forwarding (that's the whole point!)
- Remove text tags - just forward raw text
- Remove echo filtering - let them figure it out
- Track message source via mode, not text parsing
- spawn_orchestrator has no prompt - orchestrator introduces itself

## Related Files

- src/router.ts
- docs/HANDOFF-router-refactor.md
