# Gotcha: Ink Clears Raw ANSI Writes on Re-render

**Date discovered:** 2026-01-06

## The Problem

When mixing raw ANSI escape sequence writes (via stdout.write) with Ink's React-based rendering, content written directly to stdout gets erased.

## Symptoms

- Content shows briefly then disappears
- Content flashes on updates
- Raw ANSI output only visible momentarily between Ink renders

## Root Cause

- Ink uses `logUpdate` which calls `ansiEscapes.eraseLines()` before each render
- When output height >= terminal rows, Ink uses `clearTerminal`
- Any raw ANSI content written between Ink renders gets erased
- `useEffect` hooks run after React render, then Ink may re-render again
- `fullscreen-ink` uses alternate screen buffer (`\x1b[?1049h`) but doesn't prevent clearing

## Solution

Use a continuous interval (e.g., 50ms) to re-render raw ANSI content, "fighting back" against Ink's clearing by constantly re-painting.

## Implementation Pattern

```tsx
const renderDataRef = useRef({ ...current values... });
renderDataRef.current = { ...updated values... };

const renderFn = useCallback(() => {
  const data = renderDataRef.current;
  // ... render to stdout using ANSI codes ...
}, [stdout]);

useEffect(() => {
  if (!ready) return;
  renderFn();  // Immediate render for responsiveness
  const id = setInterval(() => renderFn(), 50);  // Fight against Ink clearing
  return () => clearInterval(id);
}, [ready, renderFn]);
```

## Key Points

- Store render data in refs so the interval can access current values
- Render immediately on state changes for responsiveness
- Use ~50ms interval for smooth appearance without excessive CPU
- This is a workaround, not a fix - Ink fundamentally wants to control the terminal

## Related Files

- src/tui/components/TileSceneArea.tsx
- node_modules/ink/build/ink.js
- node_modules/ink/build/log-update.js
