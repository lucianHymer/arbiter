# Gotcha: Requirements Overlay Clearing Approach

**Date discovered:** 2026-01-11

## The Problem

A previous implementation tried to manually fill the chat area with black background using ANSI escape codes, but this was overly complex and had coordinate alignment issues (hardcoded `sceneWidth=112` vs actual `chatAreaX=115`).

## The Solution

Use `term.clear()` to clear the entire screen before drawing the overlay. This is simpler and more reliable.

## How It Works

1. `term.clear()` clears everything
2. Draw only the scene (tile area)
3. Chat area stays naturally cleared/empty
4. Guards in `drawTiles()` and `drawChat()` check `state.requirementsOverlay !== 'none'`
5. Guards prevent any subsequent redraws from overwriting the cleared state

## Key Pattern

```typescript
// In draw functions
if (state.requirementsOverlay !== 'none') {
  return; // Don't redraw during overlay
}
```

## Related Files

- src/tui/tui-termkit.ts
