import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PersistedSession {
  arbiterSessionId: string;
  orchestratorSessionId: string | null;
  orchestratorNumber: number | null;
  savedAt: string; // ISO timestamp
}

const SESSION_FILE = '.claude/.arbiter-session.json';

function getSessionFilePath(): string {
  return path.join(process.cwd(), SESSION_FILE);
}

export function saveSession(
  arbiterSessionId: string,
  orchestratorSessionId: string | null,
  orchestratorNumber: number | null,
): void {
  try {
    const sessionData: PersistedSession = {
      arbiterSessionId,
      orchestratorSessionId,
      orchestratorNumber,
      savedAt: new Date().toISOString(),
    };

    const filePath = getSessionFilePath();
    const dirPath = path.dirname(filePath);

    // Create .claude directory if it doesn't exist
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');
  } catch {
    // Silent on errors (best-effort save)
  }
}

export function loadSession(): PersistedSession | null {
  try {
    const filePath = getSessionFilePath();

    // Return null if file doesn't exist
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const session: PersistedSession = JSON.parse(content);

    // Validate savedAt exists and is not stale (more than 24 hours old)
    if (!session.savedAt) {
      return null;
    }

    const savedTime = new Date(session.savedAt).getTime();
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (now - savedTime > twentyFourHours) {
      return null;
    }

    return session;
  } catch {
    // Return null if file is invalid JSON or any other error
    return null;
  }
}

export function clearSession(): void {
  try {
    const filePath = getSessionFilePath();

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Silent on errors
  }
}
