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
import { playSfx } from '../../sound.js';

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

// Character names for each sprite
const CHARACTER_NAMES = [
  'Adventurer',
  'Rogue',
  'Ranger',
  'Swordsman',
  'Dwarf',
  'Knight',
  'Shadow',
  'Wizard',
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
 * Character tiles are rendered with transparency preserved (no background compositing).
 */
function renderCharacterRow(
  tileset: Tileset,
  selectedIndex: number
): string[] {
  // Extract focus tile
  const focusTile = extractTile(tileset, TILE.FOCUS);

  // Extract grass tile for background
  const grassTile = extractTile(tileset, TILE.GRASS);

  // Extract and render each character tile
  const renderedTiles: string[][] = [];
  for (let i = 0; i < CHARACTER_TILES.length; i++) {
    let charPixels = extractTile(tileset, CHARACTER_TILES[i]);

    // Composite character on grass background
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
export interface CharacterSelectResult {
  character: number;
  skipIntro: boolean;
}

export async function showCharacterSelect(): Promise<CharacterSelectResult> {
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
      const title2 = 'Choose wisely. The forest does not forgive the undiscerning.';

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

      // Character name (centered below tiles, with padding)
      const nameY = tilesStartY + CHAR_HEIGHT + 2;
      const characterName = CHARACTER_NAMES[selectedIndex];
      // Clear the line first to remove previous name
      term.moveTo(1, nameY);
      process.stdout.write(' '.repeat(width));
      term.moveTo(Math.max(1, Math.floor((width - characterName.length) / 2)), nameY);
      process.stdout.write(`${BOLD}${CYAN}${characterName}${RESET}`);

      // Instructions at bottom
      const instructionY = nameY + 2;
      const instructions = '[LEFT/RIGHT or H/L] Navigate   [ENTER] Select   [SPACE] Skip intro   [Q] Exit';
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
        playSfx('menuLeft');
        // Move selection left (wrap around)
        selectedIndex = (selectedIndex - 1 + CHARACTER_TILES.length) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'RIGHT' || key === 'l') {
        playSfx('menuRight');
        // Move selection right (wrap around)
        selectedIndex = (selectedIndex + 1) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'UP' || key === 'k') {
        playSfx('menuLeft');
        // Up moves to previous row (4 characters per row for grid layout)
        selectedIndex = (selectedIndex - 4 + CHARACTER_TILES.length) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'DOWN' || key === 'j') {
        playSfx('menuRight');
        // Down moves to next row (4 characters per row for grid layout)
        selectedIndex = (selectedIndex + 4) % CHARACTER_TILES.length;
        drawScreen();
      } else if (key === 'ENTER') {
        playSfx('menuSelect');
        // Confirm selection, go to path intro
        cleanup();
        resolve({ character: CHARACTER_TILES[selectedIndex], skipIntro: false });
      } else if (key === ' ') {
        playSfx('menuSelect');
        // Skip intro, go straight to arbiter
        cleanup();
        resolve({ character: CHARACTER_TILES[selectedIndex], skipIntro: true });
      } else if (key === 'q' || key === 'CTRL_C' || key === 'CTRL_Z') {
        // Exit application
        cleanup();
        process.exit(0);
      }
    });
  });
}

export default showCharacterSelect;
