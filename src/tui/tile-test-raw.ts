#!/usr/bin/env npx ts-node
/**
 * Raw tile test - no blessed, direct console output
 * Tests if the terminal supports our color codes
 */

import sharp from 'sharp';
import path from 'path';

const TILE_SIZE = 16;
const TILES_PER_ROW = 10;
const TILESET_PATH = path.join(process.cwd(), 'assets/jerom_16x16.png');

interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

async function loadTileset(): Promise<{ width: number; height: number; data: Buffer }> {
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

/**
 * Downscale tile by sampling pixels at intervals (simple nearest-neighbor)
 */
function downscaleTile(pixels: RGB[][], targetSize: number): RGB[][] {
  const step = TILE_SIZE / targetSize; // e.g., 16/4 = 4
  const result: RGB[][] = [];

  for (let y = 0; y < targetSize; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < targetSize; x++) {
      // Sample from center of each block
      const srcY = Math.floor(y * step + step / 2);
      const srcX = Math.floor(x * step + step / 2);
      row.push(pixels[srcY][srcX]);
    }
    result.push(row);
  }
  return result;
}

const RESET = '\x1b[0m';

// True color
function tc(r: number, g: number, b: number, bg: boolean): string {
  return bg ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Render tile at any size using true color
 */
function renderTileTC(pixels: RGB[][], size: number): string[] {
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = pixels[y][x];
      const bot = pixels[y + 1]?.[x] || top;
      line += tc(top.r, top.g, top.b, true) + tc(bot.r, bot.g, bot.b, false) + '▄';
    }
    line += RESET;
    lines.push(line);
  }
  return lines;
}

/**
 * Composite foreground over background using alpha threshold
 */
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

async function main() {
  const tileset = await loadTileset();

  console.log('\n=== EXAMPLE SCENE (7x6 tiles at full 16x16 resolution) ===\n');
  console.log('112 chars wide × 48 rows tall\n');

  // Define a 7x6 scene using tile indices
  // Tile reference:
  //   50 = grass bare, 51 = grass sparse, 57 = pine tree, 58 = bare tree
  //   87 = campfire, 205 = arbiter, 220-229 = demons
  //   20-22, 30-32, 40-42 = fort pieces (3x3 super-tile)

  const scene = [
    [57,  50,  20,  21,  22,  50,  57],   // tree, grass, fort top row, grass, tree
    [50,  50,  30,  31,  32,  50,  58],   // grass, grass, fort mid row, grass, bare tree
    [50,  50,  40,  41,  42,  50,  50],   // grass, grass, fort bot row, grass, grass
    [57,  50,  50, 205,  50,  50,  50],   // tree, grass, grass, ARBITER, grass, grass, grass
    [50,  50, 220,  87, 221,  50,  57],   // grass, grass, demon, FIRE, demon, grass, tree
    [58,  50,  50,  50,  50,  50,  58],   // bare tree, grass all the way, bare tree
  ];

  const FULL_SIZE = 16;
  const CHAR_HEIGHT = 8;

  // Pre-load grass for compositing
  const grassPixels = extractTile(tileset.data, tileset.width, 50);

  // Pre-render all tiles
  const renderedScene: string[][][] = [];

  for (let row = 0; row < scene.length; row++) {
    const renderedRow: string[][] = [];
    for (let col = 0; col < scene[row].length; col++) {
      const tileIndex = scene[row][col];
      let pixels = extractTile(tileset.data, tileset.width, tileIndex);

      // Composite tiles >= 80 on grass
      if (tileIndex >= 80) {
        pixels = compositeTiles(pixels, grassPixels, 1);
      }

      renderedRow.push(renderTileTC(pixels, FULL_SIZE));
    }
    renderedScene.push(renderedRow);
  }

  // Print the scene
  for (let tileRow = 0; tileRow < scene.length; tileRow++) {
    for (let charRow = 0; charRow < CHAR_HEIGHT; charRow++) {
      for (let tileCol = 0; tileCol < scene[tileRow].length; tileCol++) {
        process.stdout.write(renderedScene[tileRow][tileCol][charRow]);
      }
      console.log();
    }
  }

  console.log('\nScene: 7×6 tiles = 112 chars × 48 rows');
  console.log('Fort(20-42), Arbiter(205), Fire(87), Demons(220-221), Trees(57,58), Grass(50)\n');
}

main().catch(console.error);
