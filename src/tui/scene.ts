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
  mirrorTile,
  extractQuarterTile,
  compositeQuarterTile,
  QuarterPosition,
} from './tileset.js';

// ============================================================================
// Types
// ============================================================================

/**
 * State for a single hop animation at a position
 * Each hop = 500ms (250ms up + 250ms down)
 */
export interface HopState {
  remaining: number; // Number of hops left (0 = done)
  frameInHop: 0 | 1; // 0 = up (hopping), 1 = down (resting)
}

/**
 * Scene state describing positions and counts of all scene elements
 */
export interface SceneState {
  arbiterPos: -1 | 0 | 1 | 2 | 3; // -1=off-screen, 0=near human, 1=center, 2=by cauldron, 3=by fire (start)
  demonCount: number; // 0-5
  focusTarget: 'human' | 'arbiter' | 'demon' | null;
  selectedCharacter: number; // Tile index 190-197 for selected human character
  humanCol: number; // Human character column position (0-6, default 1)

  // Animation state (position-based, not identity-based)
  activeHops: Map<string, HopState>; // key = "row,col"
  bubbleVisible: boolean; // Cauldron smoke on/off
  showSpellbook: boolean; // Arbiter's spellbook visibility

  // Chat bubble indicator - shows over the most recent speaker
  chatBubbleTarget: 'human' | 'arbiter' | 'conjuring' | null;

  // Alert/exclamation indicator - shows over a character (e.g., arbiter noticing scroll)
  alertTarget: 'human' | 'arbiter' | 'conjuring' | null;

  // Scroll of requirements visibility
  scrollVisible: boolean;
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
    arbiterPos: 3, // Start by fire (row 3), walks to human when first message ready
    demonCount: 0,
    focusTarget: null,
    selectedCharacter: TILE.HUMAN_1,
    humanCol: 1, // Default position (after entry animation)

    // Animation state
    activeHops: new Map(),
    bubbleVisible: false,
    showSpellbook: false,

    // Chat bubble
    chatBubbleTarget: null,

    // Alert/exclamation indicator
    alertTarget: null,

    // Scroll of requirements
    scrollVisible: false,
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
  const { arbiterPos, demonCount, selectedCharacter, humanCol, bubbleVisible, showSpellbook, scrollVisible } = state;
  // arbiterPos -1 means off-screen (not visible)
  const arbiterVisible = arbiterPos >= 0;

  // Position mapping:
  // Pos 3: row 3, col 4 (by fire - starting position)
  // Pos 2: row 2, col 4 (moved up, by cauldron)
  // Pos 1: row 2, col 3 (center)
  // Pos 0: row 2, col 2 (near human)
  let arbiterCol = -1;
  let arbiterRow = 2;
  if (arbiterVisible) {
    switch (arbiterPos) {
      case 0: arbiterCol = 3; arbiterRow = 2; break;
      case 1: arbiterCol = 3; arbiterRow = 2; break;
      case 2: arbiterCol = 4; arbiterRow = 2; break;
      case 3: arbiterCol = 4; arbiterRow = 3; break;
    }
  }

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

      // Human character on row 2 at humanCol position
      if (row === 2 && col === humanCol && humanCol >= 0 && humanCol < SCENE_WIDTH) {
        tile = selectedCharacter;
      }

      // Scroll of requirements (row 2, col 2) - between human and arbiter
      if (scrollVisible && row === 2 && col === 2) {
        tile = TILE.SCROLL;
      }

      // Spellbook at row 4, col 4 (one down and left from campfire)
      // Shows when explicitly set (during arbiter's working position)
      if (showSpellbook && row === 4 && col === 4) {
        tile = TILE.SPELLBOOK;
      }

      // Cauldron (row 2, col 5)
      if (row === 2 && col === 5) {
        tile = TILE.CAULDRON;
      }

      // Smoke/bubbles above cauldron when bubbleVisible is true
      if (bubbleVisible && row === 1 && col === 5) {
        tile = TILE.SMOKE;
      }

      // Campfire (row 3, col 5)
      if (row === 3 && col === 5) {
        tile = TILE.CAMPFIRE;
      }

      // Arbiter - only draw if visible (arbiterPos >= 0)
      if (arbiterVisible && row === arbiterRow && col === arbiterCol) {
        tile = TILE.ARBITER;
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
 * Get the row,col position for a chat bubble target
 */
function getChatBubblePosition(
  state: SceneState,
  target: 'human' | 'arbiter' | 'conjuring'
): { row: number; col: number } {
  switch (target) {
    case 'human':
      return { row: 2, col: state.humanCol };
    case 'arbiter': {
      const pos = state.arbiterPos;
      switch (pos) {
        case 0: return { row: 2, col: 3 };  // Fixed to match createScene
        case 1: return { row: 2, col: 3 };
        case 2: return { row: 2, col: 4 };
        case 3: return { row: 3, col: 4 };
        default: return { row: 2, col: 3 };
      }
    }
    case 'conjuring':
      // First demon position
      return { row: 2, col: 6 };
  }
}

// Cache for the chat bubble quarter tile (extracted once, reused)
let chatBubbleQuarterCache: RGB[][] | null = null;

/**
 * Get or create the cached chat bubble quarter tile
 */
function getChatBubbleQuarter(tileset: Tileset): RGB[][] {
  if (!chatBubbleQuarterCache) {
    const quartersTile = extractTile(tileset, TILE.CHAT_BUBBLE_QUARTERS);
    chatBubbleQuarterCache = extractQuarterTile(quartersTile, 'top-right');
  }
  return chatBubbleQuarterCache;
}

// Cache for the alert/exclamation quarter tile (extracted once, reused)
let alertQuarterCache: RGB[][] | null = null;

/**
 * Get or create the cached alert/exclamation quarter tile
 */
function getAlertQuarter(tileset: Tileset): RGB[][] {
  if (!alertQuarterCache) {
    const quartersTile = extractTile(tileset, TILE.ALERT_QUARTERS);
    alertQuarterCache = extractQuarterTile(quartersTile, 'top-left');
  }
  return alertQuarterCache;
}

/**
 * Render the scene to an ANSI string
 *
 * @param tileset - The loaded tileset
 * @param scene - The tile grid from createScene
 * @param activeHops - Map of "row,col" -> HopState for positions that should hop
 * @param sceneState - Optional scene state for chat bubble rendering
 */
export function renderScene(
  tileset: Tileset,
  scene: TileSpec[][],
  activeHops: Map<string, HopState> = new Map(),
  sceneState?: SceneState
): string {
  // Get grass pixels for compositing
  const grassPixels = extractTile(tileset, TILE.GRASS);

  // Determine chat bubble position if target is set
  let bubbleRow = -1;
  let bubbleCol = -1;
  if (sceneState?.chatBubbleTarget) {
    const pos = getChatBubblePosition(sceneState, sceneState.chatBubbleTarget);
    bubbleRow = pos.row;
    bubbleCol = pos.col;
  }

  // Determine alert/exclamation position if target is set
  let alertRow = -1;
  let alertCol = -1;
  if (sceneState?.alertTarget) {
    const pos = getChatBubblePosition(sceneState, sceneState.alertTarget);
    alertRow = pos.row;
    alertCol = pos.col;
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

      // Check if this position needs an overlay (chat bubble or alert)
      const needsBubble = row === bubbleRow && col === bubbleCol;
      const needsAlert = row === alertRow && col === alertCol;

      if (needsBubble || needsAlert) {
        // Render without cache, adding the overlay
        let pixels = extractTile(tileset, tileIndex);

        // Composite on grass if needed
        if (tileIndex >= 80) {
          pixels = compositeTiles(pixels, grassPixels, 1);
        }

        if (mirrored) {
          pixels = mirrorTile(pixels);
        }

        // Add chat bubble to top-right corner
        if (needsBubble) {
          const bubbleQuarter = getChatBubbleQuarter(tileset);
          pixels = compositeQuarterTile(pixels, bubbleQuarter, 'top-right', 1);
        }

        // Add alert/exclamation to top-left corner
        if (needsAlert) {
          const alertQuarter = getAlertQuarter(tileset);
          pixels = compositeQuarterTile(pixels, alertQuarter, 'top-left', 1);
        }

        renderedRow.push(renderTile(pixels));
      } else {
        // Use cached render
        renderedRow.push(getTileRender(tileset, grassPixels, tileIndex, mirrored));
      }
    }
    renderedTiles.push(renderedRow);
  }

  // Build output string
  // Hop detection now uses activeHops map - check if position is hopping and in "up" frame
  // When hopping, we need to shift the hopping tile up by 1 row
  // This means: at the row above, we show the bottom row of the hopping tile
  // and at the tile's normal position, we show rows shifted up
  const lines: string[] = [];
  for (let tileRow = 0; tileRow < scene.length; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      let line = '';
      for (let tileCol = 0; tileCol < scene[tileRow].length; tileCol++) {
        // Check if this position is hopping (and in "up" frame)
        const hopKey = `${tileRow},${tileCol}`;
        const hopState = activeHops.get(hopKey);
        const isHoppingTile = hopState && hopState.frameInHop === 0;

        // Check if tile above is hopping (for the overflow effect)
        const hopKeyBelow = `${tileRow + 1},${tileCol}`;
        const hopStateBelow = activeHops.get(hopKeyBelow);
        const isTileAboveHopping = hopStateBelow && hopStateBelow.frameInHop === 0;

        if (isHoppingTile) {
          // For the hopping tile, show the row below (shifted up)
          // If charRow is 0, we show nothing special (already handled by tile above)
          // Otherwise show charRow - 1 if we're hopping, but we need to handle the overlap
          if (charRow === 0) {
            // First char row of hopping tile shows second row of the tile
            line += renderedTiles[tileRow][tileCol][1];
          } else if (charRow === CHAR_HEIGHT - 1) {
            // Last char row shows grass (the tile has moved up)
            line += renderedTiles[tileRow][tileCol][charRow]; // Actually show grass from tile
          } else {
            // Show the next row down (shifted up by 1)
            line += renderedTiles[tileRow][tileCol][charRow + 1];
          }
        } else if (isTileAboveHopping) {
          // For the tile above the hopping tile, the last row shows the first row of the hopping tile
          if (charRow === CHAR_HEIGHT - 1) {
            line += renderedTiles[tileRow + 1][tileCol][0];
          } else {
            line += renderedTiles[tileRow][tileCol][charRow];
          }
        } else {
          line += renderedTiles[tileRow][tileCol][charRow];
        }
      }
      lines.push(line);
    }
  }

  // Join with newlines (no trailing newline to prevent extra line causing flicker)
  return lines.join('\n');
}
