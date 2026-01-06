/**
 * Character Selection Screen (terminal-kit version)
 *
 * Displays 8 human character tiles for the user to choose from.
 * Uses arrow keys for selection and Enter to confirm.
 * Uses terminal-kit with Strategy 5 (minimal redraws) for flicker-free rendering.
 */

import termKit from 'terminal-kit';
import {
  Tileset,
  TILE,
  TILE_SIZE,
  CHAR_HEIGHT,
  RESET,
  loadTileset,
  extractTile,
  compositeTiles,
  compositeWithFocus,
  renderTile,
} from '../tileset.js';

const term = termKit.terminal;

// ============================================================================
// Constants
// ============================================================================

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

// Creative wizard names for each character
const WIZARD_NAMES = [
  'Wizard of Fire',
  'Wizard of Ice',
  'Wizard of Earth',
  'Wizard of Wind',
  'Wizard of Light',
  'Wizard of Shadow',
  'Wizard of Storm',
  'Wizard of Stars',
];

// Layout constants
const TILE_SPACING = 2; // Space between tiles (characters)
const TILE_DISPLAY_WIDTH = TILE_SIZE; // 16 chars per tile

// ANSI codes
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// ============================================================================
// Rendering Functions
// ============================================================================

/**
 * Render all character tiles as an array of ANSI strings (one per row).
 * Characters are displayed in a horizontal row with the selected one highlighted.
 */
function renderCharacterRow(
  tileset: Tileset,
  selectedIndex: number
): string[] {
  // Extract grass and focus tiles
  const grassTile = extractTile(tileset, TILE.GRASS);
  const focusTile = extractTile(tileset, TILE.FOCUS);

  // Extract and render each character tile
  const renderedTiles: string[][] = [];
  for (let i = 0; i < CHARACTER_TILES.length; i++) {
    let charPixels = extractTile(tileset, CHARACTER_TILES[i]);
    // Composite character on grass background (tiles >= 80 need grass background)
    charPixels = compositeTiles(charPixels, grassTile, 1);

    // Apply focus overlay to selected character
    if (i === selectedIndex) {
      charPixels = compositeWithFocus(charPixels, focusTile);
    }

    renderedTiles.push(renderTile(charPixels));
  }

  // Build output: combine all tiles horizontally for each row
  const spacing = ' '.repeat(TILE_SPACING);
  const lines: string[] = [];

  for (let row = 0; row < CHAR_HEIGHT; row++) {
    let line = '';
    for (let charIdx = 0; charIdx < renderedTiles.length; charIdx++) {
      line += renderedTiles[charIdx][row];
      if (charIdx < renderedTiles.length - 1) {
        line += spacing;
      }
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Render the selection indicator row (arrows below selected character).
 */
function renderIndicatorRow(selectedIndex: number): string {
  const parts: string[] = [];

  for (let i = 0; i < CHARACTER_TILES.length; i++) {
    if (i === selectedIndex) {
      // Highlighted arrow indicator (centered under tile)
      parts.push(`${BOLD}${YELLOW}      ^^^       ${RESET}`);
    } else {
      parts.push(' '.repeat(TILE_DISPLAY_WIDTH));
    }
    if (i < CHARACTER_TILES.length - 1) {
      parts.push(' '.repeat(TILE_SPACING));
    }
  }

  return parts.join('');
}

/**
 * Calculate the total width of the character row in characters.
 */
function getRowWidth(): number {
  return (
    CHARACTER_TILES.length * TILE_DISPLAY_WIDTH +
    (CHARACTER_TILES.length - 1) * TILE_SPACING
  );
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Shows the character selection screen using terminal-kit with Strategy 5 (minimal redraws).
 *
 * @returns Promise<number> - The selected tile index (190-197)
 */
export async function showCharacterSelect(): Promise<number> {
  return new Promise(async (resolve) => {
    // Load tileset
    const tileset = await loadTileset();

    // Initialize terminal
    term.fullscreen(true);
    term.hideCursor();
    term.grabInput({ mouse: 'button' });

    // State
    let selectedIndex = 0;
    let lastSelectedIndex = -1; // For change detection

    // Get terminal dimensions
    let width = 180;
    let height = 50;
    if (typeof term.width === 'number' && isFinite(term.width) && term.width > 0) {
      width = term.width;
    }
    if (typeof term.height === 'number' && isFinite(term.height) && term.height > 0) {
      height = term.height;
    }

    // Calculate centering offsets
    const rowWidth = getRowWidth();
    const contentHeight = CHAR_HEIGHT + 8; // tiles + title + indicator + name + instructions
    const startX = Math.max(1, Math.floor((width - rowWidth) / 2));
    const startY = Math.max(1, Math.floor((height - contentHeight) / 2));

    /**
     * Draw the screen (only if selection changed)
     */
    function drawScreen() {
      if (selectedIndex === lastSelectedIndex) return;
      lastSelectedIndex = selectedIndex;

      // Clear screen on first draw
      if (lastSelectedIndex === -1) {
        term.clear();
      }

      // Title lines
      const title1 = 'Your journey to the Arbiter begins.';
      const title2 = 'Choose wisely—the forest does not forgive those who stray.';

      // Title 1 (yellow)
      term.moveTo(Math.max(1, Math.floor((width - title1.length) / 2)), startY);
      process.stdout.write(`${BOLD}${YELLOW}${title1}${RESET}`);

      // Title 2 (yellow)
      term.moveTo(Math.max(1, Math.floor((width - title2.length) / 2)), startY + 1);
      process.stdout.write(`${BOLD}${YELLOW}${title2}${RESET}`);

      // Render character tiles
      const characterLines = renderCharacterRow(tileset, selectedIndex);
      const tilesStartY = startY + 3;

      for (let i = 0; i < characterLines.length; i++) {
        term.moveTo(startX, tilesStartY + i);
        process.stdout.write(characterLines[i] + RESET);
      }

      // Selection indicator
      const indicatorY = tilesStartY + CHAR_HEIGHT;
      term.moveTo(startX, indicatorY);
      process.stdout.write(renderIndicatorRow(selectedIndex));

      // Wizard name (centered)
      const nameY = indicatorY + 1;
      const wizardName = WIZARD_NAMES[selectedIndex];
      // Clear the line first to remove previous name
      term.moveTo(1, nameY);
      process.stdout.write(' '.repeat(width));
      term.moveTo(Math.max(1, Math.floor((width - wizardName.length) / 2)), nameY);
      process.stdout.write(`${BOLD}${CYAN}${wizardName}${RESET}`);

      // Instructions at bottom
      const instructionY = nameY + 2;
      const instructions = '[LEFT/RIGHT or H/L] Navigate   [ENTER] Select   [Q or Ctrl+C] Exit';
      term.moveTo(Math.max(1, Math.floor((width - instructions.length) / 2)), instructionY);
      process.stdout.write(`${DIM}${instructions}${RESET}`);
    }

    /**
     * Cleanup and restore terminal
     */
    function cleanup() {
      term.removeAllListeners('key');
      term.grabInput(false);
      term.fullscreen(false);
      term.hideCursor(false);
    }

    // Initial draw
    term.clear();
    drawScreen();

    // Handle keyboard input
    term.on('key', (key: string) => {
      // Navigation
      if (key === 'LEFT' || key === 'h') {
        // Move selection left (wrap around)
        selectedIndex = (selectedIndex - 1 + CHARACTER_TILES.length) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'RIGHT' || key === 'l') {
        // Move selection right (wrap around)
        selectedIndex = (selectedIndex + 1) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'UP' || key === 'k') {
        // Up moves to previous row (4 characters per row for grid layout)
        selectedIndex = (selectedIndex - 4 + CHARACTER_TILES.length) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'DOWN' || key === 'j') {
        // Down moves to next row (4 characters per row for grid layout)
        selectedIndex = (selectedIndex + 4) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'ENTER') {
        // Confirm selection
        cleanup();
        resolve(CHARACTER_TILES[selectedIndex]);
      } else if (key === 'q' || key === 'CTRL_C' || key === 'CTRL_Z') {
        // Exit application
        cleanup();
        process.exit(0);
      }
    });
  });
}

export default showCharacterSelect;
