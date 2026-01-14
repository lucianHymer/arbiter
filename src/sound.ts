/**
 * Sound effects module for the Arbiter TUI
 *
 * Provides simple fire-and-forget sound effect playback.
 * Uses play-sound package for cross-platform support (Linux, Mac, Windows).
 */

import type { ChildProcess } from 'node:child_process';
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
 * Sound state - controls whether audio plays
 */
const soundState = {
  musicEnabled: true,
  sfxEnabled: true,
};

/**
 * Currently playing music process (for stopping/looping)
 */
let currentMusicProcess: ChildProcess | null = null;
let musicShouldLoop = false;

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
  if (!soundState.sfxEnabled) return;

  const filename = SFX[name];
  const filepath = path.join(PACKAGE_ROOT, 'assets', 'sounds', filename);

  player.play(filepath, (err) => {
    if (err) {
      // Silently ignore errors - sound is non-critical
      // Uncomment below for debugging:
      // console.error(`Failed to play sound "${name}":`, err);
    }
  });
}

/**
 * Music filename
 */
const MUSIC_FILE = 'arbiter_theme.wav';

/**
 * Start playing background music (loops until stopped)
 */
export function startMusic(): void {
  if (!soundState.musicEnabled) return;
  if (currentMusicProcess) return; // Already playing

  musicShouldLoop = true;
  playMusicTrack();
}

/**
 * Internal: play the music track once, restart if looping
 */
function playMusicTrack(): void {
  if (!musicShouldLoop || !soundState.musicEnabled) return;

  const filepath = path.join(PACKAGE_ROOT, 'assets', 'sounds', MUSIC_FILE);

  currentMusicProcess = player.play(filepath, (err) => {
    currentMusicProcess = null;
    // If we should still be looping and music is enabled, restart
    if (musicShouldLoop && soundState.musicEnabled) {
      playMusicTrack();
    }
  }) as ChildProcess;
}

/**
 * Stop background music
 */
export function stopMusic(): void {
  musicShouldLoop = false;
  if (currentMusicProcess) {
    currentMusicProcess.kill();
    currentMusicProcess = null;
  }
}

/**
 * Toggle music on/off
 * @returns new state
 */
export function toggleMusic(): boolean {
  soundState.musicEnabled = !soundState.musicEnabled;
  if (soundState.musicEnabled) {
    // Resume music if it was playing before
    if (musicShouldLoop) {
      playMusicTrack();
    }
  } else {
    // Stop current playback but remember we should loop
    if (currentMusicProcess) {
      currentMusicProcess.kill();
      currentMusicProcess = null;
    }
  }
  return soundState.musicEnabled;
}

/**
 * Toggle sound effects on/off
 * @returns new state
 */
export function toggleSfx(): boolean {
  soundState.sfxEnabled = !soundState.sfxEnabled;
  return soundState.sfxEnabled;
}

/**
 * Get current music enabled state
 */
export function isMusicEnabled(): boolean {
  return soundState.musicEnabled;
}

/**
 * Get current sfx enabled state
 */
export function isSfxEnabled(): boolean {
  return soundState.sfxEnabled;
}
