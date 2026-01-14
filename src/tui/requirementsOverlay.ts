/**
 * Requirements Overlay Module
 *
 * Handles the requirements file selection overlay displayed during the entrance sequence.
 * This overlay allows users to select a markdown requirements file (Scroll of Requirements)
 * using a fuzzy file picker.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Fzf } from 'fzf';
import type { Terminal } from 'terminal-kit';
import type { Sprite } from './sprite.js';
import { exitTerminal } from './terminal-cleanup.js';
import {
  CHAR_HEIGHT,
  extractTile,
  RESET,
  type RGB,
  renderTile,
  TILE,
  type Tileset,
} from './tileset.js';

// ============================================================================
// Types
// ============================================================================

export type OverlayMode = 'none' | 'prompt' | 'picker' | 'rat-transform';

export interface RequirementsOverlayState {
  overlay: OverlayMode;
  files: string[];
  filteredFiles: string[];
  searchQuery: string;
  selectedIndex: number;
  cursorPos: number;
  tilesDrawn: boolean;
}

export interface RequirementsOverlayDeps {
  term: Terminal;
  getTileset: () => Tileset | null;
  getLayout: () => LayoutInfo;
  drawTiles: () => void;
  onFileSelected: (path: string | null) => void;
  humanSprite: Sprite;
}

export interface LayoutInfo {
  tileArea: {
    x: number;
    y: number;
    width: number;
    height: number;
    fillerRowsAbove: number;
    fillerRowsBelow: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

// Dialogue box tile indices (for message panels)
const DIALOGUE_TILES = {
  TOP_LEFT: 38,
  TOP_RIGHT: 39,
  BOTTOM_LEFT: 48,
  BOTTOM_RIGHT: 49,
};

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a requirements overlay instance that handles the file selection UI.
 */
export function createRequirementsOverlay(deps: RequirementsOverlayDeps) {
  const { term, getTileset, getLayout, drawTiles, onFileSelected, humanSprite } = deps;

  // Internal state
  const state: RequirementsOverlayState = {
    overlay: 'none',
    files: [],
    filteredFiles: [],
    searchQuery: '',
    selectedIndex: 0,
    cursorPos: 0,
    tilesDrawn: false,
  };

  // ============================================================================
  // Helper Functions for Rendering
  // ============================================================================

  /**
   * Strip ANSI escape codes from a string to get visible length
   */
  function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /**
   * Create middle fill row for dialogue box (samples from left tile's middle column)
   */
  function createMiddleFill(leftTile: RGB[][], charRow: number): string {
    const pixelRowTop = charRow * 2;
    const pixelRowBot = pixelRowTop + 1;
    const sampleX = 8; // Middle column

    let result = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = leftTile[pixelRowTop][sampleX];
      const botPixel = leftTile[pixelRowBot]?.[sampleX] || topPixel;
      result += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      result += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      result += '\u2584';
    }
    result += RESET;
    return result;
  }

  /**
   * Wrap text with consistent background color
   */
  function wrapTextWithBg(text: string, bgColor: string): string {
    const bgMaintained = text.replace(/\x1b\[0m/g, `\x1b[0m${bgColor}`);
    return bgColor + bgMaintained + RESET;
  }

  /**
   * Create middle row border segments for panels taller than 2 tiles.
   */
  function createMiddleRowBorders(
    tileset: Tileset,
    charRow: number,
  ): { left: string; fill: string; right: string } {
    const topLeftTile = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
    const topRightTile = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);

    const actualCharRow = charRow % 4;
    const pixelRowTop = 8 + actualCharRow * 2;
    const pixelRowBot = pixelRowTop + 1;

    let left = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = topLeftTile[pixelRowTop][x];
      const botPixel = topLeftTile[pixelRowBot]?.[x] || topPixel;
      left += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      left += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      left += '\u2584';
    }
    left += RESET;

    let right = '';
    for (let x = 0; x < 16; x++) {
      const topPixel = topRightTile[pixelRowTop][x];
      const botPixel = topRightTile[pixelRowBot]?.[x] || topPixel;
      right += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      right += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      right += '\u2584';
    }
    right += RESET;

    const sampleX = 8;
    const topPixel = topLeftTile[pixelRowTop][sampleX];
    const botPixel = topLeftTile[pixelRowBot]?.[sampleX] || topPixel;
    let fill = '';
    for (let x = 0; x < 16; x++) {
      fill += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
      fill += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
      fill += '\u2584';
    }
    fill += RESET;

    return { left, fill, right };
  }

  /**
   * Render a tile-bordered message panel with customizable dimensions.
   */
  function renderMessagePanel(
    tileset: Tileset,
    textLines: string[],
    widthTiles: number = 5,
    heightTiles: number = 2,
  ): string[] {
    const topLeft = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
    const topRight = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);
    const bottomLeft = extractTile(tileset, DIALOGUE_TILES.BOTTOM_LEFT);
    const bottomRight = extractTile(tileset, DIALOGUE_TILES.BOTTOM_RIGHT);

    const tlRendered = renderTile(topLeft);
    const trRendered = renderTile(topRight);
    const blRendered = renderTile(bottomLeft);
    const brRendered = renderTile(bottomRight);

    const middleTopRendered: string[] = [];
    const middleBottomRendered: string[] = [];
    for (let row = 0; row < CHAR_HEIGHT; row++) {
      middleTopRendered.push(createMiddleFill(topLeft, row));
      middleBottomRendered.push(createMiddleFill(bottomLeft, row));
    }

    const middleRowBorders: { left: string; fill: string; right: string }[] = [];
    for (let row = 0; row < CHAR_HEIGHT; row++) {
      middleRowBorders.push(createMiddleRowBorders(tileset, row));
    }

    const middleTiles = Math.max(0, widthTiles - 2);
    const interiorWidth = middleTiles * 16;
    const middleRows = Math.max(0, heightTiles - 2);

    const bgSamplePixel = topLeft[8][8];
    const textBgColor = `\x1b[48;2;${bgSamplePixel.r};${bgSamplePixel.g};${bgSamplePixel.b}m`;

    const boxLines: string[] = [];

    // Top row of tiles
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = tlRendered[charRow];
      for (let m = 0; m < middleTiles; m++) {
        line += middleTopRendered[charRow];
      }
      line += trRendered[charRow];
      boxLines.push(line);
    }

    // Middle rows of tiles (for height > 2)
    for (let middleRowIdx = 0; middleRowIdx < middleRows; middleRowIdx++) {
      for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
        const borders = middleRowBorders[charRow];
        let line = borders.left;
        for (let m = 0; m < middleTiles; m++) {
          line += borders.fill;
        }
        line += borders.right;
        boxLines.push(line);
      }
    }

    // Bottom row of tiles
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = blRendered[charRow];
      for (let m = 0; m < middleTiles; m++) {
        line += middleBottomRendered[charRow];
      }
      line += brRendered[charRow];
      boxLines.push(line);
    }

    // Center text in the interior area
    const boxHeight = CHAR_HEIGHT * heightTiles;

    let interiorStartRow: number;
    let interiorEndRow: number;

    if (heightTiles <= 2) {
      interiorStartRow = 2;
      interiorEndRow = boxHeight - 3;
    } else {
      interiorStartRow = 2;
      interiorEndRow = boxHeight - 3;
    }

    const interiorHeight = interiorEndRow - interiorStartRow + 1;
    const textStartOffset = interiorStartRow + Math.floor((interiorHeight - textLines.length) / 2);

    for (let i = 0; i < textLines.length; i++) {
      const boxLineIndex = textStartOffset + i;
      if (
        boxLineIndex >= interiorStartRow &&
        boxLineIndex <= interiorEndRow &&
        boxLineIndex < boxLines.length
      ) {
        let line = textLines[i];
        let visibleLength = stripAnsi(line).length;

        if (visibleLength > interiorWidth) {
          let truncated = '';
          let truncatedVisible = 0;
          const maxLen = interiorWidth - 3;
          for (let c = 0; c < line.length && truncatedVisible < maxLen; c++) {
            truncated += line[c];
            const newVisibleLen = stripAnsi(truncated).length;
            truncatedVisible = newVisibleLen;
          }
          line = `${truncated}...`;
          visibleLength = stripAnsi(line).length;
        }

        const padding = Math.max(0, Math.floor((interiorWidth - visibleLength) / 2));
        const rightPadding = Math.max(0, interiorWidth - padding - visibleLength);
        const textContent = ' '.repeat(padding) + line + ' '.repeat(rightPadding);
        const textWithBg = wrapTextWithBg(textContent, textBgColor);

        const tileRowIdx = Math.floor(boxLineIndex / CHAR_HEIGHT);
        const charRow = boxLineIndex % CHAR_HEIGHT;

        let leftBorder: string;
        let rightBorder: string;
        if (tileRowIdx === 0) {
          leftBorder = tlRendered[charRow];
          rightBorder = trRendered[charRow];
        } else if (tileRowIdx === heightTiles - 1) {
          leftBorder = blRendered[charRow];
          rightBorder = brRendered[charRow];
        } else {
          const borders = middleRowBorders[charRow];
          leftBorder = borders.left;
          rightBorder = borders.right;
        }

        boxLines[boxLineIndex] = leftBorder + textWithBg + rightBorder;
      }
    }

    return boxLines;
  }

  // ============================================================================
  // Drawing Functions
  // ============================================================================

  /**
   * Draw the requirements overlay based on current state
   */
  function draw(): void {
    const tileset = getTileset();
    if (!tileset) return;

    // Draw the scene (left side) only if not already drawn - avoids flicker on keystroke
    if (!state.tilesDrawn) {
      drawTiles();
      state.tilesDrawn = true;
    }

    let panelLines: string[] = [];
    let panelWidth = 6; // tiles

    switch (state.overlay) {
      case 'prompt':
        panelLines = renderMessagePanel(
          tileset,
          [
            '\x1b[97mDo you bring a Scroll of Requirements?\x1b[0m',
            '\x1b[90m(a detailed markdown file describing your task)\x1b[0m',
            '',
            '\x1b[90mThe Arbiter rewards those who come prepared.\x1b[0m',
            '\x1b[90mScrolls contain context, specs, and acceptance criteria.\x1b[0m',
            '',
            "\x1b[92m[Y]\x1b[0m Yes, I have a .md file    \x1b[91m[N]\x1b[0m No, I'll wing it",
          ],
          panelWidth,
        );
        break;

      case 'picker': {
        const beforeCursor = state.searchQuery.slice(0, state.cursorPos);
        const afterCursor = state.searchQuery.slice(state.cursorPos);
        const inputLineWithCursor = `\x1b[90m> ${beforeCursor}\x1b[97m_\x1b[90m${afterCursor}\x1b[0m`;

        const displayLines: string[] = [
          '\x1b[97mSelect your Scroll of Requirements:\x1b[0m',
          '\x1b[90m(markdown files in your project)\x1b[0m',
          '',
          inputLineWithCursor,
          '',
        ];

        const files = state.filteredFiles.length > 0 ? state.filteredFiles : state.files;
        const maxVisible = 16;
        const startIdx = Math.max(0, state.selectedIndex - Math.floor(maxVisible / 2));
        const visibleFiles = files.slice(startIdx, startIdx + maxVisible);

        visibleFiles.forEach((file, i) => {
          const actualIdx = startIdx + i;
          const isSelected = actualIdx === state.selectedIndex;
          const prefix = isSelected ? '\x1b[93m> ' : '  ';
          const suffix = isSelected ? '\x1b[0m' : '';
          displayLines.push(`${prefix}${file}${suffix}`);
        });

        if (files.length === 0) {
          displayLines.push('\x1b[90m(no .md files found - the scroll rack is empty)\x1b[0m');
        }

        displayLines.push('');
        displayLines.push('\x1b[90mArrow keys navigate  Enter select  Esc to flee\x1b[0m');

        panelWidth = 7;
        panelLines = renderMessagePanel(tileset, displayLines, panelWidth, 3);
        break;
      }

      case 'rat-transform':
        panelLines = renderMessagePanel(
          tileset,
          [
            '\x1b[91mYou have been transformed into a rat.\x1b[0m',
            '\x1b[90m(the Arbiter does not suffer the unprepared)\x1b[0m',
            '',
            '\x1b[90mCome back with a requirements.md or similar.\x1b[0m',
            '',
            '\x1b[90mPress any key to scurry away...\x1b[0m',
          ],
          5,
        );
        break;

      default:
        return;
    }

    // Position the panel within the SCENE area only
    const layout = getLayout();
    const sceneWidthChars = 7 * 16; // 112
    const sceneHeightChars = 6 * 8; // 48

    const panelWidthChars = panelWidth * 16;
    const panelHeight = panelLines.length;

    // Center horizontally within the scene
    const panelX = Math.max(1, Math.floor((sceneWidthChars - panelWidthChars) / 2));

    let panelY: number;
    let finalPanelX = panelX;
    if (state.overlay === 'rat-transform') {
      // Position at bottom of scene with small margin
      panelY = layout.tileArea.y + sceneHeightChars - panelHeight - 2;
      finalPanelX = panelX + 16;
    } else {
      // Center vertically within the scene area (add tileArea.y offset for terminal coordinates)
      panelY = layout.tileArea.y + Math.floor((sceneHeightChars - panelHeight) / 2);
    }

    // Draw panel
    for (let i = 0; i < panelLines.length; i++) {
      term.moveTo(finalPanelX, panelY + i);
      process.stdout.write(panelLines[i] + RESET);
    }
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Load files for the picker using recursive directory walk
   */
  function loadFiles(): void {
    const files: string[] = [];

    function walkDir(dir: string, prefix: string = ''): void {
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules') continue;
          const fullPath = path.join(dir, entry);
          const relativePath = prefix ? `${prefix}/${entry}` : entry;
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              walkDir(fullPath, relativePath);
            } else if (entry.endsWith('.md')) {
              files.push(relativePath);
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    walkDir(process.cwd());
    state.files = files;
    state.filteredFiles = files;
  }

  /**
   * Filter files using fzf algorithm
   */
  function filterFiles(): void {
    if (!state.searchQuery) {
      state.filteredFiles = state.files;
      state.selectedIndex = 0;
      return;
    }

    const fzf = new Fzf(state.files);
    const results = fzf.find(state.searchQuery);
    state.filteredFiles = results.map((r: { item: string }) => r.item);
    state.selectedIndex = 0;
  }

  // ============================================================================
  // Key Handler
  // ============================================================================

  /**
   * Handle key events for the requirements overlay
   * @returns true if the key was handled, false otherwise
   */
  function handleKey(key: string): boolean {
    if (state.overlay === 'none') return false;

    switch (state.overlay) {
      case 'prompt':
        if (key === 'y' || key === 'Y') {
          loadFiles();
          state.overlay = 'picker';
          draw();
          return true;
        } else if (key === 'n' || key === 'N') {
          // Rat transformation using sprite animation
          (async () => {
            // Transform human to smoke
            await humanSprite.magicTransform(TILE.SMOKE);
            state.tilesDrawn = false;
            drawTiles();
            state.tilesDrawn = true;

            // Hold smoke for a bit longer
            await new Promise((r) => setTimeout(r, 1100));

            // Transform smoke to rat
            await humanSprite.magicTransform(210); // Rat tile
            state.overlay = 'rat-transform';
            state.tilesDrawn = false;
            draw();
          })();
          return true;
        }
        break;

      case 'picker':
        if (key === 'UP') {
          state.selectedIndex = Math.max(0, state.selectedIndex - 1);
          draw();
          return true;
        } else if (key === 'DOWN') {
          const files = state.filteredFiles.length > 0 ? state.filteredFiles : state.files;
          state.selectedIndex = Math.min(files.length - 1, state.selectedIndex + 1);
          draw();
          return true;
        } else if (key === 'LEFT') {
          state.cursorPos = Math.max(0, state.cursorPos - 1);
          draw();
          return true;
        } else if (key === 'RIGHT') {
          state.cursorPos = Math.min(state.searchQuery.length, state.cursorPos + 1);
          draw();
          return true;
        } else if (key === 'ENTER') {
          const files = state.filteredFiles.length > 0 ? state.filteredFiles : state.files;
          if (files.length > 0) {
            const selectedFile = files[state.selectedIndex];
            selectFile(selectedFile);
          }
          return true;
        } else if (key === 'ESCAPE') {
          state.overlay = 'prompt';
          state.searchQuery = '';
          state.selectedIndex = 0;
          state.cursorPos = 0;
          state.tilesDrawn = false;
          draw();
          return true;
        } else if (key === 'BACKSPACE') {
          if (state.cursorPos > 0) {
            state.searchQuery =
              state.searchQuery.slice(0, state.cursorPos - 1) +
              state.searchQuery.slice(state.cursorPos);
            state.cursorPos--;
            filterFiles();
            draw();
          }
          return true;
        } else if (key.length === 1 && key.match(/[a-zA-Z0-9._\-/]/)) {
          state.searchQuery =
            state.searchQuery.slice(0, state.cursorPos) +
            key +
            state.searchQuery.slice(state.cursorPos);
          state.cursorPos++;
          filterFiles();
          draw();
          return true;
        }
        break;

      case 'rat-transform':
        // Any key exits - clean up properly
        exitTerminal();
        process.exit(0);
    }

    return false;
  }

  /**
   * Select a requirements file and close overlay
   */
  function selectFile(filePath: string): void {
    state.overlay = 'none';
    state.tilesDrawn = false;
    onFileSelected(filePath);
  }

  // ============================================================================
  // Public Interface
  // ============================================================================

  return {
    /** Draw the overlay */
    draw,

    /** Handle a key event. Returns true if handled. */
    handleKey,

    /** Load markdown files for the picker */
    loadFiles,

    /** Show the initial prompt */
    show(): void {
      loadFiles();
      state.overlay = 'prompt';
      draw();
    },

    /** Hide the overlay */
    hide(): void {
      state.overlay = 'none';
      state.tilesDrawn = false;
    },

    /** Get current state (for debugging) */
    getState(): RequirementsOverlayState {
      return { ...state };
    },

    /** Check if overlay is currently active */
    isActive(): boolean {
      return state.overlay !== 'none';
    },

    /** Get current overlay mode */
    getOverlayMode(): OverlayMode {
      return state.overlay;
    },

    /** Set overlay mode directly */
    setOverlayMode(mode: OverlayMode): void {
      state.overlay = mode;
    },

    /** Reset tiles drawn flag (for forcing redraw after external changes) */
    resetTilesDrawn(): void {
      state.tilesDrawn = false;
    },
  };
}

export type RequirementsOverlay = ReturnType<typeof createRequirementsOverlay>;
