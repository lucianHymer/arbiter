# TUI Tile Renderer Implementation Plan

> **STATUS: PROTOTYPE COMPLETE**
> See `docs/tui-tile-renderer-implementation.md` for the working implementation guide.
> Run `npm run demo:scene` to see the working animated demo.

## Overview

We're rebuilding the Arbiter TUI to use pixel-based tile rendering instead of ASCII art sprites. This will give us a proper roguelike aesthetic using the Jerom 16x16 Fantasy Tileset.

## Current State

The existing TUI in `src/tui/` uses:
- **blessed** library for terminal UI
- ASCII art sprites (Draconic Horror arbiter, wizard orchestrators, campfire)
- Zone-based rendering (left/center/right columns)
- Logbook overlay (Ctrl+O to toggle, D to switch summary/debug mode)

**Known Issues:**
- Wizard context % always shows 0 (bug in context tracking)
- Zone rendering is janky - sprites don't compose well
- ASCII art is hard to maintain and position

## New Approach: Half-Block Tile Rendering

### Libraries

1. **terminal-kit** (npm) - Has ScreenBuffer for tile-based rendering, image support
   - GitHub: https://github.com/cronvel/terminal-kit
   - 3.3k stars, actively maintained
   - Has sprites, screen buffers, 256/24-bit colors

2. **Image loading** - Use `sharp` or `jimp` to load PNG tileset

3. **Keep blessed** for the chat panel (left side) - it handles scrolling text well

### Half-Block Technique

Each terminal character can represent 2 vertical pixels using `▄` (U+2584):
- Background color = upper pixel
- Foreground color = lower pixel (the half-block character)

So a 16x16 pixel tile becomes **16 wide × 8 tall** characters.

## Tileset: Jerom 16x16 Fantasy

- **Source**: https://opengameart.org/content/16x16-fantasy-tileset
- **License**: CC-BY-SA 3.0
- **File**: `16x16_Jerom_CC-BY-SA-3.0.png`
- **Tile size**: 16x16 pixels
- **Tiles per row**: 10

### Tile Index Formula
```
index = row * 10 + column
```
Top-left is index 0, count left-to-right, then next row.

### Tile Mapping

```typescript
const TILES = {
  // === FORT (3x3 super-tile) ===
  FORT_TL: 20, FORT_T: 21, FORT_TR: 22,
  FORT_ML: 30, FORT_M: 31, FORT_MR: 32,
  FORT_BL: 40, FORT_B: 41, FORT_BR: 42,

  // === ENVIRONMENT ===
  GRASS_BARE: 50,      // No grass
  GRASS_SPARSE: 51,    // Little patches
  GRASS_PATCHY: 52,    // Medium grass
  GRASS_FULL: 53,      // Full grass
  PINE_TREE: 57,
  BARE_TREE: 58,       // Branches, no leaves
  FENCE: 59,
  SIGNPOST: 63,
  CAMPFIRE: 87,

  // === MAGIC ===
  SPELLBOOK: 102,      // Arbiter communes here to summon orchestrators
  // Numbered scrolls for orchestrator count display
  SCROLL_0: 110,
  SCROLL_1: 111,
  SCROLL_2: 112,
  SCROLL_3: 113,
  SCROLL_4: 114,
  SCROLL_5: 115,
  SCROLL_6: 116,
  SCROLL_7: 117,
  SCROLL_8: 118,
  SCROLL_9: 119,

  // === CHARACTERS ===
  // Human choices (for character select screen)
  HUMAN_1: 190,
  HUMAN_2: 191,
  HUMAN_3: 192,
  HUMAN_4: 193,
  HUMAN_5: 194,
  HUMAN_6: 195,
  HUMAN_7: 196,
  HUMAN_8: 197,

  // The Arbiter
  ARBITER: 205,

  // Demons (Orchestrators)
  DEMON_1: 220,
  DEMON_2: 221,
  DEMON_3: 222,
  DEMON_4: 223,
  DEMON_5: 224,
  DEMON_6: 225,
  DEMON_7: 226,
  DEMON_8: 227,
  DEMON_9: 228,
  DEMON_10: 229,
};
```

## Screen Flow

### Screen 1: Character Select
```
"You stumble through the forest to a clearing ahead..."

[Display 8 human sprites in a row: tiles 190-197]

"Choose your Character"
[Arrow keys to select, Enter to confirm]
```

### Screen 2: Enter the Lair (Narrative Transition)
```
"You emerge into the Lair of
THE ARBITER OF THAT WHICH WAS,
THAT WHICH IS,
AND THAT WHICH SHALL COME TO BE"

[Fade in or dramatic reveal of the main scene]
```

### Screen 3: Main Scene (Split Panel)

```
╔═══════════════════════════════════╦════════════════════════════════╗
║ CONVERSATION (blessed.log)        ║  THE LAIR (tile renderer)      ║
║                                   ║                                ║
║ You: Build an auth system         ║  [trees]  [fort/lair]  [trees] ║
║                                   ║                                ║
║ Arbiter: What providers?          ║  [Human]    [Arbiter]    🔥    ║
║                                   ║     ↑          ↓        demons ║
║ Orchestrator I: Exploring...      ║            [Spellbook]         ║
║                                   ║                                ║
╠═══════════════════════════════════╩════════════════════════════════╣
║ Arbiter 12% ████░░  Scroll[I] ◈ Edit(7)           [Ctrl+O] Logbook ║
╚════════════════════════════════════════════════════════════════════╝
```

**Left Panel (2/3 width):** Chat log using blessed.log - handles scrolling, text wrapping
**Right Panel (1/3 width):** Tile-rendered scene using terminal-kit ScreenBuffer

## Scene Layout

```
Row 0: [pine] [pine] [FORT_TL] [FORT_T] [FORT_TR] [pine] [pine]
Row 1: [grass] [grass] [FORT_ML] [FORT_M] [FORT_MR] [grass] [grass]
Row 2: [grass] [HUMAN] [FORT_BL] [FORT_B] [FORT_BR] [DEMON] [grass]
Row 3: [grass] [grass] [grass] [ARBITER] [grass] [DEMON] [campfire]
Row 4: [grass] [grass] [grass] [SPELLBOOK] [grass] [DEMON] [grass]
Row 5: [bare_tree] [grass] [grass] [grass] [grass] [grass] [bare_tree]
```

(Exact layout TBD - this is conceptual)

## Animation

### Arbiter Movement
- **Mode: `human_to_arbiter`** → Arbiter walks toward Human (left side)
- **Mode: `arbiter_to_orchestrator`** → Arbiter walks to Spellbook, then faces Demons

Simple position lerp:
```typescript
// Each render tick
if (arbiter.x < target.x) arbiter.x++;
if (arbiter.x > target.x) arbiter.x--;
// Same for y
```

### Campfire Animation
Swap between 2-3 fire tiles if available, or just use static tile 87.

### Orchestrator Spawn
When new orchestrator spawns, a new Demon appears at the campfire area.
- Use numbered scroll (110-119) to show orchestrator count

## Implementation Steps

### Phase 1: Tileset Loader
1. Create `src/tui/tileset.ts`
2. Load PNG with sharp/jimp
3. Split into 16x16 tiles
4. Convert each tile to half-block characters with ANSI colors
5. Cache converted tiles in a Map

```typescript
class TerminalTileset {
  private tiles: Map<number, string[]>; // tile index → array of half-block lines

  constructor(imagePath: string, tileSize: number, tilesPerRow: number);
  getTile(index: number): string[];
  renderTile(buffer: ScreenBuffer, index: number, x: number, y: number): void;
}
```

### Phase 2: Scene Renderer
1. Create `src/tui/scene.ts`
2. Define scene as 2D array of tile indices
3. Render scene to terminal-kit ScreenBuffer
4. Handle character positions (human, arbiter, demons)

### Phase 3: Split Panel Layout
1. Modify `src/tui/layout.ts`
2. Left panel: blessed.log (keep existing)
3. Right panel: terminal-kit rendering area
4. May need to coordinate between two libraries

### Phase 4: Character Select Screen
1. Create `src/tui/screens/character-select.ts`
2. Show 8 human options
3. Arrow key navigation
4. Return selected character index

### Phase 5: Animation
1. Add arbiter position tracking to state
2. Lerp position based on mode
3. Re-render scene on position change

## Files to Create/Modify

### New Files
- `src/tui/tileset.ts` - Tileset loader and half-block renderer
- `src/tui/scene.ts` - Scene layout and rendering
- `src/tui/tiles.ts` - Tile index constants (TILES object)
- `src/tui/screens/character-select.ts` - Character selection screen
- `assets/jerom_16x16.png` - The tileset image

### Modified Files
- `src/tui/layout.ts` - Split panel with terminal-kit integration
- `src/tui/render.ts` - Use new scene renderer
- `src/tui/index.ts` - Add character select flow, scene state
- `src/state.ts` - Add selected character, arbiter position

## Dependencies to Add

```bash
npm install terminal-kit sharp
npm install -D @types/terminal-kit
```

## Known Bugs to Fix

1. **Wizard/Orchestrator context % always shows null/0**

   **Diagnosis:** Two separate context trackers that aren't synchronized in `src/router.ts`:

   - **Local variable** `currentContextPercent` (line ~257 in `startOrchestratorSession`):
     - Used by PostToolUse hook via `getContextPercent` closure
     - Starts at 0, updated by orchestratorCallbacks.onContextUpdate

   - **State object** `state.currentOrchestrator.contextPercent`:
     - Updated by result message handling (lines 592-608)
     - Read when arbiter context updates (line 526: `orchPct = state.currentOrchestrator?.contextPercent ?? null`)

   **The bug:** The hook reads from the LOCAL variable, but result messages update the STATE.
   When `onContextUpdate` is called from arbiter messages, it reads `state.currentOrchestrator?.contextPercent`
   which may not have been updated yet (or ever, if the paths don't connect).

   **Fix approach:** Either:
   - Remove the local variable and always read/write from `state.currentOrchestrator.contextPercent`
   - Or ensure the local variable updates state, and state is read everywhere

2. **Debug log mode** - D key toggle was just added, verify it works

## Resources

- Jerom Tileset: https://opengameart.org/content/16x16-fantasy-tileset
- terminal-kit docs: https://github.com/cronvel/terminal-kit
- Half-block technique: https://github.com/darrenburns/rich-pixels (Python, but explains the technique)

## Questions for Next Session

1. Download and add the Jerom tileset to `assets/`
2. Should character select persist across sessions?
3. Exact scene layout dimensions (how many tiles wide/tall?)
4. Any additional tiles needed beyond the mapped ones?
