// Logbook - Log overlay with summary/debug modes and file logging
// Shows timestamped entries for messages, tools, context, mode changes, and system events

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Log entry interface for all loggable events
 */
export interface LogEntry {
  timestamp: Date;
  type: 'message' | 'tool' | 'context' | 'mode' | 'system' | 'sdk';
  speaker?: string;  // human, arbiter, Conjuring I, etc.
  text: string;
  details?: any;  // extra data for debug mode
  filtered?: boolean;  // True if this was filtered from main chat view
  agent?: 'arbiter' | 'orchestrator';  // Which SDK agent this came from
  sessionId?: string;  // SDK session ID
}

/**
 * Formats a Date to "[HH:MM:SS]" format
 * @param date - The date to format
 * @returns Formatted timestamp string like "[12:34:01]"
 */
export function formatTimestamp(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `[${hours}:${minutes}:${seconds}]`;
}

/**
 * Logbook class for managing log entries with two view modes
 * Supports summary view (messages only) and debug view (everything)
 * Also writes all entries to a log file
 */
export class Logbook {
  private entries: LogEntry[] = [];
  private mode: 'summary' | 'debug' = 'summary';
  private logFilePath: string;
  private fileHandle: number | null = null;

  /**
   * Creates a new Logbook instance
   * @param logFilePath - Path to the log file (default: './arbiter.log' or temp directory)
   */
  constructor(logFilePath?: string) {
    if (logFilePath) {
      this.logFilePath = logFilePath;
    } else {
      // Default to ./arbiter.log, fallback to temp directory if not writable
      const defaultPath = './arbiter.log';
      try {
        // Test if we can write to the current directory
        fs.accessSync('.', fs.constants.W_OK);
        this.logFilePath = defaultPath;
      } catch {
        // Fallback to temp directory
        this.logFilePath = path.join(os.tmpdir(), 'arbiter.log');
      }
    }

    // Initialize log file (overwrite each session)
    this.initializeLogFile();
  }

  /**
   * Initializes the log file for writing
   */
  private initializeLogFile(): void {
    try {
      // Open file for writing (truncate if exists)
      this.fileHandle = fs.openSync(this.logFilePath, 'w');
      // Write session header
      const header = `=== Arbiter Session Started: ${new Date().toISOString()} ===\n\n`;
      fs.writeSync(this.fileHandle, header);
    } catch (error) {
      // If we can't open the file, log to console and continue without file logging
      console.error(`Warning: Could not open log file at ${this.logFilePath}:`, error);
      this.fileHandle = null;
    }
  }

  /**
   * Writes a log entry to the file
   * @param entry - The log entry to write
   */
  private writeToFile(entry: LogEntry): void {
    if (this.fileHandle === null) return;

    try {
      // Format entry in debug view style for file
      const line = this.formatEntryForDebug(entry) + '\n';
      fs.writeSync(this.fileHandle, line);
    } catch (error) {
      // Silently fail if write fails
    }
  }

  /**
   * Formats a single entry for debug view
   * @param entry - The log entry to format
   * @returns Formatted string for debug view
   */
  private formatEntryForDebug(entry: LogEntry): string {
    const ts = formatTimestamp(entry.timestamp);
    const filteredMark = entry.filtered ? ' [FILTERED]' : '';

    switch (entry.type) {
      case 'message':
        return `${ts} ${entry.speaker}: ${entry.text}${filteredMark}`;
      case 'tool':
        const toolSpeaker = entry.speaker ? `${entry.speaker}: ` : '';
        return `${ts} ${toolSpeaker}[Tool] ${entry.text}`;
      case 'context':
        return `${ts} [Context] ${entry.text}`;
      case 'mode':
        return `${ts} [Mode] ${entry.text}`;
      case 'system':
        const detailsStr = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
        return `${ts} [System] ${entry.text}${detailsStr}`;
      case 'sdk':
        const agentLabel = entry.agent ? `[${entry.agent.toUpperCase()}]` : '[SDK]';
        const sessionLabel = entry.sessionId ? ` (${entry.sessionId.substring(0, 8)}...)` : '';
        return `${ts} ${agentLabel}${sessionLabel} ${entry.text}`;
      default:
        return `${ts} ${entry.text}`;
    }
  }

  /**
   * Formats a single entry for summary view
   * @param entry - The log entry to format
   * @returns Formatted string for summary view, or null if not shown in summary
   */
  private formatEntryForSummary(entry: LogEntry): string | null {
    if (entry.type !== 'message') return null;

    const ts = formatTimestamp(entry.timestamp);
    const speaker = this.formatSpeakerName(entry.speaker || 'unknown');
    return `${ts} ${speaker}: ${entry.text}`;
  }

  /**
   * Formats speaker name for display
   * @param speaker - Raw speaker identifier
   * @returns Formatted speaker name
   */
  private formatSpeakerName(speaker: string): string {
    switch (speaker) {
      case 'human':
        return 'You';
      case 'arbiter':
        return 'Arbiter';
      default:
        return speaker;
    }
  }

  /**
   * Adds a message entry to the log
   * @param speaker - Who is speaking (human, arbiter, Conjuring I, etc.)
   * @param text - The message text
   * @param filtered - Whether this message was filtered from main chat view
   */
  addMessage(speaker: string, text: string, filtered: boolean = false): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'message',
      speaker,
      text,
      filtered,
    };
    this.entries.push(entry);
    this.writeToFile(entry);
  }

  /**
   * Adds a tool use entry to the log
   * @param tool - The tool name
   * @param count - The number of times the tool has been used
   * @param speaker - Optional speaker (e.g., "Conjuring I")
   */
  addToolUse(tool: string, count: number, speaker?: string): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'tool',
      speaker,
      text: `${tool} (${count})`,
      details: { tool, count },
    };
    this.entries.push(entry);
    this.writeToFile(entry);
  }

  /**
   * Adds a context update entry to the log
   * @param arbiter - Arbiter context percentage
   * @param orchestrator - Orchestrator context percentage, or null if none active
   */
  addContextUpdate(arbiter: number, orchestrator: number | null): void {
    const orchStr = orchestrator !== null ? `${orchestrator}%` : 'null';
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'context',
      text: `arbiter=${arbiter}% orchestrator=${orchStr}`,
      details: { arbiter, orchestrator },
    };
    this.entries.push(entry);
    this.writeToFile(entry);
  }

  /**
   * Adds a mode change entry to the log
   * @param mode - Description of the mode change (e.g., "human_to_arbiter -> arbiter_to_orchestrator")
   */
  addModeChange(mode: string): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'mode',
      text: mode,
    };
    this.entries.push(entry);
    this.writeToFile(entry);
  }

  /**
   * Adds a system event entry to the log
   * @param event - Description of the system event
   * @param details - Optional additional details
   */
  addSystemEvent(event: string, details?: any): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'system',
      text: event,
      details,
    };
    this.entries.push(entry);
    this.writeToFile(entry);
  }

  /**
   * Adds a raw SDK message entry to the log
   * @param agent - Which agent this came from ('arbiter' or 'orchestrator')
   * @param messageType - The SDK message type (system, assistant, user, result)
   * @param content - Formatted string representation of the message
   * @param sessionId - Optional session ID
   * @param details - Optional full message details for deep inspection
   */
  addSdkMessage(
    agent: 'arbiter' | 'orchestrator',
    messageType: string,
    content: string,
    sessionId?: string,
    details?: any
  ): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      type: 'sdk',
      agent,
      sessionId,
      text: `[${messageType}] ${content}`,
      details,
    };
    this.entries.push(entry);
    this.writeToFile(entry);
  }

  /**
   * Gets all log entries
   * @returns Array of all log entries
   */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Gets the summary view of the log (messages only with timestamps)
   * @returns Array of formatted strings for summary view
   */
  getSummaryView(): string[] {
    return this.entries
      .map(entry => this.formatEntryForSummary(entry))
      .filter((line): line is string => line !== null);
  }

  /**
   * Gets the debug view of the log (everything with full details)
   * @returns Array of formatted strings for debug view
   */
  getDebugView(): string[] {
    return this.entries.map(entry => this.formatEntryForDebug(entry));
  }

  /**
   * Gets the current view based on the current mode
   * @returns Array of formatted strings for the current view mode
   */
  getCurrentView(): string[] {
    return this.mode === 'summary' ? this.getSummaryView() : this.getDebugView();
  }

  /**
   * Toggles between summary and debug modes
   */
  toggleMode(): void {
    this.mode = this.mode === 'summary' ? 'debug' : 'summary';
  }

  /**
   * Gets the current view mode
   * @returns Current mode ('summary' or 'debug')
   */
  getMode(): 'summary' | 'debug' {
    return this.mode;
  }

  /**
   * Forces a flush of any buffered writes to the log file
   */
  flush(): void {
    if (this.fileHandle !== null) {
      try {
        fs.fsyncSync(this.fileHandle);
      } catch (error) {
        // Silently fail if sync fails
      }
    }
  }

  /**
   * Closes the log file handle
   * Should be called when the application is shutting down
   */
  close(): void {
    if (this.fileHandle !== null) {
      try {
        // Write session footer
        const footer = `\n=== Arbiter Session Ended: ${new Date().toISOString()} ===\n`;
        fs.writeSync(this.fileHandle, footer);
        fs.closeSync(this.fileHandle);
      } catch (error) {
        // Silently fail
      }
      this.fileHandle = null;
    }
  }
}
