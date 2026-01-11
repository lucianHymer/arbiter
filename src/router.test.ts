/**
 * Router Integration Tests
 *
 * Note: The Router class is tightly coupled to the Claude Agent SDK's `query()` function,
 * which returns an async generator. Full integration testing would require:
 * - Mocking the SDK's `query()` function with async generators
 * - Mocking message sequences (SDKMessage types)
 * - Mocking abort controllers and timers for watchdog behavior
 *
 * These tests cover what's feasible without deep SDK mocking:
 * - Type exports are correct
 * - Router can be instantiated with proper callbacks
 * - Basic structural validation
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type DebugLogEntry, Router, type RouterCallbacks } from './router.js';
import { type AppState, createInitialState } from './state.js';

// Mock the SDK query function to prevent actual API calls
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock session persistence to prevent file I/O
vi.mock('./session-persistence.js', () => ({
  saveSession: vi.fn(),
  loadSession: vi.fn(() => null),
  clearSession: vi.fn(),
}));

describe('router', () => {
  let state: AppState;
  let callbacks: RouterCallbacks;

  beforeEach(() => {
    state = createInitialState();

    // Create mock callbacks matching actual RouterCallbacks interface
    callbacks = {
      onHumanMessage: vi.fn(),
      onArbiterMessage: vi.fn(),
      onOrchestratorMessage: vi.fn(),
      onContextUpdate: vi.fn(),
      onToolUse: vi.fn(),
      onModeChange: vi.fn(),
      onDebugLog: vi.fn(),
    };
  });

  describe('Router instantiation', () => {
    it('should create a Router instance with state and callbacks', () => {
      const router = new Router(state, callbacks);
      expect(router).toBeInstanceOf(Router);
    });

    it('should have required public methods', () => {
      const router = new Router(state, callbacks);

      // Check that required methods exist
      expect(typeof router.start).toBe('function');
      expect(typeof router.stop).toBe('function');
      expect(typeof router.sendHumanMessage).toBe('function');
      expect(typeof router.resumeFromSavedSession).toBe('function');
    });
  });

  describe('Type exports', () => {
    it('should export RouterCallbacks type with correct structure', () => {
      // This test validates at compile time that the types are correct
      // Using vi.fn() satisfies both type checking and linting (no empty blocks)
      const validCallbacks: RouterCallbacks = {
        onHumanMessage: vi.fn(),
        onArbiterMessage: vi.fn(),
        onOrchestratorMessage: vi.fn(),
        onContextUpdate: vi.fn(),
        onToolUse: vi.fn(),
        onModeChange: vi.fn(),
      };

      expect(validCallbacks.onHumanMessage).toBeDefined();
      expect(validCallbacks.onArbiterMessage).toBeDefined();
      expect(validCallbacks.onOrchestratorMessage).toBeDefined();
      expect(validCallbacks.onContextUpdate).toBeDefined();
      expect(validCallbacks.onToolUse).toBeDefined();
      expect(validCallbacks.onModeChange).toBeDefined();
    });

    it('should export DebugLogEntry type', () => {
      const entry: DebugLogEntry = {
        type: 'message',
        speaker: 'arbiter',
        text: 'test content',
      };

      expect(entry.type).toBe('message');
      expect(entry.speaker).toBe('arbiter');
      expect(entry.text).toBe('test content');
    });
  });

  describe('Router.stop()', () => {
    it('should be safe to call stop on a router that was never started', async () => {
      const router = new Router(state, callbacks);

      // Should not throw
      await expect(router.stop()).resolves.toBeUndefined();
    });
  });
});
