# TUI Tile Renderer - Implementation Guide

## Overview

We've built a working tile-based renderer for the Arbiter TUI using the Jerom 16x16 Fantasy Tileset. This document captures everything needed to integrate it into the main application.

## What's Been Built

### Working Files

1. **`src/tui/tile-test-raw.ts`** - Raw tile rendering test (no blessed)
   - Run: `npm run test:tiles:raw`
   - Shows all tiles, tests color rendering

2. **`src/tui/tile-scene-demo.ts`** - Animated scene demo
   - Run: `npm run demo:scene`
   - Shows the complete unified scene with animation
   - Demonstrates focus overlay, demon spawning, arbiter walking

3. **`assets/jerom_16x16.png`** - The tileset (CC-BY-SA 3.0)

### Key Discoveries

#### Rendering Approach
- **True color ANSI** works: `\x1b[48;2;R;G;Bm` (background) and `\x1b[38;2;R;G;Bm` (foreground)
- **256-color does NOT work** properly in our setup
- **blessed does NOT pass through** ANSI codes - must use `process.stdout.write()` directly
- **Half-block technique**: Use `▄` character with bg=top pixel, fg=bottom pixel
- Each **16×16 pixel tile = 16 chars wide × 8 rows tall**

#### Alpha/Transparency
- **Alpha threshold = 1** (pixels with alpha < 1 are transparent)
- **Tiles < 80** have their own background (render as-is)
- **Tiles >= 80** must be composited on grass (tile 50) background

#### Scene Layout
- **7×6 tile grid** = 112 chars wide × 48 rows tall
- Fits in ~1/3 of a typical wide terminal

## Tile Reference

```typescript
const TILE = {
  // Environment (have own backgrounds)
  GRASS: 50,
  GRASS_SPARSE: 51,
  PINE_TREE: 57,
  BARE_TREE: 58,

  // Objects (composite on grass)
  CAMPFIRE: 87,
  SPELLBOOK: 102,

  // Characters (composite on grass)
  HUMAN_1: 190,  // through HUMAN_8: 197 for character select
  ARBITER: 205,
  DEMON_1: 220,  // through DEMON_5: 224

  // UI
  FOCUS: 270,    // Corner bracket overlay for active speaker
};
```

## Unified Scene Layout

```
Col:    0      1      2      3      4         5         6
Row 0: [tree] [bare] [grass] [grass] [grass]  [grass]  [tree]
Row 1: [tree] [grass][grass] [grass] [spellbook][demon?][demon?]
Row 2: [tree] [HUMAN][<--- ARBITER WALKS --->] [campfire][demon?]
Row 3: [tree] [grass][grass] [grass] [grass]  [demon?] [demon?]
Row 4: [tree] [bare] [grass] [grass] [grass]  [grass]  [tree]
Row 5: [tree] [grass][grass] [grass] [grass]  [grass]  [tree]
```

- **Human** at row 2, col 1 (emerging from forest)
- **Arbiter** walks columns 2-4 (row 2)
  - Col 2: Near human (facing left)
  - Col 3: Center (walking)
  - Col 4: At spellbook (facing right)
- **Spellbook** at row 1, col 4
- **Campfire** at row 2, col 5
- **Demons** spawn around campfire in order:
  1. Row 2, col 6 (right of fire)
  2. Row 1, col 6 (above-right)
  3. Row 3, col 6 (below-right)
  4. Row 1, col 5 (above fire)
  5. Row 3, col 5 (below fire)

## Focus Overlay

Tile 270 is a focus overlay with corner brackets. Composite it ON TOP of a character tile to show who's speaking:

```typescript
function compositeWithFocus(charPixels, focusPixels, alphaThreshold) {
  // Focus pixels that are opaque overlay the character
  // Focus pixels that are transparent show the character through
}
```

## Animation States

### Mode: Human ↔ Arbiter
- Arbiter at col 2, facing left (mirrored)
- Focus alternates between human and arbiter
- Demons reset to 0

### Mode: Arbiter ↔ Orchestrators
- Arbiter at col 4, facing right
- Arbiter "summons" through spellbook
- Demons spawn 1 by 1 around campfire
- Focus alternates between arbiter and active demon

### Walking (transition)
- No focus shown
- Arbiter moves one column per frame

## Integration with Blessed

The main TUI uses blessed for the chat panel. For tile rendering:

1. **Use blessed** for left panel (chat/logbook) - it handles text well
2. **Use direct stdout** for right panel (tiles) - blessed mangles ANSI codes
3. **Coordinate positioning**: Calculate tile panel start X based on blessed layout
4. **Timing**: Render tiles AFTER blessed renders, use `setTimeout` if needed

```typescript
// After blessed screen.render()
const startX = Math.floor(screen.width * 0.33); // Right 2/3 for tiles
const startY = 2;

// Position cursor and write tiles directly
process.stdout.write(`\x1b[${startY};${startX}H${tileOutput}`);
```

## Character Selection Screen

**Not yet implemented** but planned:

- Show tiles 190-197 (8 human character options)
- Arrow keys to select
- Enter to confirm
- Store selected character index
- Use selected character tile instead of HUMAN_1 in scene

## Files to Create for Full Integration

1. **`src/tui/tileset.ts`** - Tileset loader and renderer module
   - Export: `loadTileset()`, `renderTile()`, `compositeTiles()`

2. **`src/tui/scene.ts`** - Scene state and rendering
   - Export: `createScene()`, `renderScene()`, `updateScene()`
   - Track: arbiter position, demon count, focus target

3. **`src/tui/screens/character-select.ts`** - Character selection
   - Show 8 options, handle input, return selection

4. **Modify `src/tui/index.ts`** - Integrate tile scene
   - Add character select flow
   - Split layout: blessed left, tiles right
   - Wire up state changes to scene updates

## State Mapping

Map existing app state to scene state:

| App State | Scene Effect |
|-----------|--------------|
| `mode === 'human_to_arbiter'` | Arbiter walks to col 2, faces human |
| `mode === 'arbiter_to_orchestrator'` | Arbiter walks to col 4, faces spellbook |
| `currentOrchestrator !== null` | Show demon for that orchestrator |
| Human sends message | Focus on human |
| Arbiter responds | Focus on arbiter |
| Orchestrator responds | Focus on corresponding demon |

## Dependencies

Already installed:
- `sharp` - PNG loading and pixel extraction
- `blessed` - Chat panel (left side)

Not needed:
- `terminal-kit` - We use direct ANSI instead

## Running the Demo

```bash
# See all tiles
npm run test:tiles:raw

# See animated scene
npm run demo:scene
```

Press Ctrl+C to exit the demo.
