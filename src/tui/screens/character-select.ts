/**
 * Character Selection Screen
 *
 * Displays 8 human character tiles for the user to choose from.
 * Uses arrow keys for selection and Enter to confirm.
 */

import {
  Tileset,
  loadTileset,
  extractTile,
  compositeWithFocus,
  compositeTiles,
  renderTile,
  TILE,
  TILE_SIZE,
  CHAR_HEIGHT,
  RESET,
  CLEAR_SCREEN,
  CURSOR_HOME,
  HIDE_CURSOR,
  SHOW_CURSOR,
  RGB,
} from '../tileset.js';

// Human character tile indices (190-197)
const CHARACTER_TILES = [
  TILE.HUMAN_1,
  TILE.HUMAN_2,
  TILE.HUMAN_3,
  TILE.HUMAN_4,
  TILE.HUMAN_5,
  TILE.HUMAN_6,
  TILE.HUMAN_7,
  TILE.HUMAN_8,
];

// Arrow key escape sequences
const KEY_LEFT = '\u001b[D';
const KEY_RIGHT = '\u001b[C';
const KEY_ENTER = '\r';
const KEY_ENTER_ALT = '\n';
const KEY_CTRL_C = '\u0003';

/**
 * Move cursor to a specific position
 */
function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

/**
 * Render the title at the top of the screen
 */
function renderTitle(): void {
  const title = 'Choose Your Character';
  // Center the title (assuming ~80 col terminal, adjust as needed)
  const padding = Math.max(0, Math.floor((80 - title.length) / 2));
  process.stdout.write(moveCursor(2, padding + 1));
  process.stdout.write(`\x1b[1;36m${title}\x1b[0m`); // Bold cyan
}

/**
 * Render all 8 character tiles horizontally with focus on selected
 */
function renderCharacters(
  tileset: Tileset,
  selectedIndex: number,
  focusTile: RGB[][],
  grassTile: RGB[][]
): void {
  // Extract all character tiles and composite on grass
  const charTiles = CHARACTER_TILES.map((index) => {
    let charPixels = extractTile(tileset, index);
    // Composite character on grass background (tiles >= 80 need grass background)
    charPixels = compositeTiles(charPixels, grassTile, 1);
    return charPixels;
  });

  // Render each tile - 8 tiles, each 16 chars wide
  // Starting row for characters (after title)
  const startRow = 5;
  const startCol = 5; // Left margin

  // Build the output for each row of pixels
  for (let row = 0; row < CHAR_HEIGHT; row++) {
    process.stdout.write(moveCursor(startRow + row, startCol));

    for (let charIdx = 0; charIdx < charTiles.length; charIdx++) {
      let tile = charTiles[charIdx];

      // Apply focus overlay to selected character
      if (charIdx === selectedIndex) {
        tile = compositeWithFocus(tile, focusTile);
      }

      // Render this tile's row
      const rendered = renderTile(tile);
      process.stdout.write(rendered[row]);

      // Add spacing between characters
      process.stdout.write('  ');
    }
  }

  // Render selection indicator below characters
  const indicatorRow = startRow + CHAR_HEIGHT + 1;
  for (let charIdx = 0; charIdx < CHARACTER_TILES.length; charIdx++) {
    const col = startCol + charIdx * (TILE_SIZE + 2); // 16 chars + 2 spacing
    process.stdout.write(moveCursor(indicatorRow, col));

    if (charIdx === selectedIndex) {
      // Highlight selected with arrow
      process.stdout.write(`\x1b[1;33m   ^^^   \x1b[0m`);
    } else {
      process.stdout.write('         ');
    }
  }

  // Instructions
  const instructionRow = indicatorRow + 2;
  process.stdout.write(moveCursor(instructionRow, startCol));
  process.stdout.write('\x1b[90mUse LEFT/RIGHT arrows to select, ENTER to confirm, Ctrl+C to exit\x1b[0m');
}

/**
 * Show the character selection screen and return the selected tile index
 *
 * @returns Promise<number> - The selected tile index (190-197)
 */
export async function showCharacterSelect(): Promise<number> {
  // Load tileset
  const tileset = await loadTileset();
  const focusTile = extractTile(tileset, TILE.FOCUS);
  const grassTile = extractTile(tileset, TILE.GRASS);

  let selectedIndex = 0;

  // Setup terminal
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(CURSOR_HOME);
  process.stdout.write(HIDE_CURSOR);

  // Initial render
  renderTitle();
  renderCharacters(tileset, selectedIndex, focusTile, grassTile);

  // Setup raw mode for key input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  return new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', handleKey);
      process.stdout.write(SHOW_CURSOR);
      process.stdout.write(CLEAR_SCREEN);
      process.stdout.write(CURSOR_HOME);
    };

    const handleKey = (key: string) => {
      if (key === KEY_CTRL_C) {
        cleanup();
        process.exit(0);
      } else if (key === KEY_LEFT) {
        // Move selection left (wrap around)
        selectedIndex = (selectedIndex - 1 + CHARACTER_TILES.length) % CHARACTER_TILES.length;
        renderCharacters(tileset, selectedIndex, focusTile, grassTile);
      } else if (key === KEY_RIGHT) {
        // Move selection right (wrap around)
        selectedIndex = (selectedIndex + 1) % CHARACTER_TILES.length;
        renderCharacters(tileset, selectedIndex, focusTile, grassTile);
      } else if (key === KEY_ENTER || key === KEY_ENTER_ALT) {
        cleanup();
        resolve(CHARACTER_TILES[selectedIndex]);
      }
    };

    process.stdin.on('data', handleKey);
  });
}

// Allow running directly for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  showCharacterSelect()
    .then((selected) => {
      console.log(`Selected character tile: ${selected}`);
    })
    .catch((err) => {
      console.error('Error:', err);
      process.exit(1);
    });
}
