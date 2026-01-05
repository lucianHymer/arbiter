# Tile-Based TUI Integration Task

## Context

We've built a working prototype for a tile-based TUI renderer for the Arbiter system. The prototype is complete and demonstrates all the key features. Your job is to integrate this into the main application.

**Run `npm run demo:scene` first** to see exactly what we're building toward.

## Reference Documents

1. **`docs/tui-tile-renderer-implementation.md`** - Complete technical guide
2. **`src/tui/tile-scene-demo.ts`** - Working animated demo (study this!)
3. **`src/tui/tile-test-raw.ts`** - Raw tile rendering tests

## What Needs to Be Done

### Phase 1: Create Tile Renderer Module

Create `src/tui/tileset.ts` that exports:

```typescript
// Load tileset PNG and cache it
async function loadTileset(): Promise<Tileset>

// Extract a 16x16 tile by index
function extractTile(tileset: Tileset, index: number): RGB[][]

// Composite foreground tile on background (for alpha transparency)
function compositeTiles(fg: RGB[][], bg: RGB[][], alphaThreshold: number): RGB[][]

// Render tile to ANSI string array (16 chars wide × 8 rows)
function renderTile(pixels: RGB[][]): string[]

// Composite focus overlay on character
function compositeWithFocus(char: RGB[][], focus: RGB[][]): RGB[][]
```

Copy the working code from `tile-scene-demo.ts` - it's all there.

### Phase 2: Create Scene Module

Create `src/tui/scene.ts` that manages scene state:

```typescript
interface SceneState {
  arbiterPos: 0 | 1 | 2;  // 0=human, 1=center, 2=spellbook
  demonCount: number;      // 0-5
  focusTarget: 'human' | 'arbiter' | 'demon' | null;
  selectedCharacter: number;  // Tile index 190-197
}

function createScene(state: SceneState): TileSpec[][]
function renderScene(tileset: Tileset, scene: TileSpec[][], focusPos: Position | null): string
```

### Phase 3: Modify Layout

Update `src/tui/layout.ts`:

1. Split the screen: **left 1/3** for blessed chat panel, **right 2/3** for tile scene
2. The tile scene renders via `process.stdout.write()`, NOT through blessed
3. Chat panel continues using blessed (it handles text scrolling well)

### Phase 4: Wire Up State

Update `src/tui/index.ts` and `src/router.ts`:

**When `mode` changes:**
- `human_to_arbiter` → Animate arbiter walking to col 2, face left
- `arbiter_to_orchestrator` → Animate arbiter walking to col 4, face right

**When orchestrator spawns:**
- Increment demon count (max 5)
- Show new demon appearing at campfire

**When message is sent/received:**
- Set focus on the speaker (human, arbiter, or demon)

**When orchestrators disconnect:**
- Reset demon count to 0

### Phase 5: Character Selection Screen

Create `src/tui/screens/character-select.ts`:

1. Clear screen, show title "Choose your character"
2. Display tiles 190-197 in a row (8 human character options)
3. Arrow keys move selection highlight
4. Enter confirms selection
5. Store selected tile index, use it in scene instead of hardcoded HUMAN_1

Show this screen BEFORE starting the main arbiter session.

## ⚠️ CRITICAL: The Blessed/ANSI Problem

**THIS IS THE MOST IMPORTANT THING TO UNDERSTAND.**

We spent hours figuring this out. Blessed (the terminal UI library) **DOES NOT** pass through raw ANSI escape codes. It strips them, mangles them, or converts them. We tried:
- `tags: true` with hex colors like `{#FF6600-fg}` → Colors are wrong/quantized
- `tags: false` with raw ANSI codes → Still doesn't work
- `screen.program.write()` → Doesn't work
- Setting content with ANSI codes → Doesn't work

**THE ONLY THING THAT WORKS:**

Use `process.stdout.write()` directly, completely bypassing blessed for the tile area.

### How It Works

1. **Blessed renders the chat panel** on the left side normally
2. **After blessed renders**, we write tiles directly to stdout at specific cursor positions
3. **Cursor positioning**: `\x1b[row;colH` moves cursor to row,col
4. **We overwrite** the right side of the screen with our tile output

```typescript
// 1. Let blessed do its thing
screen.render();

// 2. Calculate where our tile panel starts (right 2/3 of screen)
const tileStartX = Math.floor(screen.width / 3);
const tileStartY = 2; // Below header

// 3. Write tiles directly to stdout, positioning each row
const tileLines = renderScene(...); // Returns array of ANSI strings
for (let row = 0; row < tileLines.length; row++) {
  // \x1b[y;xH = move cursor to row y, column x
  process.stdout.write(`\x1b[${tileStartY + row};${tileStartX}H`);
  process.stdout.write(tileLines[row]);
}
```

### Why This Works

- `process.stdout.write()` sends bytes directly to the terminal
- The terminal interprets our ANSI true color codes correctly
- Blessed doesn't touch this output because it never goes through blessed
- We're literally drawing "over" the blessed screen in the right region

### Gotchas

1. **Order matters**: Render blessed FIRST, then tiles. If blessed re-renders, it might overwrite tiles.
2. **Coordinate carefully**: Make sure tile area doesn't overlap blessed content
3. **Don't clear screen**: Just reposition cursor and overwrite (clearing causes flashing)
4. **Pad lines**: Make sure each line is full width to overwrite previous content

See `src/tui/tile-scene-demo.ts` for working code - it uses this exact approach.

### Alpha Transparency

- Tiles < 80: Have their own backgrounds, render directly
- Tiles >= 80: Characters/objects, must composite on grass (tile 50)
- Alpha threshold: 1 (pixels with alpha < 1 are transparent)

### Animation

- Don't clear screen on every frame (causes flashing)
- Just reposition cursor to home and overwrite
- Use `setInterval` for animation, ~200-500ms per frame

### Focus Overlay

- Tile 270 is a focus frame with corner brackets
- Composite it ON TOP of the character who's speaking
- Transparent center lets character show through

## File Structure After Integration

```
src/tui/
├── index.ts           # Main TUI entry, coordinates blessed + tiles
├── layout.ts          # Split layout: chat left, tiles right
├── tileset.ts         # NEW: Tile loading and rendering
├── scene.ts           # NEW: Scene state and composition
├── render.ts          # Keep for now, maybe deprecate later
├── screens/
│   └── character-select.ts  # NEW: Character selection
└── ... (other existing files)
```

## Testing

After each phase, verify:

1. **Phase 1:** `npm run test:tiles:raw` still works
2. **Phase 2:** Can render a static scene to stdout
3. **Phase 3:** Chat on left, tiles on right, no visual glitches
4. **Phase 4:** Arbiter moves when mode changes, demons appear
5. **Phase 5:** Can select character, selection persists to main scene

## Questions to Consider

- Should character selection persist across sessions? (Probably store in state/config)
- How fast should arbiter walk? (Currently 500ms per step in demo)
- Should demons have individual focus, or just "demon" as a group?
- Do we want campfire animation? (The demo doesn't animate it yet)

## Success Criteria

1. Running `npm run dev` shows character select, then main TUI
2. Chat messages appear on left, tile scene on right
3. Arbiter visually walks between human and spellbook based on mode
4. Demons spawn around campfire when orchestrators are created
5. Focus overlay shows on whoever is currently "speaking"
6. No screen flashing or visual glitches during animation
7. Ctrl+C exits cleanly

Good luck! The hard part (figuring out the rendering) is done. Now it's integration.
