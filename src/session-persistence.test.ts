import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSession,
  loadSession,
  type PersistedSession,
  saveSession,
} from './session-persistence.js';

// Mock the fs module
vi.mock('node:fs');
vi.mock('node:path');

describe('session-persistence', () => {
  const mockCwd = '/test/workspace';
  const mockSessionPath = '/test/workspace/.claude/.arbiter-session.json';
  const mockDirPath = '/test/workspace/.claude';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    vi.mocked(path.join).mockReturnValue(mockSessionPath);
    vi.mocked(path.dirname).mockReturnValue(mockDirPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveSession', () => {
    it('should create directory and save session data', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      saveSession('arbiter-123', 'orch-456', 2);

      expect(fs.existsSync).toHaveBeenCalledWith(mockDirPath);
      expect(fs.mkdirSync).toHaveBeenCalledWith(mockDirPath, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        mockSessionPath,
        expect.stringContaining('"arbiterSessionId": "arbiter-123"'),
        'utf-8',
      );
    });

    it('should not create directory if it already exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      saveSession('arbiter-123', null, null);

      expect(fs.existsSync).toHaveBeenCalledWith(mockDirPath);
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('should save session with null orchestrator values', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      saveSession('arbiter-789', null, null);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      expect(savedData.arbiterSessionId).toBe('arbiter-789');
      expect(savedData.orchestratorSessionId).toBeNull();
      expect(savedData.orchestratorNumber).toBeNull();
      expect(savedData.savedAt).toBeDefined();
    });

    it('should silently handle write errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Write error');
      });

      // Should not throw
      expect(() => saveSession('arbiter-123', null, null)).not.toThrow();
    });

    it('should include ISO timestamp in savedAt', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

      const beforeSave = new Date();
      saveSession('arbiter-123', 'orch-456', 1);
      const afterSave = new Date();

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);
      const savedTime = new Date(savedData.savedAt);

      expect(savedTime.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
      expect(savedTime.getTime()).toBeLessThanOrEqual(afterSave.getTime());
    });
  });

  describe('loadSession', () => {
    it('should return null if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = loadSession();

      expect(result).toBeNull();
      expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it('should load and return valid session data', () => {
      const sessionData: PersistedSession = {
        arbiterSessionId: 'arbiter-123',
        orchestratorSessionId: 'orch-456',
        orchestratorNumber: 2,
        savedAt: new Date().toISOString(),
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionData));

      const result = loadSession();

      expect(result).toEqual(sessionData);
    });

    it('should return null for stale session (>24 hours old)', () => {
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
      const sessionData: PersistedSession = {
        arbiterSessionId: 'arbiter-123',
        orchestratorSessionId: null,
        orchestratorNumber: null,
        savedAt: staleTime.toISOString(),
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionData));

      const result = loadSession();

      expect(result).toBeNull();
    });

    it('should return session at exactly 24 hours', () => {
      const exactlyOneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const sessionData: PersistedSession = {
        arbiterSessionId: 'arbiter-123',
        orchestratorSessionId: null,
        orchestratorNumber: null,
        savedAt: exactlyOneDayAgo.toISOString(),
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionData));

      const result = loadSession();

      // At exactly 24 hours, it should still be valid (not > 24 hours)
      expect(result).toEqual(sessionData);
    });

    it('should return null for session missing savedAt', () => {
      const sessionData = {
        arbiterSessionId: 'arbiter-123',
        orchestratorSessionId: null,
        orchestratorNumber: null,
        // savedAt is missing
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sessionData));

      const result = loadSession();

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

      const result = loadSession();

      expect(result).toBeNull();
    });

    it('should return null on read error', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = loadSession();

      expect(result).toBeNull();
    });
  });

  describe('clearSession', () => {
    it('should delete file if it exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockReturnValue(undefined);

      clearSession();

      expect(fs.existsSync).toHaveBeenCalledWith(mockSessionPath);
      expect(fs.unlinkSync).toHaveBeenCalledWith(mockSessionPath);
    });

    it('should not attempt delete if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      clearSession();

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should silently handle delete errors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.unlinkSync).mockImplementation(() => {
        throw new Error('Delete error');
      });

      // Should not throw
      expect(() => clearSession()).not.toThrow();
    });
  });
});
