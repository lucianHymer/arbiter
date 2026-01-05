/**
 * Forest Intro Screen
 *
 * A narrative intro screen between character select and main TUI.
 * Shows a forest scene with the selected character walking through it.
 * Features Zelda-style dialogue box overlays.
 */

import {
  Tileset,
  loadTileset,
  extractTile,
  compositeTiles,
  renderTile,
  TILE,
  CHAR_HEIGHT,
  RESET,
  CLEAR_SCREEN,
  CURSOR_HOME,
  HIDE_CURSOR,
  SHOW_CURSOR,
  RGB,
} from '../tileset.js';

// Dialogue box tile indices (2x2 tile message window)
const DIALOGUE_TILES = {
  TOP_LEFT: 38,
  TOP_RIGHT: 39,
  BOTTOM_LEFT: 48,
  BOTTOM_RIGHT: 49,
};

// Scene dimensions: 7 tiles wide x 5 tiles tall
const SCENE_WIDTH = 7;
const SCENE_HEIGHT = 5;

// Arrow key escape sequences
const KEY_ENTER = '\r';
const KEY_ENTER_ALT = '\n';
const KEY_CTRL_C = '\u0003';

// ANSI color codes
const BOLD = '\x1b[1m';
const WHITE = '\x1b[97m';
const BG_BLACK = '\x1b[40m';

// True color theme colors (RGB)
const COLOR_ARBITER = '\x1b[38;2;100;255;100m';  // Green for THE ARBITER
const COLOR_WAS = '\x1b[38;2;100;200;255m';      // Blue-cyan for "WAS"
const COLOR_IS = '\x1b[38;2;200;100;255m';       // Purple for "IS"

/**
 * Apply rainbow colors to text (each character gets a different color from the spectrum)
 */
function rainbow(text: string): string {
  const colors = [
    [255, 100, 100], // red
    [255, 200, 100], // orange
    [255, 255, 100], // yellow
    [100, 255, 100], // green
    [100, 255, 255], // cyan
    [100, 100, 255], // blue
    [200, 100, 255], // purple
    [255, 100, 255], // magenta
  ];
  let result = '';
  let colorIndex = 0;
  for (const char of text) {
    if (char === ' ') {
      result += char;
    } else {
      const [r, g, b] = colors[colorIndex % colors.length];
      result += `\x1b[38;2;${r};${g};${b}m${char}`;
      colorIndex++;
    }
  }
  return result + RESET;
}

// Box-drawing characters for Zelda-style dialogue box
const BOX_TOP_LEFT = '╔';
const BOX_TOP_RIGHT = '╗';
const BOX_BOTTOM_LEFT = '╚';
const BOX_BOTTOM_RIGHT = '╝';
const BOX_HORIZONTAL = '═';
const BOX_VERTICAL = '║';

/**
 * Move cursor to a specific position
 */
function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/**
 * Create the forest scene layout
 * Layout (7x5):
 *   0: [pine] [pine]  [bare]  [grass] [bare]  [pine]  [pine]
 *   1: [pine] [grass] [grass] [grass] [grass] [grass] [pine]
 *   2: [path] [path...]                        [path] [path]  <- character walks here (path through both edges)
 *   3: [pine] [grass] [grass] [grass] [grass] [grass] [pine]
 *   4: [pine] [bare]  [grass] [grass] [grass] [bare]  [pine]
 */
function createForestScene(characterTile: number | null, characterCol: number): number[][] {
  const scene: number[][] = [];

  for (let row = 0; row < SCENE_HEIGHT; row++) {
    const sceneRow: number[] = [];
    for (let col = 0; col < SCENE_WIDTH; col++) {
      let tile: number = TILE.GRASS;

      // Left edge trees (except path row)
      if (col === 0 && row !== 2) {
        tile = TILE.PINE_TREE;
      }

      // Right edge trees (except path row)
      if (col === 6 && row !== 2) {
        tile = TILE.PINE_TREE;
      }

      // Top row: mix of trees
      if (row === 0) {
        if (col === 0 || col === 1 || col === 5 || col === 6) tile = TILE.PINE_TREE;
        if (col === 2 || col === 4) tile = TILE.BARE_TREE;
      }

      // Bottom row: mix of trees
      if (row === 4) {
        if (col === 0 || col === 6) tile = TILE.PINE_TREE;
        if (col === 1 || col === 5) tile = TILE.BARE_TREE;
      }

      // Add signpost near right edge, above path
      if (row === 1 && col === 5) {
        tile = 63; // Signpost tile
      }

      // Middle path row (row 2) - sparse grass for path ALL THE WAY THROUGH (col 0 to 6)
      if (row === 2) {
        tile = TILE.GRASS_SPARSE;
      }

      // Place character on the path (row 2)
      if (row === 2 && col === characterCol && characterTile !== null && characterCol >= 0 && characterCol < SCENE_WIDTH) {
        tile = characterTile;
      }

      sceneRow.push(tile);
    }
    scene.push(sceneRow);
  }

  return scene;
}

/**
 * Render the forest scene to terminal
 */
function renderForestScene(
  tileset: Tileset,
  grassTile: ReturnType<typeof extractTile>,
  scene: number[][],
  startRow: number
): void {
  // Pre-render all tiles
  const renderedTiles: string[][][] = [];

  for (let row = 0; row < scene.length; row++) {
    const renderedRow: string[][] = [];
    for (let col = 0; col < scene[row].length; col++) {
      const tileIndex = scene[row][col];
      let pixels = extractTile(tileset, tileIndex);

      // Composite characters/objects on grass background
      if (tileIndex >= 80) {
        pixels = compositeTiles(pixels, grassTile, 1);
      }

      renderedRow.push(renderTile(pixels));
    }
    renderedTiles.push(renderedRow);
  }

  // Output to terminal
  for (let tileRow = 0; tileRow < scene.length; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      const terminalRow = startRow + tileRow * CHAR_HEIGHT + charRow;
      process.stdout.write(moveCursor(terminalRow, 1));
      for (let tileCol = 0; tileCol < scene[tileRow].length; tileCol++) {
        process.stdout.write(renderedTiles[tileRow][tileCol][charRow]);
      }
    }
  }
}

/**
 * Center text on the screen (assuming 112 char width for 7 tiles)
 */
function centerText(text: string, width: number = 112): string {
  const padding = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(padding) + text;
}

/**
 * Strip ANSI escape codes from a string to get visible length
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Render a tile-based dialogue box using tiles 38-39 (top) and 48-49 (bottom)
 * Creates a 2x2 tile frame with text overlaid in the center
 *
 * The tiles form:
 * [38][39]  = top-left, top-right (32 chars wide x 8 rows)
 * [48][49]  = bottom-left, bottom-right (32 chars wide x 8 rows)
 *
 * Total box: 32 chars wide x 16 rows tall (2 tiles x 2 tiles)
 *
 * For wider text, we extend the box horizontally by repeating middle sections
 */
function renderTileDialogue(
  tileset: Tileset,
  startRow: number,
  startCol: number,
  lines: string[],
  boxWidthTiles: number = 4 // Width in tiles (minimum 2)
): void {
  // Extract the 4 corner dialogue tiles
  const topLeft = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
  const topRight = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);
  const bottomLeft = extractTile(tileset, DIALOGUE_TILES.BOTTOM_LEFT);
  const bottomRight = extractTile(tileset, DIALOGUE_TILES.BOTTOM_RIGHT);

  // Render each tile to string arrays
  const tlRendered = renderTile(topLeft);
  const trRendered = renderTile(topRight);
  const blRendered = renderTile(bottomLeft);
  const brRendered = renderTile(bottomRight);

  // For a wider box, we need middle fill tiles
  // Extract a middle section from the right edge of top-left and left edge of top-right
  // to create a seamless horizontal expansion
  const middleTopRendered: string[] = [];
  const middleBottomRendered: string[] = [];

  // Create middle fill by extracting columns from the tiles
  // Use the rightmost column of top-left and leftmost of top-right as patterns
  for (let row = 0; row < CHAR_HEIGHT; row++) {
    // For middle sections, create a solid fill based on the tile edge colors
    // Extract a 16-char wide section that can be repeated
    const middleTopRow = createMiddleFill(topLeft, topRight, row);
    const middleBottomRow = createMiddleFill(bottomLeft, bottomRight, row);
    middleTopRendered.push(middleTopRow);
    middleBottomRendered.push(middleBottomRow);
  }

  // Calculate actual width in characters (16 chars per tile)
  const tileWidth = 16;
  const totalWidthChars = boxWidthTiles * tileWidth;
  const middleTiles = Math.max(0, boxWidthTiles - 2);

  // Render top row of tiles
  for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
    process.stdout.write(moveCursor(startRow + charRow, startCol));
    process.stdout.write(tlRendered[charRow]);
    for (let m = 0; m < middleTiles; m++) {
      process.stdout.write(middleTopRendered[charRow]);
    }
    process.stdout.write(trRendered[charRow]);
  }

  // Render bottom row of tiles
  for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
    process.stdout.write(moveCursor(startRow + CHAR_HEIGHT + charRow, startCol));
    process.stdout.write(blRendered[charRow]);
    for (let m = 0; m < middleTiles; m++) {
      process.stdout.write(middleBottomRendered[charRow]);
    }
    process.stdout.write(brRendered[charRow]);
  }

  // Sample background color from the center of the dialogue tile
  // This lets text blend with the tile background instead of showing terminal black
  const bgSamplePixel = topLeft[8][8]; // Center pixel of top-left tile
  const textBgColor = `\x1b[48;2;${bgSamplePixel.r};${bgSamplePixel.g};${bgSamplePixel.b}m`;

  // Overlay text in the center of the box
  // Total box height is 16 rows (2 tiles * 8 rows each)
  // Center the text vertically
  const boxHeight = CHAR_HEIGHT * 2; // 16 rows
  const textStartRow = startRow + Math.floor((boxHeight - lines.length) / 2);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const visibleLength = stripAnsi(line).length;
    // Center each line horizontally within the box
    const padding = Math.max(0, Math.floor((totalWidthChars - visibleLength) / 2));
    process.stdout.write(moveCursor(textStartRow + i, startCol + padding));
    // Apply tile background color to text so it blends with the dialogue box
    process.stdout.write(textBgColor + line + RESET);
  }
}

/**
 * Create a middle fill row by blending the right edge of left tile with left edge of right tile
 * This creates a seamless horizontal fill for expanding the dialogue box
 */
function createMiddleFill(leftTile: RGB[][], rightTile: RGB[][], charRow: number): string {
  // Each char row corresponds to 2 pixel rows (due to half-block rendering)
  const pixelRowTop = charRow * 2;
  const pixelRowBot = pixelRowTop + 1;

  let result = '';

  // Use the full width of a tile (16 pixels = 16 chars)
  for (let x = 0; x < 16; x++) {
    // Sample from middle of left tile for fill pattern
    const sampleX = 8; // Middle column

    const topPixel = leftTile[pixelRowTop][sampleX];
    const botPixel = leftTile[pixelRowBot]?.[sampleX] || topPixel;

    // True color ANSI: background = top pixel, foreground = bottom pixel
    result += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
    result += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
    result += '▄';
  }
  result += RESET;

  return result;
}

/**
 * Render a Zelda-style dialogue box overlay on top of the scene
 * Uses ANSI box-drawing characters for the border
 * @deprecated Use renderTileDialogue for tile-based rendering
 */
function renderDialogueBox(
  startRow: number,
  startCol: number,
  width: number,
  lines: string[]
): void {
  const height = lines.length + 2; // +2 for top and bottom border

  // Top border
  process.stdout.write(moveCursor(startRow, startCol));
  process.stdout.write(
    `${BG_BLACK}${WHITE}${BOX_TOP_LEFT}${BOX_HORIZONTAL.repeat(width - 2)}${BOX_TOP_RIGHT}${RESET}`
  );

  // Content lines
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(moveCursor(startRow + 1 + i, startCol));
    const line = lines[i];
    const paddedLine = line.padEnd(width - 2, ' ');
    process.stdout.write(`${BG_BLACK}${WHITE}${BOX_VERTICAL}${paddedLine}${BOX_VERTICAL}${RESET}`);
  }

  // Bottom border
  process.stdout.write(moveCursor(startRow + height - 1, startCol));
  process.stdout.write(
    `${BG_BLACK}${WHITE}${BOX_BOTTOM_LEFT}${BOX_HORIZONTAL.repeat(width - 2)}${BOX_BOTTOM_RIGHT}${RESET}`
  );
}

/**
 * Wait for Enter key press
 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const handleKey = (key: string) => {
      if (key === KEY_CTRL_C) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handleKey);
        process.stdout.write(SHOW_CURSOR);
        process.stdout.write(CLEAR_SCREEN);
        process.stdout.write(CURSOR_HOME);
        process.exit(0);
      } else if (key === KEY_ENTER || key === KEY_ENTER_ALT) {
        process.stdin.removeListener('data', handleKey);
        resolve();
      }
    };

    process.stdin.on('data', handleKey);
  });
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Show the forest intro screen
 *
 * @param selectedCharacter - The tile index of the selected character (190-197)
 * @returns Promise that resolves when the intro is complete
 */
export async function showForestIntro(selectedCharacter: number): Promise<void> {
  // Load tileset
  const tileset = await loadTileset();
  // Use sparse grass (trail tile) for character compositing, not plain grass
  const trailTile = extractTile(tileset, TILE.GRASS_SPARSE);

  // Setup terminal
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(CURSOR_HOME);
  process.stdout.write(HIDE_CURSOR);

  // Setup raw mode for key input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const sceneStartRow = 3;
  // Calculate dialogue box position (overlayed on the scene)
  // Tile-based dialogue box: 4 tiles wide = 64 chars (centered in 112 char scene)
  const dialogueBoxWidthTiles = 5; // 5 tiles = 80 chars wide for full title
  const dialogueBoxWidthChars = dialogueBoxWidthTiles * 16;
  const dialogueBoxCol = Math.floor((112 - dialogueBoxWidthChars) / 2) + 1;
  // Position dialogue box in the lower portion of the scene (16 rows tall = 2 tile rows)
  const dialogueBoxRow = sceneStartRow + SCENE_HEIGHT * CHAR_HEIGHT - 16;

  // -------------------------------------------------------------------------
  // Phase 1: Show forest scene with tile-based dialogue box overlay
  // Auto-start walking after ~2 seconds (no Enter needed)
  // -------------------------------------------------------------------------

  // Render initial forest scene (no character yet)
  const initialScene = createForestScene(null, -1);
  renderForestScene(tileset, trailTile, initialScene, sceneStartRow);

  // Render tile-based dialogue box overlay with first text
  // Use simple white text - no background colors, let tile show through
  renderTileDialogue(tileset, dialogueBoxRow, dialogueBoxCol, [
    `${WHITE}YOU WANDER THROUGH${RESET}`,
    `${WHITE}THE FOREST...${RESET}`,
    '',
    `${WHITE}TOWARDS A CLEARING AHEAD${RESET}`,
  ], dialogueBoxWidthTiles);

  // Wait ~2 seconds, then auto-start walking (no Enter needed)
  await sleep(2000);

  // -------------------------------------------------------------------------
  // Phase 2: Animate character walking across the screen
  // Character walks from left edge (col 0) to right edge (col 6) and STOPS there
  // -------------------------------------------------------------------------

  // Walk from left (col 0) to col 5 (next to the signpost)
  for (let col = 0; col <= SCENE_WIDTH - 2; col++) {
    // Create scene with character at current position
    const walkScene = createForestScene(selectedCharacter, col);
    renderForestScene(tileset, trailTile, walkScene, sceneStartRow);

    // Wait between frames
    await sleep(350);
  }

  // -------------------------------------------------------------------------
  // Phase 3: Show second dialogue with "THE ARBITER" full title
  // Character stays at right edge, wait for Enter here
  // -------------------------------------------------------------------------

  // Render scene with character at col 5 (next to the signpost)
  const finalScene = createForestScene(selectedCharacter, SCENE_WIDTH - 2);
  renderForestScene(tileset, trailTile, finalScene, sceneStartRow);

  // Render tile-based dialogue box with THE ARBITER full title reveal
  // Use colorful text for emphasis on key phrases
  renderTileDialogue(tileset, dialogueBoxRow, dialogueBoxCol, [
    `${WHITE}You approach the lair of${RESET}`,
    '',
    `${BOLD}${COLOR_ARBITER}THE ARBITER${RESET}`,
    `${WHITE}OF THAT WHICH ${COLOR_WAS}WAS${WHITE},${RESET}`,
    `${WHITE}THAT WHICH ${COLOR_IS}IS${WHITE},${RESET}`,
    `${WHITE}AND THAT WHICH ${rainbow('SHALL COME TO BE')}`,
    '',
    `${WHITE}Press Enter to continue...${RESET}`,
  ], dialogueBoxWidthTiles);

  // Wait for Enter
  await waitForEnter();

  // Cleanup - reset terminal but don't clear (let caller handle that)
  process.stdin.setRawMode(false);
  process.stdin.pause();
}

// Allow running directly for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  // Default to first human character (TILE.HUMAN_1 = 190) for testing
  const testCharacter = parseInt(process.argv[2] || '190', 10);

  showForestIntro(testCharacter)
    .then(() => {
      process.stdout.write(SHOW_CURSOR);
      process.stdout.write(CLEAR_SCREEN);
      process.stdout.write(CURSOR_HOME);
      console.log('Forest intro complete!');
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write(SHOW_CURSOR);
      console.error('Error:', err);
      process.exit(1);
    });
}
