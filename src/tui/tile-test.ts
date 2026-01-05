#!/usr/bin/env npx ts-node
/**
 * Tile Renderer Proof of Concept
 *
 * Tests:
 * 1. Loading the tileset with sharp
 * 2. Rendering tiles using half-block technique
 * 3. Displaying in a blessed panel
 *
 * Run with: npx ts-node src/tui/tile-test.ts
 */

import blessed from 'blessed';
import sharp from 'sharp';
import path from 'path';

// Tileset config
const TILE_SIZE = 16;
const TILES_PER_ROW = 10;
const TILESET_PATH = path.join(process.cwd(), 'assets/jerom_16x16.png');

// Some tile indices from the plan
const TILES = {
  GRASS_BARE: 50,
  GRASS_SPARSE: 51,
  PINE_TREE: 57,
  CAMPFIRE: 87,
  ARBITER: 205,
  DEMON_1: 220,
};

interface RGB {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Load tileset and extract raw pixel data
 */
async function loadTileset(): Promise<{ width: number; height: number; data: Buffer }> {
  const image = sharp(TILESET_PATH);
  const metadata = await image.metadata();
  const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  return {
    width: info.width,
    height: info.height,
    data,
  };
}

/**
 * Get pixel color at x,y from the tileset
 */
function getPixel(
  data: Buffer,
  width: number,
  x: number,
  y: number
): RGB {
  const idx = (y * width + x) * 4;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
    a: data[idx + 3],
  };
}

/**
 * Extract a single tile's pixels
 */
function extractTile(
  data: Buffer,
  width: number,
  tileIndex: number
): RGB[][] {
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
 * Convert RGB to ANSI 256-color code
 * Uses the 6x6x6 color cube (codes 16-231)
 */
function rgbToAnsi256(r: number, g: number, b: number): number {
  // Map 0-255 to 0-5 for the color cube
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + (36 * ri) + (6 * gi) + bi;
}

/**
 * Convert RGB to hex string for blessed
 */
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * ANSI true color escape codes (24-bit)
 */
function ansiTrueColorFg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function ansiTrueColorBg(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * ANSI 256-color escape codes
 */
function ansi256Fg(r: number, g: number, b: number): string {
  const code = rgbToAnsi256(r, g, b);
  return `\x1b[38;5;${code}m`;
}

function ansi256Bg(r: number, g: number, b: number): string {
  const code = rgbToAnsi256(r, g, b);
  return `\x1b[48;5;${code}m`;
}

const ANSI_RESET = '\x1b[0m';

/**
 * Downscale a tile by averaging pixel blocks
 * @param pixels - Original 16x16 pixels
 * @param scale - Target size (4 = 4x4, 8 = 8x8, 16 = no scaling)
 */
function downscaleTile(pixels: RGB[][], scale: number): RGB[][] {
  if (scale >= TILE_SIZE) return pixels;

  const blockSize = TILE_SIZE / scale;
  const result: RGB[][] = [];

  for (let y = 0; y < scale; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < scale; x++) {
      // Average the pixels in this block
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let dy = 0; dy < blockSize; dy++) {
        for (let dx = 0; dx < blockSize; dx++) {
          const pixel = pixels[y * blockSize + dy][x * blockSize + dx];
          r += pixel.r;
          g += pixel.g;
          b += pixel.b;
          a += pixel.a;
          count++;
        }
      }
      row.push({
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count),
        a: Math.round(a / count),
      });
    }
    result.push(row);
  }

  return result;
}

/**
 * Render a tile using half-block technique
 * Returns array of strings (one per terminal row)
 * @param pixels - Pixel array (can be any size)
 * @param size - The pixel dimensions (e.g., 16, 8, 4)
 */
function renderTileHalfBlock(pixels: RGB[][], size: number = TILE_SIZE): string[] {
  const lines: string[] = [];

  // Process 2 rows of pixels at a time
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const topPixel = pixels[y][x];
      const bottomPixel = pixels[y + 1]?.[x] || topPixel;

      // Check if pixel is "transparent" - either by alpha OR by being a known bg color
      // Many tilesets use magenta (255,0,255) or specific colors as transparency key
      const isTransparent = (p: RGB) => {
        if (p.a < 32) return true; // Very transparent
        // Check for common transparency key colors (magenta, bright green)
        if (p.r > 250 && p.g < 5 && p.b > 250) return true; // Magenta
        if (p.r < 5 && p.g > 250 && p.b < 5) return true; // Bright green
        return false;
      };

      const topTransparent = isTransparent(topPixel);
      const bottomTransparent = isTransparent(bottomPixel);

      // Skip if both transparent
      if (topTransparent && bottomTransparent) {
        line += ' ';
        continue;
      }

      // Use half-block: background = top, foreground = bottom
      const topHex = rgbToHex(topPixel.r, topPixel.g, topPixel.b);
      const bottomHex = rgbToHex(bottomPixel.r, bottomPixel.g, bottomPixel.b);

      if (topTransparent) {
        // Only bottom pixel visible
        line += `{${bottomHex}-fg}▄{/${bottomHex}-fg}`;
      } else if (bottomTransparent) {
        // Only top pixel visible
        line += `{${topHex}-fg}▀{/${topHex}-fg}`;
      } else {
        // Both pixels visible - use ▄ with bg=top, fg=bottom
        line += `{${topHex}-bg}{${bottomHex}-fg}▄{/${bottomHex}-fg}{/${topHex}-bg}`;
      }
    }
    lines.push(line);
  }

  return lines;
}

// Alpha threshold - will be set per render
let ALPHA_THRESHOLD = 32;

/**
 * Render tile with a specific alpha threshold
 */
function renderTileWithAlpha(pixels: RGB[][], size: number, alphaThreshold: number): string[] {
  const lines: string[] = [];

  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const topPixel = pixels[y][x];
      const bottomPixel = pixels[y + 1]?.[x] || topPixel;

      const topTransparent = topPixel.a < alphaThreshold;
      const bottomTransparent = bottomPixel.a < alphaThreshold;

      if (topTransparent && bottomTransparent) {
        line += ' ';
        continue;
      }

      const topHex = rgbToHex(topPixel.r, topPixel.g, topPixel.b);
      const bottomHex = rgbToHex(bottomPixel.r, bottomPixel.g, bottomPixel.b);

      if (topTransparent) {
        line += `{${bottomHex}-fg}▄{/${bottomHex}-fg}`;
      } else if (bottomTransparent) {
        line += `{${topHex}-fg}▀{/${topHex}-fg}`;
      } else {
        line += `{${topHex}-bg}{${bottomHex}-fg}▄{/${bottomHex}-fg}{/${topHex}-bg}`;
      }
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Composite foreground tile over background tile
 * Transparent pixels in fg show bg pixels instead
 */
function compositeTiles(fg: RGB[][], bg: RGB[][], alphaThreshold: number): RGB[][] {
  const result: RGB[][] = [];
  const size = fg.length;

  for (let y = 0; y < size; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < size; x++) {
      const fgPixel = fg[y][x];
      const bgPixel = bg[y]?.[x] || { r: 0, g: 0, b: 0, a: 255 };

      if (fgPixel.a < alphaThreshold) {
        // Foreground is transparent, use background
        row.push(bgPixel);
      } else {
        // Foreground is opaque, use foreground
        row.push(fgPixel);
      }
    }
    result.push(row);
  }

  return result;
}

/**
 * Render composited tile using blessed tags (256 color)
 */
function renderCompositedTile(pixels: RGB[][], size: number): string[] {
  const lines: string[] = [];

  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const topPixel = pixels[y][x];
      const bottomPixel = pixels[y + 1]?.[x] || topPixel;

      const topHex = rgbToHex(topPixel.r, topPixel.g, topPixel.b);
      const bottomHex = rgbToHex(bottomPixel.r, bottomPixel.g, bottomPixel.b);

      line += `{${topHex}-bg}{${bottomHex}-fg}▄{/${bottomHex}-fg}{/${topHex}-bg}`;
    }
    lines.push(line);
  }

  return lines;
}

/**
 * Render composited tile using TRUE COLOR ANSI (24-bit)
 */
function renderCompositedTileTrueColor(pixels: RGB[][], size: number): string[] {
  const lines: string[] = [];

  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const topPixel = pixels[y][x];
      const bottomPixel = pixels[y + 1]?.[x] || topPixel;

      line += ansiTrueColorBg(topPixel.r, topPixel.g, topPixel.b);
      line += ansiTrueColorFg(bottomPixel.r, bottomPixel.g, bottomPixel.b);
      line += '▄';
    }
    line += ANSI_RESET;
    lines.push(line);
  }

  return lines;
}

/**
 * Render composited tile using 256-COLOR ANSI
 */
function renderCompositedTile256(pixels: RGB[][], size: number): string[] {
  const lines: string[] = [];

  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const topPixel = pixels[y][x];
      const bottomPixel = pixels[y + 1]?.[x] || topPixel;

      line += ansi256Bg(topPixel.r, topPixel.g, topPixel.b);
      line += ansi256Fg(bottomPixel.r, bottomPixel.g, bottomPixel.b);
      line += '▄';
    }
    line += ANSI_RESET;
    lines.push(line);
  }

  return lines;
}

/**
 * Main test function
 */
async function main() {
  console.log('Loading tileset...');
  const tileset = await loadTileset();
  console.log(`Tileset loaded: ${tileset.width}x${tileset.height}`);

  // Extract tiles
  const grassPixels = extractTile(tileset.data, tileset.width, TILES.GRASS_SPARSE);
  const firePixels = extractTile(tileset.data, tileset.width, TILES.CAMPFIRE);
  const demonPixels = extractTile(tileset.data, tileset.width, TILES.DEMON_1);
  const treePixels = extractTile(tileset.data, tileset.width, TILES.PINE_TREE);

  // Test different alpha thresholds with compositing
  const alphaValues = [0, 1, 5, 10, 20, 32, 50, 64, 100, 128];

  // Create blessed screen
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'Composite Test',
  });

  // Left panel - info
  const leftPanel = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '20%',
    height: '100%',
    content: `COMPOSITE TEST\n\nScreen: ${screen.width}x${screen.height}\n\nTiles rendered\nON TOP of grass.\n\nTransparent pixels\nshow grass below.\n\nPress Q to quit`,
    tags: true,
    border: { type: 'line' },
    style: {
      fg: 'white',
      border: { fg: 'cyan' },
    },
  });

  // Right panel - tags: false to allow raw ANSI passthrough
  const rightPanel = blessed.box({
    parent: screen,
    top: 0,
    left: '20%',
    width: '80%',
    height: '100%',
    content: '',
    tags: false,  // Disable blessed tags, use raw ANSI
    scrollable: true,
    border: { type: 'line' },
    style: {
      fg: 'white',
      border: { fg: 'yellow' },
    },
  });

  const tileHeight = 8;

  // Extract GRASS_BARE (tile 50) as the solid background
  const grassBarePixels = extractTile(tileset.data, tileset.width, TILES.GRASS_BARE);

  // Composited with alpha<1
  const fireOnGrass = compositeTiles(firePixels, grassBarePixels, 1);
  const demonOnGrass = compositeTiles(demonPixels, grassBarePixels, 1);
  const treeOnGrass = compositeTiles(treePixels, grassBarePixels, 1);

  const fogTC = renderCompositedTileTrueColor(fireOnGrass, 16);
  const dogTC = renderCompositedTileTrueColor(demonOnGrass, 16);
  const togTC = renderCompositedTileTrueColor(treeOnGrass, 16);

  const grassTC = renderCompositedTileTrueColor(grassBarePixels, 16);
  const fireTC = renderCompositedTileTrueColor(firePixels, 16);
  const demonTC = renderCompositedTileTrueColor(demonPixels, 16);

  // Function to render tiles directly to stdout
  const renderTiles = () => {
    const startX = Math.floor((screen.width as number) * 0.2) + 2;
    const startY = 2;

    // Use raw stdout writes with cursor positioning
    const CSI = '\x1b[';

    // Move cursor and write
    const writeAt = (y: number, x: number, str: string) => {
      process.stdout.write(`${CSI}${y};${x}H${str}`);
    };

    writeAt(startY, startX, 'FIRE+GRASS      DEMON+GRASS     TREE+GRASS');

    for (let row = 0; row < tileHeight; row++) {
      writeAt(startY + 2 + row, startX, fogTC[row] + '  ' + dogTC[row] + '  ' + togTC[row]);
    }

    writeAt(startY + 12, startX, 'GRASS RAW       FIRE RAW        DEMON RAW');

    for (let row = 0; row < tileHeight; row++) {
      writeAt(startY + 14 + row, startX, grassTC[row] + '  ' + fireTC[row] + '  ' + demonTC[row]);
    }
  };

  // Set placeholder in blessed
  rightPanel.setContent('');
  screen.render();

  // Render tiles after blessed is done
  setTimeout(renderTiles, 100);

  // Quit handler
  screen.key(['q', 'C-c', 'escape'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.render();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
