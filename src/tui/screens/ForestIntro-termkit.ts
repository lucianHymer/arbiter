/**
 * Forest Intro Screen (terminal-kit version)
 *
 * A narrative intro screen between character select and main TUI.
 * Player controls their character with arrow keys to walk through the forest.
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
  renderTile,
  RGB,
} from '../tileset.js';

const term = termKit.terminal;

// ============================================================================
// Constants
// ============================================================================

// Scene dimensions: 7 tiles wide x 5 tiles tall
const SCENE_WIDTH_TILES = 7;
const SCENE_HEIGHT_TILES = 5;
const SCENE_WIDTH_CHARS = SCENE_WIDTH_TILES * TILE_SIZE; // 112 chars
const SCENE_HEIGHT_CHARS = SCENE_HEIGHT_TILES * CHAR_HEIGHT; // 40 rows

// ANSI codes
const BOLD = '\x1b[1m';
const WHITE = '\x1b[97m';
const DIM = '\x1b[2m';

// True color theme colors (RGB)
const COLOR_ARBITER = '\x1b[38;2;100;255;100m'; // Green for THE ARBITER
const COLOR_WAS = '\x1b[38;2;100;200;255m'; // Blue-cyan for "WAS"
const COLOR_IS = '\x1b[38;2;200;100;255m'; // Purple for "IS"
const COLOR_DEATH = '\x1b[38;2;180;50;50m'; // Red for death messages

// Dialogue box tile indices (2x2 tile message window)
const DIALOGUE_TILES = {
  TOP_LEFT: 38,
  TOP_RIGHT: 39,
  BOTTOM_LEFT: 48,
  BOTTOM_RIGHT: 49,
};

// Death screen tile indices
const DEATH_TILES = {
  GRAVESTONE: 60,
  SKELETON: 61,
};

// Starting position - left side of path
const START_X = 0;
const START_Y = 2; // Path row

// Sign position
const SIGN_X = 5;
const SIGN_Y = 1;

// ============================================================================
// Types
// ============================================================================

type Phase = 'walking' | 'dead';

/**
 * State for minimal redraws
 */
interface ForestState {
  playerX: number;
  playerY: number;
  phase: Phase;
  hasSeenSign: boolean;
}

/**
 * Tracker for change detection
 */
interface ChangeTracker {
  lastPlayerX: number;
  lastPlayerY: number;
  lastPhase: Phase;
  lastShowMessage: boolean;
}

// ============================================================================
// Collision System
// ============================================================================

/**
 * Tile type constants for collision detection
 */
const TILE_TYPE = {
  WALKABLE: 0,
  BLOCKED: 1,
  SIGN: 2,
  EXIT: 3,
};

/**
 * Create a collision map for the forest scene
 */
function createCollisionMap(): number[][] {
  const map: number[][] = [];

  for (let row = 0; row < SCENE_HEIGHT_TILES; row++) {
    const mapRow: number[] = [];
    for (let col = 0; col < SCENE_WIDTH_TILES; col++) {
      let tileType = TILE_TYPE.WALKABLE;

      // Left edge trees (except path row) - blocked
      if (col === 0 && row !== 2) {
        tileType = TILE_TYPE.BLOCKED;
      }

      // Right edge trees (except path row) - blocked
      if (col === 6 && row !== 2) {
        tileType = TILE_TYPE.BLOCKED;
      }

      // Top row: trees are blocked
      if (row === 0) {
        if (col === 0 || col === 1 || col === 5 || col === 6) tileType = TILE_TYPE.BLOCKED;
        if (col === 2 || col === 4) tileType = TILE_TYPE.BLOCKED;
      }

      // Bottom row: trees are blocked
      if (row === 4) {
        if (col === 0 || col === 6) tileType = TILE_TYPE.BLOCKED;
        if (col === 1 || col === 5) tileType = TILE_TYPE.BLOCKED;
      }

      // Row 1: trees on edges, sign at col 5
      if (row === 1) {
        if (col === 0 || col === 6) tileType = TILE_TYPE.BLOCKED;
        if (col === 5) tileType = TILE_TYPE.SIGN;
      }

      // Row 3: trees on edges
      if (row === 3) {
        if (col === 0 || col === 6) tileType = TILE_TYPE.BLOCKED;
      }

      // No exit tiles - player must walk off screen to right
      // (formerly: Exit point at right edge of path (row 2, col 6))

      mapRow.push(tileType);
    }
    map.push(mapRow);
  }

  return map;
}

// Pre-compute the collision map
const COLLISION_MAP = createCollisionMap();

/**
 * Check if a tile position is walkable
 */
function isWalkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= SCENE_WIDTH_TILES || y >= SCENE_HEIGHT_TILES) {
    return false;
  }
  const tileType = COLLISION_MAP[y][x];
  return tileType !== TILE_TYPE.BLOCKED;
}

/**
 * Check if position is off the screen (death zone)
 */
function isOffScreen(x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= SCENE_WIDTH_TILES || y >= SCENE_HEIGHT_TILES;
}

/**
 * Check if position is the exit (no longer used - exit is now off-screen)
 */
function isExit(x: number, y: number): boolean {
  // Exit is now when player walks off-screen to the right on path row
  // This function kept for compatibility but always returns false
  return false;
}

/**
 * Check if player is next to the sign (below or left of it)
 */
function isNextToSign(x: number, y: number): boolean {
  // Below sign: (5, 2)
  if (x === SIGN_X && y === SIGN_Y + 1) return true;
  // Left of sign: (4, 1)
  if (x === SIGN_X - 1 && y === SIGN_Y) return true;
  return false;
}

// ============================================================================
// Rendering Functions
// ============================================================================

/**
 * Apply rainbow colors to text
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

/**
 * Strip ANSI escape codes from a string to get visible length
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Create the forest scene layout
 */
function createForestScene(characterTile: number, playerX: number, playerY: number): number[][] {
  const scene: number[][] = [];

  for (let row = 0; row < SCENE_HEIGHT_TILES; row++) {
    const sceneRow: number[] = [];
    for (let col = 0; col < SCENE_WIDTH_TILES; col++) {
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

      // Middle path row (row 2) - sparse grass for path ALL THE WAY THROUGH
      if (row === 2) {
        tile = TILE.GRASS_SPARSE;
      }

      // Place character at player position
      if (
        row === playerY &&
        col === playerX &&
        playerX >= 0 &&
        playerX < SCENE_WIDTH_TILES &&
        playerY >= 0 &&
        playerY < SCENE_HEIGHT_TILES
      ) {
        tile = characterTile;
      }

      sceneRow.push(tile);
    }
    scene.push(sceneRow);
  }

  return scene;
}

/**
 * Get the background tile index at a position (what the scene would have without the player)
 */
function getBackgroundTileAt(row: number, col: number): number {
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

  // Middle path row (row 2) - sparse grass for path ALL THE WAY THROUGH
  if (row === 2) {
    tile = TILE.GRASS_SPARSE;
  }

  return tile;
}

/**
 * Render the forest scene to an array of ANSI strings (one per row)
 */
function renderForestScene(
  tileset: Tileset,
  characterTile: number,
  playerX: number,
  playerY: number
): string[] {
  const trailTile = extractTile(tileset, TILE.GRASS_SPARSE);

  // Create and render forest scene
  const scene = createForestScene(characterTile, playerX, playerY);

  // Pre-render all tiles
  const renderedTiles: string[][][] = [];
  for (let row = 0; row < scene.length; row++) {
    const renderedRow: string[][] = [];
    for (let col = 0; col < scene[row].length; col++) {
      const tileIndex = scene[row][col];
      let pixels = extractTile(tileset, tileIndex);

      // Composite characters/objects on appropriate background
      if (tileIndex >= 80) {
        // Check if this is the player character position
        if (row === playerY && col === playerX) {
          // Get the actual background tile at this position
          const bgTileIndex = getBackgroundTileAt(row, col);
          const bgTile = extractTile(tileset, bgTileIndex);
          pixels = compositeTiles(pixels, bgTile, 1);
        } else {
          // Other objects (like signpost) use sparse grass
          pixels = compositeTiles(pixels, trailTile, 1);
        }
      }

      renderedRow.push(renderTile(pixels));
    }
    renderedTiles.push(renderedRow);
  }

  // Build output lines
  const lines: string[] = [];
  for (let tileRow = 0; tileRow < scene.length; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = '';
      for (let tileCol = 0; tileCol < scene[tileRow].length; tileCol++) {
        line += renderedTiles[tileRow][tileCol][charRow];
      }
      lines.push(line);
    }
  }

  return lines;
}

/**
 * Create middle fill row for dialogue box
 */
function createMiddleFill(leftTile: RGB[][], charRow: number): string {
  const pixelRowTop = charRow * 2;
  const pixelRowBot = pixelRowTop + 1;

  let result = '';
  const sampleX = 8; // Middle column

  for (let x = 0; x < 16; x++) {
    const topPixel = leftTile[pixelRowTop][sampleX];
    const botPixel = leftTile[pixelRowBot]?.[sampleX] || topPixel;

    result += `\x1b[48;2;${topPixel.r};${topPixel.g};${topPixel.b}m`;
    result += `\x1b[38;2;${botPixel.r};${botPixel.g};${botPixel.b}m`;
    result += '\u2584'; // Lower half block
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
 * Render the dialogue box overlay as an array of strings
 */
function renderDialogueBox(tileset: Tileset): string[] {
  const dialogueBoxWidthTiles = 5;

  // Extract dialogue tiles
  const topLeft = extractTile(tileset, DIALOGUE_TILES.TOP_LEFT);
  const topRight = extractTile(tileset, DIALOGUE_TILES.TOP_RIGHT);
  const bottomLeft = extractTile(tileset, DIALOGUE_TILES.BOTTOM_LEFT);
  const bottomRight = extractTile(tileset, DIALOGUE_TILES.BOTTOM_RIGHT);

  const tlRendered = renderTile(topLeft);
  const trRendered = renderTile(topRight);
  const blRendered = renderTile(bottomLeft);
  const brRendered = renderTile(bottomRight);

  // Create middle fill rows
  const middleTopRendered: string[] = [];
  const middleBottomRendered: string[] = [];
  for (let row = 0; row < CHAR_HEIGHT; row++) {
    middleTopRendered.push(createMiddleFill(topLeft, row));
    middleBottomRendered.push(createMiddleFill(bottomLeft, row));
  }

  const middleTiles = Math.max(0, dialogueBoxWidthTiles - 2);
  const interiorWidth = middleTiles * 16; // 3 tiles * 16 = 48 chars

  // Build dialogue box lines
  const boxLines: string[] = [];

  // Top row of dialogue box tiles
  for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
    let line = tlRendered[charRow];
    for (let m = 0; m < middleTiles; m++) {
      line += middleTopRendered[charRow];
    }
    line += trRendered[charRow];
    boxLines.push(line);
  }

  // Bottom row of dialogue box tiles
  for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
    let line = blRendered[charRow];
    for (let m = 0; m < middleTiles; m++) {
      line += middleBottomRendered[charRow];
    }
    line += brRendered[charRow];
    boxLines.push(line);
  }

  // Sample background color from dialogue tile center
  const bgSamplePixel = topLeft[8][8];
  const textBgColor = `\x1b[48;2;${bgSamplePixel.r};${bgSamplePixel.g};${bgSamplePixel.b}m`;

  // The Arbiter wisdom text
  const textLines = [
    `${WHITE}You approach the lair of`,
    '',
    `${BOLD}${COLOR_ARBITER}THE ARBITER`,
    `${WHITE}OF THAT WHICH ${COLOR_WAS}WAS${WHITE},`,
    `${WHITE}THAT WHICH ${COLOR_IS}IS${WHITE},`,
    `${WHITE}AND THAT WHICH ${rainbow('SHALL COME TO BE')}`,
  ];

  // Center text in the dialogue box
  const boxHeight = CHAR_HEIGHT * 2;
  const textStartOffset = Math.floor((boxHeight - textLines.length) / 2);

  // Overlay text onto the box
  for (let i = 0; i < textLines.length; i++) {
    const boxLineIndex = textStartOffset + i;
    if (boxLineIndex >= 0 && boxLineIndex < boxLines.length) {
      const line = textLines[i];
      const visibleLength = stripAnsi(line).length;

      const padding = Math.max(0, Math.floor((interiorWidth - visibleLength) / 2));
      const rightPadding = Math.max(0, interiorWidth - padding - visibleLength);

      const textContent = ' '.repeat(padding) + line + ' '.repeat(rightPadding);
      const textWithBg = wrapTextWithBg(textContent, textBgColor);

      const isTopHalf = boxLineIndex < CHAR_HEIGHT;
      const charRow = isTopHalf ? boxLineIndex : boxLineIndex - CHAR_HEIGHT;

      const leftBorder = isTopHalf ? tlRendered[charRow] : blRendered[charRow];
      const rightBorder = isTopHalf ? trRendered[charRow] : brRendered[charRow];

      boxLines[boxLineIndex] = leftBorder + textWithBg + rightBorder;
    }
  }

  return boxLines;
}

/**
 * Render the death scene
 */
function renderDeathScene(tileset: Tileset): string[] {
  const DEATH_WIDTH = 3;
  const DEATH_HEIGHT = 2;

  const grassTile = extractTile(tileset, TILE.GRASS_SPARSE);
  const gravestoneTile = extractTile(tileset, DEATH_TILES.GRAVESTONE);
  const skeletonTile = extractTile(tileset, DEATH_TILES.SKELETON);

  const gravestoneComposite = compositeTiles(gravestoneTile, grassTile, 1);
  const skeletonComposite = compositeTiles(skeletonTile, grassTile, 1);

  const scene: RGB[][][][] = [
    [grassTile, gravestoneComposite, grassTile],
    [grassTile, skeletonComposite, grassTile],
  ];

  const renderedTiles: string[][][] = [];
  for (let row = 0; row < DEATH_HEIGHT; row++) {
    const renderedRow: string[][] = [];
    for (let col = 0; col < DEATH_WIDTH; col++) {
      renderedRow.push(renderTile(scene[row][col]));
    }
    renderedTiles.push(renderedRow);
  }

  const lines: string[] = [];
  for (let tileRow = 0; tileRow < DEATH_HEIGHT; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = '';
      for (let tileCol = 0; tileCol < DEATH_WIDTH; tileCol++) {
        line += renderedTiles[tileRow][tileCol][charRow];
      }
      lines.push(line);
    }
  }

  return lines;
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Shows the forest intro screen using terminal-kit with Strategy 5 (minimal redraws)
 *
 * @param selectedCharacter - The tile index of the selected character (190-197)
 * @returns Promise<'success' | 'death'> - 'success' when player exits right after seeing sign, 'death' if they die
 */
export async function showForestIntro(selectedCharacter: number): Promise<'success' | 'death'> {
  return new Promise(async (resolve) => {
    // Load tileset
    const tileset = await loadTileset();

    // Initialize terminal
    term.fullscreen(true);
    term.hideCursor();
    term.grabInput(true);

    // State
    const state: ForestState = {
      playerX: START_X,
      playerY: START_Y,
      phase: 'walking',
      hasSeenSign: false,
    };

    // Change tracker for minimal redraws
    const tracker: ChangeTracker = {
      lastPlayerX: -1,
      lastPlayerY: -1,
      lastPhase: 'walking',
      lastShowMessage: false,
    };

    // Calculate centering offsets
    let width = 180;
    let height = 50;
    if (typeof term.width === 'number' && isFinite(term.width) && term.width > 0) {
      width = term.width;
    }
    if (typeof term.height === 'number' && isFinite(term.height) && term.height > 0) {
      height = term.height;
    }

    const sceneOffsetX = Math.max(1, Math.floor((width - SCENE_WIDTH_CHARS) / 2));
    const sceneOffsetY = Math.max(1, Math.floor((height - SCENE_HEIGHT_CHARS - 4) / 2));

    /**
     * Draw the forest scene (only if changed)
     */
    function drawScene() {
      const showMessage = isNextToSign(state.playerX, state.playerY);

      // Track if player has seen the sign
      if (showMessage) {
        state.hasSeenSign = true;
      }

      // Check if anything changed
      if (
        state.playerX === tracker.lastPlayerX &&
        state.playerY === tracker.lastPlayerY &&
        state.phase === tracker.lastPhase &&
        showMessage === tracker.lastShowMessage
      ) {
        return;
      }

      // Check if message visibility changed - need to clear if it was showing
      const needsClear = tracker.lastShowMessage && !showMessage;

      tracker.lastPlayerX = state.playerX;
      tracker.lastPlayerY = state.playerY;
      tracker.lastPhase = state.phase;
      tracker.lastShowMessage = showMessage;

      // Clear screen if message box needs to disappear
      if (needsClear) {
        term.clear();
      }

      const sceneLines = renderForestScene(tileset, selectedCharacter, state.playerX, state.playerY);

      // Write scene lines
      for (let i = 0; i < sceneLines.length; i++) {
        term.moveTo(sceneOffsetX, sceneOffsetY + i);
        process.stdout.write(sceneLines[i] + RESET);
      }

      // Show dialogue box at bottom of scene if next to sign
      if (showMessage) {
        const dialogueLines = renderDialogueBox(tileset);
        // Center dialogue box horizontally: 5 tiles = 80 chars, scene = 112 chars
        // (112 - 80) / 2 = 16 chars offset from scene start
        const dialogueOffsetX = sceneOffsetX + Math.floor((SCENE_WIDTH_CHARS - 80) / 2);
        // Position dialogue to cover bottom 3 tile rows of scene
        // 3 tiles * 8 rows/tile = 24 rows, so start at: sceneHeight - 24
        const dialogueOffsetY = sceneOffsetY + (SCENE_HEIGHT_CHARS - 16);

        for (let i = 0; i < dialogueLines.length; i++) {
          term.moveTo(dialogueOffsetX, dialogueOffsetY + i);
          process.stdout.write(dialogueLines[i] + RESET);
        }
      } else {
        // Show hint text at bottom
        const hintY = sceneOffsetY + SCENE_HEIGHT_CHARS + 1;
        term.moveTo(sceneOffsetX, hintY);
        // Clear the line first
        process.stdout.write(' '.repeat(SCENE_WIDTH_CHARS));
        term.moveTo(sceneOffsetX, hintY);

        let hintText = `${DIM}Use arrow keys to move. Walk to the right to find the Arbiter.${RESET}`;
        if (state.hasSeenSign) {
          hintText = `${DIM}Continue to the right to enter the Arbiter's lair.${RESET}`;
        }
        process.stdout.write(hintText);
      }
    }

    /**
     * Draw the death screen
     */
    function drawDeathScreen() {
      // Clear screen first
      term.clear();

      const deathLines = renderDeathScene(tileset);

      // Center the death scene
      const deathWidth = 3 * TILE_SIZE; // 48 chars
      const deathHeight = deathLines.length;
      const deathOffsetX = Math.max(1, Math.floor((width - deathWidth) / 2));
      const deathOffsetY = Math.max(1, Math.floor((height - deathHeight - 6) / 2));

      // Draw death scene tiles
      for (let i = 0; i < deathLines.length; i++) {
        term.moveTo(deathOffsetX, deathOffsetY + i);
        process.stdout.write(deathLines[i] + RESET);
      }

      // Death messages
      const msgY = deathOffsetY + deathHeight + 2;
      const msg1 = `${COLOR_DEATH}${BOLD}You strayed from the path.${RESET}`;
      const msg2 = `${COLOR_DEATH}The forest claims another soul.${RESET}`;
      const msg3 = `${DIM}Press y to try again...${RESET}`;

      term.moveTo(Math.max(1, Math.floor((width - 26) / 2)), msgY);
      process.stdout.write(msg1);
      term.moveTo(Math.max(1, Math.floor((width - 32) / 2)), msgY + 1);
      process.stdout.write(msg2);
      term.moveTo(Math.max(1, Math.floor((width - 22) / 2)), msgY + 3);
      process.stdout.write(msg3);
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
    drawScene();

    // Handle keyboard input
    term.on('key', (key: string) => {
      // Quit handling
      if (key === 'q' || key === 'CTRL_C' || key === 'CTRL_Z') {
        cleanup();
        process.exit(0);
        return;
      }

      // Death screen - only 'y' to retry
      if (state.phase === 'dead') {
        if (key === 'y' || key === 'Y') {
          cleanup();
          resolve('death');
        }
        return;
      }

      // Walking phase - handle arrow key movement
      if (state.phase === 'walking') {
        let newX = state.playerX;
        let newY = state.playerY;

        if (key === 'UP') newY--;
        if (key === 'DOWN') newY++;
        if (key === 'LEFT') newX--;
        if (key === 'RIGHT') newX++;

        // No movement key pressed
        if (newX === state.playerX && newY === state.playerY) {
          return;
        }

        // Check if trying to move off screen
        if (isOffScreen(newX, newY)) {
          // Check if this is the valid exit: moving right off screen on path row after seeing sign
          if (newX >= SCENE_WIDTH_TILES && newY === START_Y && state.hasSeenSign) {
            // Successfully exited by walking off the right edge on the path!
            cleanup();
            resolve('success');
            return;
          }
          // Wandered off in wrong direction or skipped sign - death!
          state.phase = 'dead';
          drawDeathScreen();
          return;
        }

        // Check collision with blocked tiles
        if (!isWalkable(newX, newY)) {
          // Can't walk there, don't move
          return;
        }

        // Valid move - update position
        state.playerX = newX;
        state.playerY = newY;

        drawScene();
      }
    });
  });
}

export default showForestIntro;
