/**
 * Scene state and composition module for the Arbiter TUI
 *
 * Manages scene state and creates tile grids for rendering the wizard council scene.
 * The scene shows a human, the arbiter, a spellbook, a campfire, and demons.
 */

import {
  Tileset,
  RGB,
  TILE,
  TILE_SIZE,
  CHAR_HEIGHT,
  RESET,
  loadTileset,
  extractTile,
  compositeTiles,
  renderTile,
  compositeWithFocus,
  mirrorTile,
} from './tileset.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Scene state describing positions and counts of all scene elements
 */
export interface SceneState {
  arbiterPos: 0 | 1 | 2; // 0=near human, 1=center, 2=near spellbook
  demonCount: number; // 0-5
  focusTarget: 'human' | 'arbiter' | 'demon' | null;
  selectedCharacter: number; // Tile index 190-197 for selected human character
  workingTarget: 'arbiter' | 'conjuring' | null; // Who is currently processing
  hopFrame: boolean; // Alternates true/false for hop animation
  bubbleFrame: boolean; // Alternates for bubble visibility
}

/**
 * Tile specification - either a simple tile index or an object with mirroring
 */
export type TileSpec = number | { tile: number; mirrored: boolean };

// ============================================================================
// Constants
// ============================================================================

const SCENE_WIDTH = 7;
const SCENE_HEIGHT = 6;

// Demon spawn positions around the campfire (order matters for spawning)
const DEMON_POSITIONS = [
  { row: 2, col: 6, tile: TILE.DEMON_1 }, // right of fire (first)
  { row: 1, col: 6, tile: TILE.DEMON_2 }, // above-right
  { row: 3, col: 6, tile: TILE.DEMON_3 }, // below-right
  { row: 1, col: 5, tile: TILE.DEMON_4 }, // above fire
  { row: 3, col: 5, tile: TILE.DEMON_5 }, // below fire
];

/**
 * Get a varied grass tile based on position for visual variety
 * Returns ~30% sparse grass, ~70% regular grass using a deterministic pattern
 */
function getGrassTile(row: number, col: number): number {
  // Use a simple pattern based on position for variety
  // This creates a natural-looking distribution of grass types
  const pattern = (row * 3 + col * 7) % 10;
  if (pattern < 3) return TILE.GRASS_SPARSE;
  return TILE.GRASS;
}

// ============================================================================
// Tile Render Cache
// ============================================================================

const tileCache: Map<string, string[]> = new Map();

/**
 * Generate cache key for a tile render
 */
function getCacheKey(tileIndex: number, mirrored: boolean): string {
  return `${tileIndex}:${mirrored ? 'M' : 'N'}`;
}

/**
 * Get or create a cached tile render
 */
function getTileRender(
  tileset: Tileset,
  grassPixels: RGB[][],
  tileIndex: number,
  mirrored: boolean = false
): string[] {
  const key = getCacheKey(tileIndex, mirrored);
  if (tileCache.has(key)) {
    return tileCache.get(key)!;
  }

  let pixels = extractTile(tileset, tileIndex);

  // Composite tiles >= 80 on grass (characters, objects, etc.)
  if (tileIndex >= 80) {
    pixels = compositeTiles(pixels, grassPixels, 1);
  }

  if (mirrored) {
    pixels = mirrorTile(pixels);
  }

  const rendered = renderTile(pixels);
  tileCache.set(key, rendered);
  return rendered;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create initial scene state with defaults
 */
export function createInitialSceneState(): SceneState {
  return {
    arbiterPos: 0,
    demonCount: 0,
    focusTarget: null,
    selectedCharacter: TILE.HUMAN_1,
    workingTarget: null,
    hopFrame: false,
    bubbleFrame: false,
  };
}

// ============================================================================
// Scene Creation
// ============================================================================

/**
 * Create a 7x6 grid of tile specifications based on scene state
 *
 * Scene Layout:
 * - Row 0-1: Trees on edges (col 0 and 6), grass elsewhere
 * - Row 2: Human at col 1, Arbiter at col 2-4 (based on arbiterPos), Cauldron at col 5, tree at col 6
 * - Row 3: Tree at col 0, grass, campfire at col 5, tree at col 6
 * - Row 4-5: Trees at col 0 and 6, grass elsewhere
 * - Demons spawn around campfire at col 5-6, rows 1-3
 * - Smoke bubbles appear above cauldron when working
 * - Spellbook appears to the left of arbiter when at position 2
 */
export function createScene(state: SceneState): TileSpec[][] {
  const { arbiterPos, demonCount, selectedCharacter, workingTarget, bubbleFrame } = state;
  const arbiterCol = 2 + arbiterPos;
  const arbiterRow = 2;

  const scene: TileSpec[][] = [];

  for (let row = 0; row < SCENE_HEIGHT; row++) {
    const sceneRow: TileSpec[] = [];
    for (let col = 0; col < SCENE_WIDTH; col++) {
      let tile: TileSpec = getGrassTile(row, col);

      // Trees on left edge (col 0), except row 2 which is the path entrance
      if (col === 0) {
        tile = row === 2 ? TILE.GRASS_SPARSE : TILE.PINE_TREE;
      }

      // Bare trees at specific positions on col 1
      if (col === 1 && (row === 0 || row === 4)) {
        tile = TILE.BARE_TREE;
      }

      // Trees on right edge (col 6)
      if (col === 6 && (row === 0 || row === 4 || row === 5)) {
        tile = TILE.PINE_TREE;
      }

      // Human emerging from forest (row 2, col 1)
      if (row === 2 && col === 1) {
        tile = selectedCharacter;
      }

      // Spellbook appears to the left of arbiter when at position 2 (col 4)
      // Spellbook at col 3 (to arbiter's left)
      if (arbiterPos === 2 && row === 2 && col === 3) {
        tile = TILE.SPELLBOOK;
      }

      // Cauldron (row 2, col 5)
      if (row === 2 && col === 5) {
        tile = TILE.CAULDRON;
      }

      // Smoke/bubbles above cauldron when working and bubbleFrame is true
      if (workingTarget && bubbleFrame && row === 1 && col === 5) {
        tile = TILE.SMOKE;
      }

      // Campfire (row 3, col 5)
      if (row === 3 && col === 5) {
        tile = TILE.CAMPFIRE;
      }

      // Arbiter - faces left when near human (pos 0), faces right when at spellbook (pos 2)
      if (row === arbiterRow && col === arbiterCol) {
        const facingHuman = arbiterPos === 0;
        tile = { tile: TILE.ARBITER, mirrored: facingHuman };
      }

      // Demons based on count (spawn in order)
      for (let i = 0; i < Math.min(demonCount, DEMON_POSITIONS.length); i++) {
        const dp = DEMON_POSITIONS[i];
        if (row === dp.row && col === dp.col) {
          tile = dp.tile;
        }
      }

      sceneRow.push(tile);
    }
    scene.push(sceneRow);
  }

  return scene;
}

// ============================================================================
// Scene Rendering
// ============================================================================

/**
 * Get focus position based on target and arbiter position
 */
function getFocusPosition(
  focusTarget: 'human' | 'arbiter' | 'demon' | null,
  arbiterPos: 0 | 1 | 2,
  demonCount: number
): { row: number; col: number } | null {
  if (!focusTarget) return null;

  switch (focusTarget) {
    case 'human':
      return { row: 2, col: 1 };
    case 'arbiter':
      return { row: 2, col: 2 + arbiterPos };
    case 'demon':
      if (demonCount > 0) {
        // Focus first demon (row 2, col 6)
        return { row: 2, col: 6 };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Render the scene to an ANSI string
 */
export function renderScene(
  tileset: Tileset,
  scene: TileSpec[][],
  focusTarget: 'human' | 'arbiter' | 'demon' | null,
  workingTarget: 'arbiter' | 'conjuring' | null = null,
  hopFrame: boolean = false
): string {
  // Get grass pixels for compositing
  const grassPixels = extractTile(tileset, TILE.GRASS);

  // Determine arbiter position from scene (needed for focus position)
  let arbiterPos: 0 | 1 | 2 = 1;
  let demonCount = 0;

  // Scan scene for arbiter position and demon count
  for (let row = 0; row < scene.length; row++) {
    for (let col = 0; col < scene[row].length; col++) {
      const tileSpec = scene[row][col];
      if (typeof tileSpec === 'object' && tileSpec.tile === TILE.ARBITER) {
        arbiterPos = (col - 2) as 0 | 1 | 2;
      }
      // Count demons
      if (
        typeof tileSpec === 'number' &&
        tileSpec >= TILE.DEMON_1 &&
        tileSpec <= TILE.DEMON_5
      ) {
        demonCount++;
      }
    }
  }

  // Calculate focus position
  const focusPos = getFocusPosition(focusTarget, arbiterPos, demonCount);

  // Get focus overlay pixels if needed
  let focusPixels: RGB[][] | null = null;
  if (focusTarget && focusPos) {
    focusPixels = extractTile(tileset, TILE.FOCUS);
  }

  const renderedTiles: string[][][] = [];

  for (let row = 0; row < scene.length; row++) {
    const renderedRow: string[][] = [];
    for (let col = 0; col < scene[row].length; col++) {
      const tileSpec = scene[row][col];
      let tileIndex: number;
      let mirrored = false;

      if (typeof tileSpec === 'number') {
        tileIndex = tileSpec;
      } else {
        tileIndex = tileSpec.tile;
        mirrored = tileSpec.mirrored;
      }

      // Check if this tile should have focus overlay
      const hasFocus = focusPos && focusPos.row === row && focusPos.col === col;

      if (hasFocus && focusPixels) {
        // Render tile with focus overlay (not cached)
        let charPixels = extractTile(tileset, tileIndex);
        if (tileIndex >= 80) {
          charPixels = compositeTiles(charPixels, grassPixels, 1);
        }
        if (mirrored) {
          charPixels = mirrorTile(charPixels);
        }
        const withFocus = compositeWithFocus(charPixels, focusPixels, 1);
        renderedRow.push(renderTile(withFocus));
      } else {
        renderedRow.push(getTileRender(tileset, grassPixels, tileIndex, mirrored));
      }
    }
    renderedTiles.push(renderedRow);
  }

  // Determine which tile position should hop based on workingTarget
  let hopTilePos: { row: number; col: number } | null = null;
  if (workingTarget && hopFrame) {
    if (workingTarget === 'arbiter') {
      // Arbiter is at row 2, col depends on arbiterPos
      hopTilePos = { row: 2, col: 2 + arbiterPos };
    } else if (workingTarget === 'conjuring' && demonCount > 0) {
      // First demon is at row 2, col 6
      hopTilePos = { row: 2, col: 6 };
    }
  }

  // Build output string
  // When hopping, we need to shift the hopping tile up by 1 row
  // This means: at the row above, we show the bottom row of the hopping tile
  // and at the tile's normal position, we show rows shifted up
  let output = '';
  for (let tileRow = 0; tileRow < scene.length; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      for (let tileCol = 0; tileCol < scene[tileRow].length; tileCol++) {
        const isHoppingTile = hopTilePos && hopTilePos.row === tileRow && hopTilePos.col === tileCol;
        const isTileAboveHopping = hopTilePos && hopTilePos.row === tileRow + 1 && hopTilePos.col === tileCol;

        if (isHoppingTile) {
          // For the hopping tile, show the row below (shifted up)
          // If charRow is 0, we show nothing special (already handled by tile above)
          // Otherwise show charRow - 1 if we're hopping, but we need to handle the overlap
          if (charRow === 0) {
            // First char row of hopping tile shows second row of the tile
            output += renderedTiles[tileRow][tileCol][1];
          } else if (charRow === CHAR_HEIGHT - 1) {
            // Last char row shows grass (the tile has moved up)
            output += renderedTiles[tileRow][tileCol][charRow]; // Actually show grass from tile
          } else {
            // Show the next row down (shifted up by 1)
            output += renderedTiles[tileRow][tileCol][charRow + 1];
          }
        } else if (isTileAboveHopping) {
          // For the tile above the hopping tile, the last row shows the first row of the hopping tile
          if (charRow === CHAR_HEIGHT - 1) {
            output += renderedTiles[tileRow + 1][tileCol][0];
          } else {
            output += renderedTiles[tileRow][tileCol][charRow];
          }
        } else {
          output += renderedTiles[tileRow][tileCol][charRow];
        }
      }
      output += '\n';
    }
  }

  return output;
}
