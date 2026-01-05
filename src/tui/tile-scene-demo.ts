#!/usr/bin/env npx ts-node
/**
 * Animated tile scene demo for Arbiter TUI
 * Shows two scenes with animation:
 * 1. Human talking to Arbiter
 * 2. Arbiter at spellbook with campfire and demons
 *
 * Press Ctrl+C to exit
 */

import sharp from 'sharp';
import path from 'path';

const TILE_SIZE = 16;
const TILES_PER_ROW = 10;
const TILESET_PATH = path.join(process.cwd(), 'assets/jerom_16x16.png');

// Scene dimensions: 7 tiles wide × 6 tiles tall
const SCENE_WIDTH = 7;
const SCENE_HEIGHT = 6;
const CHAR_HEIGHT = 8; // Each tile is 8 rows tall in terminal (16px / 2 for half-block chars)

// Key tile indices
const TILE = {
  GRASS: 50,
  PINE_TREE: 57,
  BARE_TREE: 58,
  CAMPFIRE: 87,
  SPELLBOOK: 102,
  HUMAN_1: 190,
  HUMAN_2: 191,
  HUMAN_3: 192,
  ARBITER: 205,
  DEMON_1: 220,
  DEMON_2: 221,
  DEMON_3: 222,
  DEMON_4: 223,
  DEMON_5: 224,
  FOCUS: 270,  // Focus overlay - corner brackets to highlight active speaker
};

interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Tileset {
  width: number;
  height: number;
  data: Buffer;
}

// ANSI escape codes
const RESET = '\x1b[0m';
const CLEAR_SCREEN = '\x1b[2J';
const CURSOR_HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

async function loadTileset(): Promise<Tileset> {
  const image = sharp(TILESET_PATH);
  const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function getPixel(data: Buffer, width: number, x: number, y: number): RGB {
  const idx = (y * width + x) * 4;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
}

function extractTile(data: Buffer, width: number, tileIndex: number): RGB[][] {
  const tileX = (tileIndex % TILES_PER_ROW) * TILE_SIZE;
  const tileY = Math.floor(tileIndex / TILES_PER_ROW) * TILE_SIZE;
  const pixels: RGB[][] = [];
  for (let y = 0; y < TILE_SIZE; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < TILE_SIZE; x++) {
      row.push(getPixel(data, width, tileX + x, tileY + y));
    }
    pixels.push(row);
  }
  return pixels;
}

// True color ANSI
function tc(r: number, g: number, b: number, bg: boolean): string {
  return bg ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[38;2;${r};${g};${b}m`;
}

function renderTileTC(pixels: RGB[][]): string[] {
  const lines: string[] = [];
  for (let y = 0; y < TILE_SIZE; y += 2) {
    let line = '';
    for (let x = 0; x < TILE_SIZE; x++) {
      const top = pixels[y][x];
      const bot = pixels[y + 1]?.[x] || top;
      line += tc(top.r, top.g, top.b, true) + tc(bot.r, bot.g, bot.b, false) + '▄';
    }
    line += RESET;
    lines.push(line);
  }
  return lines;
}

function compositeTiles(fg: RGB[][], bg: RGB[][], alphaThreshold: number): RGB[][] {
  const size = fg.length;
  const result: RGB[][] = [];
  for (let y = 0; y < size; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < size; x++) {
      const fgPx = fg[y][x];
      const bgPx = bg[y]?.[x] || fgPx;
      row.push(fgPx.a < alphaThreshold ? bgPx : fgPx);
    }
    result.push(row);
  }
  return result;
}

/**
 * Mirror a tile horizontally (flip left-right)
 */
function mirrorTile(pixels: RGB[][]): RGB[][] {
  return pixels.map(row => [...row].reverse());
}

// Pre-cached tile renders
const tileCache: Map<string, string[]> = new Map();

function getCacheKey(tileIndex: number, mirrored: boolean): string {
  return `${tileIndex}:${mirrored ? 'M' : 'N'}`;
}

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

  let pixels = extractTile(tileset.data, tileset.width, tileIndex);

  // Composite tiles >= 80 on grass (characters, objects, etc.)
  if (tileIndex >= 80) {
    pixels = compositeTiles(pixels, grassPixels, 1);
  }

  if (mirrored) {
    pixels = mirrorTile(pixels);
  }

  const rendered = renderTileTC(pixels);
  tileCache.set(key, rendered);
  return rendered;
}

type TileSpec = number | { tile: number; mirrored: boolean };

/**
 * Composite focus overlay on top of a character tile
 * The focus overlay has transparent center, only the corner brackets show
 */
function compositeWithFocus(
  charPixels: RGB[][],
  focusPixels: RGB[][],
  alphaThreshold: number
): RGB[][] {
  const size = charPixels.length;
  const result: RGB[][] = [];
  for (let y = 0; y < size; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < size; x++) {
      const focusPx = focusPixels[y][x];
      const charPx = charPixels[y][x];
      // Focus overlay: if focus pixel is opaque, use it; otherwise use character
      row.push(focusPx.a >= alphaThreshold ? focusPx : charPx);
    }
    result.push(row);
  }
  return result;
}

type FocusTarget = 'human' | 'arbiter' | 'demon' | null;

/**
 * Unified scene layout:
 * - Human emerges from forest on left (col 0-1)
 * - Arbiter walks from left (col 2, talking to human) to right (col 4, at spellbook)
 * - Spellbook on right (col 5)
 * - Campfire past spellbook (col 6)
 * - Demons spawn above and below campfire
 *
 * Layout (7x6):
 *   0: [tree] [tree]  [grass] [grass] [grass]    [demon?] [tree]
 *   1: [tree] [grass] [grass] [grass] [spellbook][campfire][demon?]
 *   2: [tree] [human] [<-arbiter->]   [grass]    [grass]  [demon?]
 *   3: [tree] [grass] [grass] [grass] [grass]    [grass]  [demon?]
 *   4: [tree] [tree]  [grass] [grass] [grass]    [demon?] [tree]
 *   5: [tree] [grass] [grass] [grass] [grass]    [grass]  [tree]
 */
function createUnifiedScene(arbiterPos: number, demonCount: number, focusTarget: FocusTarget = null): TileSpec[][] {
  // arbiterPos: 0 = left (col 2, near human), 1 = center (col 3), 2 = right (col 4, at spellbook)
  const arbiterCol = 2 + arbiterPos;
  const arbiterRow = 2;

  // Demon positions around campfire (tightly clustered)
  // Campfire is at row 2, col 5
  // Spawn order: right side first, then above/below
  const demonPositions = [
    { row: 2, col: 6, tile: TILE.DEMON_1 },  // right of campfire (first)
    { row: 1, col: 6, tile: TILE.DEMON_2 },  // above-right
    { row: 3, col: 6, tile: TILE.DEMON_3 },  // below-right
    { row: 1, col: 5, tile: TILE.DEMON_4 },  // directly above campfire
    { row: 3, col: 5, tile: TILE.DEMON_5 },  // directly below campfire
  ];

  const scene: TileSpec[][] = [];

  for (let row = 0; row < SCENE_HEIGHT; row++) {
    const sceneRow: TileSpec[] = [];
    for (let col = 0; col < SCENE_WIDTH; col++) {
      let tile: TileSpec = TILE.GRASS;

      // Forest on left edge (human emerging from trees)
      if (col === 0) {
        tile = TILE.PINE_TREE;
      }
      if (col === 1 && (row === 0 || row === 4)) {
        tile = TILE.BARE_TREE;
      }

      // Trees on right edge
      if (col === 6 && (row === 0 || row === 4 || row === 5)) {
        tile = TILE.PINE_TREE;
      }

      // Human emerging from forest (row 2, col 1)
      if (row === 2 && col === 1) tile = TILE.HUMAN_1;

      // Spellbook (row 1, col 4) - where arbiter summons from
      if (row === 1 && col === 4) tile = TILE.SPELLBOOK;

      // Campfire (row 2, col 5) - past the spellbook, demons gather around it
      if (row === 2 && col === 5) tile = TILE.CAMPFIRE;

      // Arbiter - faces left when near human, faces right when at spellbook
      if (row === arbiterRow && col === arbiterCol) {
        const facingHuman = arbiterPos <= 1;
        tile = { tile: TILE.ARBITER, mirrored: facingHuman };
      }

      // Demons based on count
      for (let i = 0; i < Math.min(demonCount, demonPositions.length); i++) {
        const dp = demonPositions[i];
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

function renderScene(
  tileset: Tileset,
  grassPixels: RGB[][],
  scene: TileSpec[][],
  focusTarget: FocusTarget = null,
  focusPos: { row: number; col: number } | null = null
): string {
  // Get focus overlay pixels if needed
  let focusPixels: RGB[][] | null = null;
  if (focusTarget && focusPos) {
    focusPixels = extractTile(tileset.data, tileset.width, TILE.FOCUS);
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
        // Render tile with focus overlay
        let charPixels = extractTile(tileset.data, tileset.width, tileIndex);
        if (tileIndex >= 80) {
          charPixels = compositeTiles(charPixels, grassPixels, 1);
        }
        if (mirrored) {
          charPixels = mirrorTile(charPixels);
        }
        const withFocus = compositeWithFocus(charPixels, focusPixels, 1);
        renderedRow.push(renderTileTC(withFocus));
      } else {
        renderedRow.push(getTileRender(tileset, grassPixels, tileIndex, mirrored));
      }
    }
    renderedTiles.push(renderedRow);
  }

  // Build output string
  let output = '';
  for (let tileRow = 0; tileRow < scene.length; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      for (let tileCol = 0; tileCol < scene[tileRow].length; tileCol++) {
        output += renderedTiles[tileRow][tileCol][charRow];
      }
      output += '\n';
    }
  }

  return output;
}

async function main() {
  const tileset = await loadTileset();
  const grassPixels = extractTile(tileset.data, tileset.width, TILE.GRASS);

  // Hide cursor
  process.stdout.write(HIDE_CURSOR);

  // Animation state
  let arbiterPos = 0; // 0 = near human (left), 1 = center, 2 = at spellbook (right)
  let demonCount = 0; // 0-5
  let walkingDirection = 1; // 1 = walking right (toward spellbook), -1 = walking left (toward human)
  let frameCount = 0;
  let pauseFrames = 0; // Pause when arbiter reaches destination
  let focusTarget: FocusTarget = null; // Who has focus (speaking indicator)

  function animate() {
    frameCount++;

    // Just move cursor home - DON'T clear screen (causes flashing)
    process.stdout.write(CURSOR_HOME);

    // Header - describe what's happening
    let status: string;
    if (arbiterPos === 0) {
      status = 'Arbiter listening to Human...';
    } else if (arbiterPos === 2) {
      status = `Arbiter commanding ${demonCount} demon${demonCount !== 1 ? 's' : ''}...`;
    } else {
      status = walkingDirection > 0 ? 'Arbiter walking to spellbook...' : 'Arbiter returning to human...';
    }

    console.log(`\n  === ${status.padEnd(45)} ===`);
    console.log('  Press Ctrl+C to exit                        \n');

    // Calculate focus position based on target
    let focusPos: { row: number; col: number } | null = null;
    if (focusTarget === 'human') {
      focusPos = { row: 2, col: 1 };
    } else if (focusTarget === 'arbiter') {
      focusPos = { row: 2, col: 2 + arbiterPos };
    } else if (focusTarget === 'demon' && demonCount > 0) {
      // Focus first demon (row 2, col 6)
      focusPos = { row: 2, col: 6 };
    }

    // Create and render unified scene
    const scene = createUnifiedScene(arbiterPos, demonCount, focusTarget);
    const rendered = renderScene(tileset, grassPixels, scene, focusTarget, focusPos);
    process.stdout.write(rendered);

    // Footer
    const focusStr = focusTarget ? `Focus: ${focusTarget}` : 'Focus: none';
    console.log(`\n  Arbiter pos: ${arbiterPos} | Demons: ${demonCount} | ${focusStr.padEnd(15)} | Frame: ${frameCount}`);
    console.log('  7x6 tiles = 112 chars × 48 rows                                        ');

    // Update animation state
    if (pauseFrames > 0) {
      pauseFrames--;

      // Spawn demons while at spellbook
      if (arbiterPos === 2 && demonCount < 5 && pauseFrames % 2 === 0) {
        demonCount++;
      }

      // Cycle focus while paused
      if (arbiterPos === 0) {
        // At human - alternate focus between human and arbiter
        focusTarget = pauseFrames % 4 < 2 ? 'human' : 'arbiter';
      } else if (arbiterPos === 2) {
        // At spellbook - cycle through arbiter and demons
        if (demonCount === 0) {
          focusTarget = 'arbiter';
        } else {
          focusTarget = pauseFrames % 4 < 2 ? 'arbiter' : 'demon';
        }
      }
      return;
    }

    // Walking - no focus
    focusTarget = null;

    // Arbiter walks back and forth
    arbiterPos += walkingDirection;

    if (arbiterPos >= 2) {
      arbiterPos = 2;
      walkingDirection = -1;
      pauseFrames = 10; // Pause at spellbook to summon demons
      focusTarget = 'arbiter';
    } else if (arbiterPos <= 0) {
      arbiterPos = 0;
      walkingDirection = 1;
      pauseFrames = 5; // Pause to listen to human
      demonCount = 0; // Reset demons when returning to human
      focusTarget = 'human';
    }
  }

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);
    console.log('\n  Demo ended. Goodbye!\n');
    process.exit(0);
  });

  // Clear screen once at start
  process.stdout.write(CLEAR_SCREEN + CURSOR_HOME);

  // Start animation loop
  setInterval(animate, 500);

  // Run first frame immediately
  animate();
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR);
  console.error('Error:', err);
  process.exit(1);
});
