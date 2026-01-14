# Tile-based TUI Renderer Implementation

Built a working tile-based renderer using Jerom 16x16 Fantasy Tileset, integrated with Ink TUI.

## Key Technical Findings

### ANSI Color Support
- True color ANSI codes work (`\x1b[48;2;R;G;Bm` for bg, `\x1b[38;2;R;G;Bm` for fg)
- 256-color ANSI does NOT work properly
- Direct stdout writes via `useStdout()` hook - ANSI codes bypass Ink

### Half-block Rendering Technique
- Use `▄` character with bg=top pixel, fg=bottom pixel
- Each 16×16 tile = 16 chars wide × 8 rows tall

### Tile System
- Alpha threshold = 1 (pixels with alpha < 1 are transparent)
- Tiles < 80 have own backgrounds
- Tiles >= 80 must composite on grass (tile 50)
- Focus overlay is tile 270 - corner brackets to show active speaker
- Scene is 7×6 tiles (112 chars × 48 rows)

### Animation

- Don't clear screen on animation frames (causes flashing) - just cursor home and overwrite
- Animation driven by useAnimation hook in Ink
- Frame counter cycles 0-3 at 300ms intervals
- `hopFrame` toggles during first 3 seconds of work
- `bubbleFrame` uses variable timing after 3 seconds (400-1200ms on, 600-2000ms off)
- Activated by `workingTarget`: 'arbiter' | 'orchestrator' | null

### Scene State

- `sceneState` passed to TileSceneArea via props in App.tsx
- Demo commands update sceneState (arbiter, spawn, demons, reset)
- `arbiterPos`: 0=near human, 1=center, 2=near cauldron
- `demonCount`: 0-5 demons spawned around campfire

## Ink Integration

- TileSceneArea component reserves 112-char space in flexbox layout with an empty Box
- Uses useStdout() to get write function for direct ANSI output
- Writes tile scene using cursor positioning: `\x1b[row;colH` (1-indexed)
- Tileset loaded asynchronously on mount via loadTileset()
- Scene rendered via createScene() + renderScene() from scene.ts
- Key insight: Ink uses alternate screen buffer, so direct ANSI writes at column 1 work alongside Ink's React rendering on the right side
- See gotcha about Ink clearing ANSI writes: gotchas/ink-ansi-clearing.md

## Related Files

- src/tui/components/TileSceneArea.tsx
- src/tui/tileset.ts
- src/tui/scene.ts
- src/tui/hooks/useAnimation.ts
- src/tui/App.tsx
