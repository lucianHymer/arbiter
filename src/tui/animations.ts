// Animation utilities for the RPG-style TUI
// Manages frame timing, campfire animations, and loading indicators

import { CAMPFIRE_FRAMES, CAMPFIRE_IDLE_FRAMES } from './sprites.js';

/**
 * Animation state
 */
interface AnimationState {
  frame: number;
  isActive: boolean;
  lastUpdate: number;
}

// Global animation state
let globalState: AnimationState = {
  frame: 0,
  isActive: false,
  lastUpdate: Date.now(),
};

/**
 * Get current animation frame
 */
export function getAnimationFrame(): number {
  return globalState.frame;
}

/**
 * Advance the animation frame
 */
export function advanceAnimation(): void {
  globalState.frame = (globalState.frame + 1) % 4;
  globalState.lastUpdate = Date.now();
}

/**
 * Reset animation to frame 0
 */
export function resetAnimation(): void {
  globalState.frame = 0;
}

/**
 * Set whether the system is actively working
 */
export function setAnimationActive(active: boolean): void {
  globalState.isActive = active;
}

/**
 * Check if animation is active
 */
export function isAnimationActive(): boolean {
  return globalState.isActive;
}

/**
 * Get current campfire frame based on activity
 * Active = fast burning, Idle = slow embers
 */
export function getCampfireFrame(): string {
  if (globalState.isActive) {
    return CAMPFIRE_FRAMES[globalState.frame];
  } else {
    // Use idle frames (2 frames, slower cycle)
    return CAMPFIRE_IDLE_FRAMES[globalState.frame % 2];
  }
}

/**
 * Get animated loading dots
 * Cycles: "." -> ".." -> "..." -> ".."
 */
export function getAnimatedDots(): string {
  const patterns = ['.', '..', '...', '..'];
  return patterns[globalState.frame];
}

/**
 * Get animated status text for waiting states
 */
export function getWaitingText(waitingFor: 'arbiter' | 'orchestrator'): string {
  const dots = getAnimatedDots();
  if (waitingFor === 'arbiter') {
    return `Awaiting the Arbiter${dots}`;
  } else {
    return `The conjurings work${dots}`;
  }
}

/**
 * Get wizard gem animation frame
 * Makes the gems on active wizards sparkle
 */
export function getWizardGemFrame(): number {
  return globalState.frame;
}

/**
 * Get arbiter position based on mode
 * Returns x position (0 = left side, 1 = right side)
 */
export function getArbiterPosition(mode: 'human_to_arbiter' | 'arbiter_to_orchestrator'): 'left' | 'right' {
  if (mode === 'human_to_arbiter') {
    return 'left';
  } else {
    return 'right';
  }
}

/**
 * Animation timer helper for blessed
 */
export class AnimationTimer {
  private interval: ReturnType<typeof setInterval> | null = null;
  private callback: () => void;
  private intervalMs: number;

  constructor(callback: () => void, intervalMs: number = 300) {
    this.callback = callback;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      advanceAnimation();
      this.callback();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  setActive(active: boolean): void {
    setAnimationActive(active);
  }

  isRunning(): boolean {
    return this.interval !== null;
  }
}
