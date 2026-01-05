/**
 * Forest Intro Screen
 *
 * A narrative intro screen between character select and main TUI.
 * Shows a forest scene with the selected character walking through it.
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
} from '../tileset.js';

// Scene dimensions: 7 tiles wide x 5 tiles tall
const SCENE_WIDTH = 7;
const SCENE_HEIGHT = 5;

// Arrow key escape sequences
const KEY_ENTER = '\r';
const KEY_ENTER_ALT = '\n';
const KEY_CTRL_C = '\u0003';

// ANSI color codes
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BRIGHT_YELLOW = '\x1b[93m';
const BRIGHT_RED = '\x1b[91m';
const BOLD = '\x1b[1m';

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
 *   2: [tree] [path...]                               [tree]  <- character walks here
 *   3: [pine] [grass] [grass] [grass] [grass] [grass] [pine]
 *   4: [pine] [bare]  [grass] [grass] [grass] [bare]  [pine]
 */
function createForestScene(characterTile: number | null, characterCol: number): number[][] {
  const scene: number[][] = [];

  for (let row = 0; row < SCENE_HEIGHT; row++) {
    const sceneRow: number[] = [];
    for (let col = 0; col < SCENE_WIDTH; col++) {
      let tile: number = TILE.GRASS;

      // Left edge trees
      if (col === 0) {
        tile = TILE.PINE_TREE;
      }

      // Right edge trees
      if (col === 6) {
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

      // Middle path row (row 2) - sparse grass for path
      if (row === 2 && col >= 1 && col <= 5) {
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
  const grassTile = extractTile(tileset, TILE.GRASS);

  // Setup terminal
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(CURSOR_HOME);
  process.stdout.write(HIDE_CURSOR);

  // Setup raw mode for key input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  const sceneStartRow = 3;
  const textRow = sceneStartRow + SCENE_HEIGHT * CHAR_HEIGHT + 2;

  // -------------------------------------------------------------------------
  // Phase 1: Show forest scene with first dramatic narrative text
  // -------------------------------------------------------------------------

  // Render initial forest scene (no character yet)
  const initialScene = createForestScene(null, -1);
  renderForestScene(tileset, grassTile, initialScene, sceneStartRow);

  // Display first dramatic multi-line narrative text
  process.stdout.write(moveCursor(textRow, 1));
  process.stdout.write(centerText(`${BOLD}${BRIGHT_YELLOW}YOU WANDER THROUGH${RESET}`));
  process.stdout.write(moveCursor(textRow + 1, 1));
  process.stdout.write(centerText(`${BOLD}${BRIGHT_YELLOW}THE FOREST...${RESET}`));
  process.stdout.write(moveCursor(textRow + 3, 1));
  process.stdout.write(centerText(`${BOLD}${YELLOW}TOWARDS A CLEARING AHEAD${RESET}`));

  // Show prompt
  const promptRowPhase1 = textRow + 5;
  process.stdout.write(moveCursor(promptRowPhase1, 1));
  process.stdout.write(centerText(`${CYAN}Press Enter to continue...${RESET}`));

  // Wait for Enter
  await waitForEnter();

  // Clear the text area
  for (let i = 0; i < 6; i++) {
    process.stdout.write(moveCursor(textRow + i, 1));
    process.stdout.write(' '.repeat(112));
  }

  // -------------------------------------------------------------------------
  // Phase 2: Animate character walking across the screen (starts immediately)
  // -------------------------------------------------------------------------

  // Walk from left (-1, off-screen) to right (7, off-screen)
  for (let col = -1; col <= SCENE_WIDTH; col++) {
    // Create scene with character at current position
    const walkScene = createForestScene(selectedCharacter, col);
    renderForestScene(tileset, grassTile, walkScene, sceneStartRow);

    // Wait between frames
    await sleep(350);
  }

  // -------------------------------------------------------------------------
  // Phase 3: Show EPIC second narrative text with dramatic title reveal
  // -------------------------------------------------------------------------

  // Render final forest scene (character has exited)
  const finalScene = createForestScene(null, -1);
  renderForestScene(tileset, grassTile, finalScene, sceneStartRow);

  // Display EPIC multi-line title with dramatic styling
  // Line 1: "YOU APPROACH THE LAIR OF"
  process.stdout.write(moveCursor(textRow, 1));
  process.stdout.write(centerText(`${BOLD}${BRIGHT_YELLOW}YOU APPROACH THE LAIR OF${RESET}`));

  // Dramatic pause
  await sleep(600);

  // Line 2: "THE ARBITER" - in red/orange for emphasis
  process.stdout.write(moveCursor(textRow + 2, 1));
  process.stdout.write(centerText(`${BOLD}${BRIGHT_RED}THE ARBITER${RESET}`));

  // Dramatic pause
  await sleep(800);

  // Lines 3-5: The dramatic subtitle
  process.stdout.write(moveCursor(textRow + 4, 1));
  process.stdout.write(centerText(`${BOLD}${YELLOW}OF THAT WHICH WAS,${RESET}`));
  await sleep(400);
  process.stdout.write(moveCursor(textRow + 5, 1));
  process.stdout.write(centerText(`${BOLD}${YELLOW}THAT WHICH IS,${RESET}`));
  await sleep(400);
  process.stdout.write(moveCursor(textRow + 6, 1));
  process.stdout.write(centerText(`${BOLD}${BRIGHT_YELLOW}AND THAT WHICH SHALL COME TO BE${RESET}`));

  // Show prompt
  const promptRowPhase3 = textRow + 8;
  process.stdout.write(moveCursor(promptRowPhase3, 1));
  process.stdout.write(centerText(`${CYAN}Press Enter to continue...${RESET}`));

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
