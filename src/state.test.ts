import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppState,
  addMessage,
  clearCurrentOrchestrator,
  createInitialState,
  setCurrentOrchestrator,
  toRoman,
  updateArbiterContext,
  updateOrchestratorContext,
  updateOrchestratorTool,
} from './state.js';

describe('state', () => {
  describe('createInitialState', () => {
    it('should create state with default values', () => {
      const state = createInitialState();

      expect(state.arbiterSessionId).toBeNull();
      expect(state.arbiterContextPercent).toBe(0);
      expect(state.currentOrchestrator).toBeNull();
      expect(state.conversationLog).toEqual([]);
      expect(state.requirementsPath).toBeNull();
    });

    it('should create independent state objects', () => {
      const state1 = createInitialState();
      const state2 = createInitialState();

      state1.arbiterContextPercent = 50;
      expect(state2.arbiterContextPercent).toBe(0);
    });
  });

  describe('updateArbiterContext', () => {
    let state: AppState;

    beforeEach(() => {
      state = createInitialState();
    });

    it('should update arbiter context percentage', () => {
      updateArbiterContext(state, 50);
      expect(state.arbiterContextPercent).toBe(50);
    });

    it('should allow 0 percent', () => {
      updateArbiterContext(state, 0);
      expect(state.arbiterContextPercent).toBe(0);
    });

    it('should allow 100 percent', () => {
      updateArbiterContext(state, 100);
      expect(state.arbiterContextPercent).toBe(100);
    });
  });

  describe('updateOrchestratorContext', () => {
    let state: AppState;

    beforeEach(() => {
      state = createInitialState();
    });

    it('should do nothing when no orchestrator is set', () => {
      updateOrchestratorContext(state, 50);
      expect(state.currentOrchestrator).toBeNull();
    });

    it('should update orchestrator context when one exists', () => {
      setCurrentOrchestrator(state, { id: 'test-id', sessionId: 'session-1', number: 1 });
      updateOrchestratorContext(state, 75);
      expect(state.currentOrchestrator?.contextPercent).toBe(75);
    });
  });

  describe('setCurrentOrchestrator', () => {
    let state: AppState;

    beforeEach(() => {
      state = createInitialState();
    });

    it('should set orchestrator with provided values', () => {
      setCurrentOrchestrator(state, { id: 'orch-123', sessionId: 'sess-456', number: 2 });

      expect(state.currentOrchestrator).toEqual({
        id: 'orch-123',
        sessionId: 'sess-456',
        number: 2,
        contextPercent: 0,
        currentTool: null,
        toolCallCount: 0,
      });
    });

    it('should replace existing orchestrator', () => {
      setCurrentOrchestrator(state, { id: 'first', sessionId: 'sess-1', number: 1 });
      setCurrentOrchestrator(state, { id: 'second', sessionId: 'sess-2', number: 2 });

      expect(state.currentOrchestrator?.id).toBe('second');
      expect(state.currentOrchestrator?.number).toBe(2);
    });
  });

  describe('clearCurrentOrchestrator', () => {
    let state: AppState;

    beforeEach(() => {
      state = createInitialState();
    });

    it('should clear orchestrator when one exists', () => {
      setCurrentOrchestrator(state, { id: 'test', sessionId: 'sess', number: 1 });
      clearCurrentOrchestrator(state);
      expect(state.currentOrchestrator).toBeNull();
    });

    it('should be safe to call when no orchestrator exists', () => {
      clearCurrentOrchestrator(state);
      expect(state.currentOrchestrator).toBeNull();
    });
  });

  describe('addMessage', () => {
    let state: AppState;

    beforeEach(() => {
      state = createInitialState();
    });

    it('should add message to empty conversation log', () => {
      addMessage(state, 'human', 'Hello');
      expect(state.conversationLog).toHaveLength(1);
      expect(state.conversationLog[0].speaker).toBe('human');
      expect(state.conversationLog[0].text).toBe('Hello');
      expect(state.conversationLog[0].timestamp).toBeInstanceOf(Date);
    });

    it('should add multiple messages in order', () => {
      addMessage(state, 'human', 'First');
      addMessage(state, 'arbiter', 'Second');
      addMessage(state, 'Orchestrator I', 'Third');

      expect(state.conversationLog).toHaveLength(3);
      expect(state.conversationLog[0].speaker).toBe('human');
      expect(state.conversationLog[1].speaker).toBe('arbiter');
      expect(state.conversationLog[2].speaker).toBe('Orchestrator I');
    });

    it('should accept any string as speaker', () => {
      addMessage(state, 'Orchestrator II', 'Test');
      expect(state.conversationLog[0].speaker).toBe('Orchestrator II');
    });
  });

  describe('updateOrchestratorTool', () => {
    let state: AppState;

    beforeEach(() => {
      state = createInitialState();
    });

    it('should do nothing when no orchestrator is set', () => {
      updateOrchestratorTool(state, 'Edit', 5);
      expect(state.currentOrchestrator).toBeNull();
    });

    it('should update tool info when orchestrator exists', () => {
      setCurrentOrchestrator(state, { id: 'test', sessionId: 'sess', number: 1 });
      updateOrchestratorTool(state, 'Read', 10);

      expect(state.currentOrchestrator?.currentTool).toBe('Read');
      expect(state.currentOrchestrator?.toolCallCount).toBe(10);
    });

    it('should allow null tool', () => {
      setCurrentOrchestrator(state, { id: 'test', sessionId: 'sess', number: 1 });
      updateOrchestratorTool(state, 'Edit', 5);
      updateOrchestratorTool(state, null, 0);

      expect(state.currentOrchestrator?.currentTool).toBeNull();
      expect(state.currentOrchestrator?.toolCallCount).toBe(0);
    });
  });

  describe('toRoman', () => {
    it('should convert basic numbers', () => {
      expect(toRoman(1)).toBe('I');
      expect(toRoman(5)).toBe('V');
      expect(toRoman(10)).toBe('X');
      expect(toRoman(50)).toBe('L');
      expect(toRoman(100)).toBe('C');
      expect(toRoman(500)).toBe('D');
      expect(toRoman(1000)).toBe('M');
    });

    it('should convert subtractive notation numbers', () => {
      expect(toRoman(4)).toBe('IV');
      expect(toRoman(9)).toBe('IX');
      expect(toRoman(40)).toBe('XL');
      expect(toRoman(90)).toBe('XC');
      expect(toRoman(400)).toBe('CD');
      expect(toRoman(900)).toBe('CM');
    });

    it('should convert complex numbers', () => {
      expect(toRoman(2)).toBe('II');
      expect(toRoman(3)).toBe('III');
      expect(toRoman(14)).toBe('XIV');
      expect(toRoman(39)).toBe('XXXIX');
      expect(toRoman(246)).toBe('CCXLVI');
      expect(toRoman(789)).toBe('DCCLXXXIX');
      expect(toRoman(2421)).toBe('MMCDXXI');
      expect(toRoman(3999)).toBe('MMMCMXCIX');
    });

    it('should throw for numbers less than 1', () => {
      expect(() => toRoman(0)).toThrow('Number must be between 1 and 3999');
      expect(() => toRoman(-1)).toThrow('Number must be between 1 and 3999');
    });

    it('should throw for numbers greater than 3999', () => {
      expect(() => toRoman(4000)).toThrow('Number must be between 1 and 3999');
      expect(() => toRoman(10000)).toThrow('Number must be between 1 and 3999');
    });
  });
});
