/**
 * Sound effects module for the Arbiter TUI
 *
 * Provides simple fire-and-forget sound effect playback.
 * Uses play-sound package for cross-platform support (Linux, Mac, Windows).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playSound from 'play-sound';

// Get package root directory (works when installed globally or locally)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..'); // From dist/ to package root

// Create player instance
// play-sound auto-detects available audio players:
// - Mac: afplay
// - Linux: aplay, mpg123, mpg321, play, mplayer, etc.
// - Windows: powershell, cmdmp3
const player = playSound();

/**
 * Sound effect filename mappings
 */
export const SFX = {
  footstep: 'footstep.wav',
  jump: 'jump.wav',
  magic: 'magic.wav',
  death: 'death.wav',
  menuLeft: 'menu-left.wav',
  menuRight: 'menu-right.wav',
  menuSelect: 'menu-select.wav',
  quickNotice: 'quick-notice.wav',
} as const;

/**
 * Type for valid sound effect names
 */
export type SfxName = keyof typeof SFX;

/**
 * Play a sound effect by name
 *
 * Fire-and-forget: does not await, catches errors silently
 *
 * @param name - The name of the sound effect to play
 */
export function playSfx(name: SfxName): void {
  const filename = SFX[name];
  const filepath = path.join(PACKAGE_ROOT, 'sounds', filename);

  player.play(filepath, (err) => {
    if (err) {
      // Silently ignore errors - sound is non-critical
      // Uncomment below for debugging:
      // console.error(`Failed to play sound "${name}":`, err);
    }
  });
}
