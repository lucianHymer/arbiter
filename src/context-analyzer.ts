/**
 * Context Analyzer - Systematic SDK Context Usage Analysis
 *
 * This tool helps analyze how context window usage is tracked in the Claude Agent SDK.
 * It captures all usage data in a structured format for analysis.
 *
 * Usage:
 *   npm run analyze:context -- [options]
 *
 * Options:
 *   --subagents     Allow subagent usage (default: no subagents)
 *   --prompts N     Number of test prompts to send (default: 3)
 *   --output FILE   Output prefix for CSV/JSON files (default: context-analysis)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Types
// ============================================================================

/** SDK message structure (simplified for what we need in analysis) */
interface AnalyzerMessage {
  type: 'system' | 'user' | 'assistant' | 'result';
  uuid?: string;
  message?: {
    id?: string;
    content?: string | AnalyzerContentBlock[];
    usage?: UsageData;
  };
  subtype?: string;
  session_id?: string;
  result?: string;
}

interface AnalyzerContentBlock {
  type: string;
  text?: string;
}

/** Type guard for assistant messages with usage data */
function isAssistantMessage(msg: unknown): msg is AnalyzerMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type: unknown }).type === 'assistant'
  );
}

interface UsageData {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface MessageRow {
  seq: number;
  timestamp: string;
  elapsed_ms: number;
  message_id: string;
  uuid: string;
  type: string;
  subtype?: string;

  // Raw usage from this message
  cache_read: number;
  cache_create: number;
  input: number;
  output: number;

  // Running totals
  running_max_cache_read: number;
  running_sum_cache_create: number;
  running_sum_input: number;
  running_sum_output: number;

  // Calculated context (various formulas)
  formula_max_only: number;
  formula_max_plus_sums: number;
  formula_create_plus_sums: number;

  // Percentages
  pct_max_only: number;
  pct_max_plus_sums: number;
  pct_create_plus_sums: number;

  // API call count
  unique_api_calls: number;

  // Text preview
  text_preview: string;
}

interface ContextSnapshot {
  timestamp: string;
  elapsed_ms: number;
  label: string;

  // Parsed from /context output
  total_tokens: number;
  total_percent: number;
  messages_tokens: number;
  system_tokens: number;

  // Raw output for debugging
  raw_output: string;
}

interface AnalysisResult {
  session_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  cwd: string;
  used_subagents: boolean;

  // Context snapshots
  baseline: ContextSnapshot | null;
  final: ContextSnapshot | null;

  // Message data
  messages: MessageRow[];

  // Summary
  summary: {
    total_messages: number;
    unique_api_calls: number;
    final_max_cache_read: number;
    final_sum_cache_create: number;
    final_sum_input: number;
    final_sum_output: number;
    calculated_max_only: number;
    calculated_max_plus_sums: number;
    calculated_create_plus_sums: number;
    actual_total?: number;
    actual_messages?: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CONTEXT_TOKENS = 200_000;

const TEST_PROMPTS_NO_SUBAGENT = [
  "What is 2 + 2? Reply with just the number.",
  "What is the capital of France? Reply with just the city name.",
  "What color is the sky? Reply with just one word.",
  "Name three programming languages.",
  "What is the largest planet in our solar system?",
  "Explain what a variable is in programming in 2-3 sentences.",
  "What is the difference between a list and a dictionary in Python?",
  "Name the four cardinal directions.",
  "What does API stand for?",
  "Explain what recursion is in one paragraph.",
  "What is the time complexity of binary search?",
  "Name three popular JavaScript frameworks.",
];

const TEST_PROMPTS_WITH_SUBAGENT = [
  "Read the package.json file and tell me what dependencies this project has.",
  "Look at the src/router.ts file and summarize what it does in 2-3 sentences.",
  "Find all TypeScript files in the src directory and list them.",
  "Read the CLAUDE.md file and tell me what this project is about.",
  "Look at src/state.ts and explain the AppState interface.",
  "Search for any files that mention 'context' in their name.",
  "Read src/arbiter.ts and tell me what MCP tools are defined there.",
  "Find all files in .claude/knowledge directory.",
  "Look at the tsconfig.json and tell me the TypeScript target version.",
  "Search for 'spawn_orchestrator' in the codebase and tell me where it's used.",
  "Read src/orchestrator.ts and summarize its purpose.",
  "Find any test files in the project and list them.",
];

// ============================================================================
// Parsing Utilities
// ============================================================================

/**
 * Parse token count from string like "18.4k" or "3.1k" or "8" or "181.6k"
 */
function parseTokenCount(str: string): number {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, '').trim();
  if (cleaned.endsWith('k')) {
    return Math.round(parseFloat(cleaned.slice(0, -1)) * 1000);
  }
  return parseInt(cleaned) || 0;
}

/**
 * Parse /context command output to extract token counts
 * Handles the markdown table format:
 *   **Tokens:** 18.4k / 200.0k (9%)
 *   | System prompt | 3.1k | 1.6% |
 *   | Messages | 8 | 0.0% |
 */
function parseContextOutput(output: string): Partial<ContextSnapshot> {
  const result: Partial<ContextSnapshot> = {
    raw_output: output,
    total_tokens: 0,
    total_percent: 0,
    messages_tokens: 0,
    system_tokens: 0,
  };

  // Match total: **Tokens:** 18.4k / 200.0k (9%)
  const totalMatch = output.match(/\*\*Tokens:\*\*\s*([0-9,.]+k?)\s*\/\s*200\.?0?k\s*\((\d+)%\)/i);
  if (totalMatch) {
    result.total_tokens = parseTokenCount(totalMatch[1]);
    result.total_percent = parseFloat(totalMatch[2]);
  }

  // Parse markdown table rows: | Category | Tokens | Percentage |
  const tableRowRegex = /\|\s*([^|]+)\s*\|\s*([0-9,.]+k?)\s*\|\s*([0-9.]+)%\s*\|/g;
  let match;
  let systemTotal = 0;

  while ((match = tableRowRegex.exec(output)) !== null) {
    const category = match[1].trim().toLowerCase();
    const tokens = parseTokenCount(match[2]);

    if (category === 'messages') {
      result.messages_tokens = tokens;
    } else if (category === 'system prompt' || category === 'system tools' ||
               category === 'mcp tools' || category === 'memory' ||
               category === 'custom agents' || category === 'memory files') {
      systemTotal += tokens;
    }
  }

  if (systemTotal > 0) {
    result.system_tokens = systemTotal;
  } else if (result.total_tokens && result.messages_tokens) {
    // Infer system tokens (subtract messages and free space)
    result.system_tokens = result.total_tokens - result.messages_tokens;
  }

  return result;
}

/**
 * Extract text preview from SDK message
 */
function getTextPreview(message: AnalyzerMessage, maxLen: number = 100): string {
  try {
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (typeof content === 'string') {
        return content.slice(0, maxLen).replace(/\n/g, ' ');
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            return block.text.slice(0, maxLen).replace(/\n/g, ' ');
          }
        }
      }
    }
    if (message.type === 'user') {
      const content = (message as any).message?.content;
      if (typeof content === 'string') {
        return content.slice(0, maxLen).replace(/\n/g, ' ');
      }
    }
    if (message.type === 'result') {
      const subtype = (message as any).subtype;
      return `[result: ${subtype}]`;
    }
    if (message.type === 'system') {
      const subtype = (message as any).subtype;
      return `[system: ${subtype}]`;
    }
  } catch {
    // Ignore
  }
  return `[${message.type}]`;
}

// ============================================================================
// Core Analyzer
// ============================================================================

class ContextAnalyzer {
  private seenMsgIds = new Set<string>();
  private maxCacheRead = 0;
  private sumCacheCreate = 0;
  private sumInput = 0;
  private sumOutput = 0;

  private messages: MessageRow[] = [];
  private seq = 0;
  private startTime: number;
  private sessionId: string | null = null;

  constructor(private cwd: string, private useSubagents: boolean) {
    this.startTime = Date.now();
  }

  /**
   * Run /context command and parse the output
   * Uses the current session if available for accurate measurement
   */
  async runContextCommand(label: string): Promise<ContextSnapshot> {
    console.log(`\n[${label}] Running /context command...${this.sessionId ? ` (session: ${this.sessionId.slice(0, 8)}...)` : ' (new session)'}`);

    const options: any = {
      cwd: this.cwd,
      permissionMode: 'bypassPermissions',
    };

    // Resume existing session if we have one
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const q = query({
      prompt: '/context',
      options,
    });

    let rawOutput = '';

    for await (const msg of q) {
      // Capture session ID from system init
      if (msg.type === 'system') {
        const sysMsg = msg as any;
        if (sysMsg.subtype === 'init' && sysMsg.session_id) {
          this.sessionId = sysMsg.session_id;
        }
      }

      // /context output comes through in various ways
      if (msg.type === 'user') {
        const content = (msg as any).message?.content;
        if (typeof content === 'string') {
          rawOutput += content + '\n';
        }
      }
      if (msg.type === 'result') {
        const resultContent = (msg as any).result;
        if (typeof resultContent === 'string') {
          rawOutput += resultContent + '\n';
        }
      }
      // Also check for assistant messages that might contain the output
      if (msg.type === 'assistant') {
        const content = (msg as any).message?.content;
        if (typeof content === 'string' && content.includes('tokens')) {
          rawOutput += content + '\n';
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text?.includes('tokens')) {
              rawOutput += block.text + '\n';
            }
          }
        }
      }
    }

    const parsed = parseContextOutput(rawOutput);
    const snapshot: ContextSnapshot = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      label,
      total_tokens: parsed.total_tokens || 0,
      total_percent: parsed.total_percent || 0,
      messages_tokens: parsed.messages_tokens || 0,
      system_tokens: parsed.system_tokens || 0,
      raw_output: rawOutput.trim(),
    };

    console.log(`[${label}] Total: ${snapshot.total_tokens} tokens (${snapshot.total_percent}%)`);
    console.log(`[${label}] Messages: ${snapshot.messages_tokens}, System: ${snapshot.system_tokens}`);

    return snapshot;
  }

  /**
   * Process a single SDK message and record usage data
   */
  processMessage(msg: AnalyzerMessage): MessageRow | null {
    // Only process assistant messages for usage data
    if (msg.type !== 'assistant') {
      return null;
    }

    const assistantMsg = msg as any;
    const usage = assistantMsg.message?.usage as UsageData | undefined;
    const msgId = assistantMsg.message?.id as string | undefined;
    const uuid = assistantMsg.uuid as string;

    if (!usage || !msgId) {
      return null;
    }

    // Dedupe by message.id (NOT uuid)
    if (this.seenMsgIds.has(msgId)) {
      return null;
    }
    this.seenMsgIds.add(msgId);

    // Extract raw values
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;

    // Update running totals
    this.maxCacheRead = Math.max(this.maxCacheRead, cacheRead);
    this.sumCacheCreate += cacheCreate;
    this.sumInput += input;
    this.sumOutput += output;

    // Calculate formulas
    const formulaMaxOnly = this.maxCacheRead;
    const formulaMaxPlusSums = this.maxCacheRead + this.sumInput + this.sumOutput;
    const formulaCreatePlusSums = this.sumCacheCreate + this.sumInput + this.sumOutput;

    const row: MessageRow = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      message_id: msgId,
      uuid,
      type: msg.type,

      cache_read: cacheRead,
      cache_create: cacheCreate,
      input,
      output,

      running_max_cache_read: this.maxCacheRead,
      running_sum_cache_create: this.sumCacheCreate,
      running_sum_input: this.sumInput,
      running_sum_output: this.sumOutput,

      formula_max_only: formulaMaxOnly,
      formula_max_plus_sums: formulaMaxPlusSums,
      formula_create_plus_sums: formulaCreatePlusSums,

      pct_max_only: (formulaMaxOnly / MAX_CONTEXT_TOKENS) * 100,
      pct_max_plus_sums: (formulaMaxPlusSums / MAX_CONTEXT_TOKENS) * 100,
      pct_create_plus_sums: (formulaCreatePlusSums / MAX_CONTEXT_TOKENS) * 100,

      unique_api_calls: this.seenMsgIds.size,

      text_preview: getTextPreview(msg),
    };

    this.messages.push(row);

    // Log progress
    console.log(`  [${row.seq}] ${msgId.slice(0, 12)}... cache_read=${cacheRead}, create=${cacheCreate}, in=${input}, out=${output}`);
    console.log(`       max_cache_read=${this.maxCacheRead}, formula_max+sums=${formulaMaxPlusSums} (${row.pct_max_plus_sums.toFixed(1)}%)`);

    return row;
  }

  /**
   * Send a prompt and collect all messages
   * Uses session resumption to maintain the same session
   */
  async sendPrompt(prompt: string, promptNum: number): Promise<void> {
    console.log(`\n[Prompt ${promptNum}] Sending: "${prompt}"${this.sessionId ? ` (session: ${this.sessionId.slice(0, 8)}...)` : ''}`);

    const options: any = {
      cwd: this.cwd,
      permissionMode: 'bypassPermissions',
    };

    // Resume existing session if we have one
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    // Add system prompt for first message
    if (!this.sessionId) {
      if (!this.useSubagents) {
        options.systemPrompt = "You are a helpful assistant. Do NOT use any tools or spawn any subagents. Answer directly and concisely.";
      } else {
        options.systemPrompt = "You are a helpful assistant. Use tools as needed to complete tasks. Do NOT use non-blocking subagents - only use blocking tool calls. Be concise in your responses.";
      }
    }

    const q = query({
      prompt,
      options,
    });

    for await (const msg of q) {
      // Capture session ID from system init
      if (msg.type === 'system') {
        const sysMsg = msg as any;
        if (sysMsg.subtype === 'init' && sysMsg.session_id) {
          this.sessionId = sysMsg.session_id;
        }
      }

      // Process for usage data
      if (isAssistantMessage(msg)) {
        this.processMessage(msg);
      }
    }
  }

  /**
   * Run the full analysis
   */
  async run(prompts: string[]): Promise<AnalysisResult> {
    console.log('='.repeat(60));
    console.log('CONTEXT ANALYZER - SDK Usage Analysis');
    console.log('='.repeat(60));
    console.log(`CWD: ${this.cwd}`);
    console.log(`Subagents: ${this.useSubagents ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Prompts: ${prompts.length}`);
    console.log('='.repeat(60));

    const startedAt = new Date().toISOString();

    // Step 1: Get baseline context
    const baseline = await this.runContextCommand('BASELINE');

    // Step 2: Send test prompts
    for (let i = 0; i < prompts.length; i++) {
      await this.sendPrompt(prompts[i], i + 1);
    }

    // Step 3: Get final context
    const final = await this.runContextCommand('FINAL');

    const endedAt = new Date().toISOString();

    // Build result
    const result: AnalysisResult = {
      session_id: this.sessionId || 'unknown',
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Date.now() - this.startTime,
      cwd: this.cwd,
      used_subagents: this.useSubagents,
      baseline,
      final,
      messages: this.messages,
      summary: {
        total_messages: this.messages.length,
        unique_api_calls: this.seenMsgIds.size,
        final_max_cache_read: this.maxCacheRead,
        final_sum_cache_create: this.sumCacheCreate,
        final_sum_input: this.sumInput,
        final_sum_output: this.sumOutput,
        calculated_max_only: this.maxCacheRead,
        calculated_max_plus_sums: this.maxCacheRead + this.sumInput + this.sumOutput,
        calculated_create_plus_sums: this.sumCacheCreate + this.sumInput + this.sumOutput,
        actual_total: final.total_tokens,
        actual_messages: final.messages_tokens,
      },
    };

    return result;
  }

  /**
   * Get current running totals (for access during analysis)
   */
  getRunningTotals() {
    return {
      maxCacheRead: this.maxCacheRead,
      sumCacheCreate: this.sumCacheCreate,
      sumInput: this.sumInput,
      sumOutput: this.sumOutput,
      uniqueApiCalls: this.seenMsgIds.size,
    };
  }
}

// ============================================================================
// Output Formatters
// ============================================================================

function toCSV(messages: MessageRow[]): string {
  const headers = [
    'seq', 'timestamp', 'elapsed_ms', 'message_id', 'uuid', 'type',
    'cache_read', 'cache_create', 'input', 'output',
    'running_max_cache_read', 'running_sum_cache_create', 'running_sum_input', 'running_sum_output',
    'formula_max_only', 'formula_max_plus_sums', 'formula_create_plus_sums',
    'pct_max_only', 'pct_max_plus_sums', 'pct_create_plus_sums',
    'unique_api_calls', 'text_preview'
  ];

  const rows = messages.map(m => [
    m.seq,
    m.timestamp,
    m.elapsed_ms,
    m.message_id,
    m.uuid,
    m.type,
    m.cache_read,
    m.cache_create,
    m.input,
    m.output,
    m.running_max_cache_read,
    m.running_sum_cache_create,
    m.running_sum_input,
    m.running_sum_output,
    m.formula_max_only,
    m.formula_max_plus_sums,
    m.formula_create_plus_sums,
    m.pct_max_only.toFixed(2),
    m.pct_max_plus_sums.toFixed(2),
    m.pct_create_plus_sums.toFixed(2),
    m.unique_api_calls,
    `"${m.text_preview.replace(/"/g, '""')}"`,
  ].join(','));

  return [headers.join(','), ...rows].join('\n');
}

function printSummary(result: AnalysisResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('ANALYSIS SUMMARY');
  console.log('='.repeat(60));

  console.log('\n--- Session Info ---');
  console.log(`Session ID: ${result.session_id}`);
  console.log(`Duration: ${result.duration_ms}ms`);
  console.log(`Subagents: ${result.used_subagents ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Total unique API calls: ${result.summary.unique_api_calls}`);

  console.log('\n--- Raw Totals ---');
  console.log(`max(cache_read): ${result.summary.final_max_cache_read}`);
  console.log(`sum(cache_create): ${result.summary.final_sum_cache_create}`);
  console.log(`sum(input): ${result.summary.final_sum_input}`);
  console.log(`sum(output): ${result.summary.final_sum_output}`);

  console.log('\n--- Formula Comparison ---');
  const s = result.summary;
  console.log(`max_only:           ${s.calculated_max_only.toLocaleString().padStart(10)} (${(s.calculated_max_only / MAX_CONTEXT_TOKENS * 100).toFixed(1)}%)`);
  console.log(`max + sum(in+out):  ${s.calculated_max_plus_sums.toLocaleString().padStart(10)} (${(s.calculated_max_plus_sums / MAX_CONTEXT_TOKENS * 100).toFixed(1)}%)`);
  console.log(`create + sum(in+out): ${s.calculated_create_plus_sums.toLocaleString().padStart(8)} (${(s.calculated_create_plus_sums / MAX_CONTEXT_TOKENS * 100).toFixed(1)}%)`);

  if (result.final) {
    console.log('\n--- Actual /context Output ---');
    console.log(`Total:    ${(result.final.total_tokens || 0).toLocaleString().padStart(10)} (${result.final.total_percent}%)`);
    console.log(`Messages: ${(result.final.messages_tokens || 0).toLocaleString().padStart(10)}`);
    console.log(`System:   ${(result.final.system_tokens || 0).toLocaleString().padStart(10)}`);

    console.log('\n--- Accuracy Check ---');
    const actual = result.final.total_tokens || 0;
    if (actual > 0) {
      const diffMaxOnly = s.calculated_max_only - actual;
      const diffMaxSums = s.calculated_max_plus_sums - actual;
      const diffCreate = s.calculated_create_plus_sums - actual;

      console.log(`max_only vs actual:      ${diffMaxOnly >= 0 ? '+' : ''}${diffMaxOnly.toLocaleString()} (${(diffMaxOnly / actual * 100).toFixed(1)}%)`);
      console.log(`max+sums vs actual:      ${diffMaxSums >= 0 ? '+' : ''}${diffMaxSums.toLocaleString()} (${(diffMaxSums / actual * 100).toFixed(1)}%)`);
      console.log(`create+sums vs actual:   ${diffCreate >= 0 ? '+' : ''}${diffCreate.toLocaleString()} (${(diffCreate / actual * 100).toFixed(1)}%)`);
    }

    // Calculate formulas
    if (result.baseline && result.messages.length > 0) {
      const baselineTotal = result.baseline.total_tokens;
      const firstCacheCreate = result.messages[0].cache_create;
      const actual = result.final.total_tokens || 0;

      console.log('\n--- THE FORMULA (baseline + cache_create_after_first + in + out) ---');
      console.log(`Baseline total:         ${baselineTotal.toLocaleString().padStart(10)}`);
      console.log(`sum(cache_create):      ${s.final_sum_cache_create.toLocaleString().padStart(10)}`);
      console.log(`First cache_create:     ${firstCacheCreate.toLocaleString().padStart(10)} (subtract this)`);
      console.log(`sum(input):             ${s.final_sum_input.toLocaleString().padStart(10)}`);
      console.log(`sum(output):            ${s.final_sum_output.toLocaleString().padStart(10)}`);

      const formula = baselineTotal + (s.final_sum_cache_create - firstCacheCreate) + s.final_sum_input + s.final_sum_output;
      const diff = formula - actual;
      const pctError = (diff / actual * 100);

      console.log(`─────────────────────────────────────`);
      console.log(`Calculated:             ${formula.toLocaleString().padStart(10)}`);
      console.log(`Actual (/context):      ${actual.toLocaleString().padStart(10)}`);
      console.log(`Difference:             ${diff >= 0 ? '+' : ''}${diff.toLocaleString().padStart(9)} (${pctError >= 0 ? '+' : ''}${pctError.toFixed(2)}%)`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const useSubagents = args.includes('--subagents');
  const outputPrefix = args.find(a => a.startsWith('--output='))?.split('=')[1] || 'context-analysis';

  let numPrompts = 3;
  const promptsArg = args.find(a => a.startsWith('--prompts='));
  if (promptsArg) {
    numPrompts = parseInt(promptsArg.split('=')[1]) || 3;
  }

  const prompts = useSubagents
    ? TEST_PROMPTS_WITH_SUBAGENT.slice(0, numPrompts)
    : TEST_PROMPTS_NO_SUBAGENT.slice(0, numPrompts);

  const cwd = process.cwd();
  const analyzer = new ContextAnalyzer(cwd, useSubagents);

  try {
    const result = await analyzer.run(prompts);

    // Print summary
    printSummary(result);

    // Save outputs
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonFile = `${outputPrefix}-${timestamp}.json`;
    const csvFile = `${outputPrefix}-${timestamp}.csv`;

    fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2));
    console.log(`\nJSON output saved to: ${jsonFile}`);

    fs.writeFileSync(csvFile, toCSV(result.messages));
    console.log(`CSV output saved to: ${csvFile}`);

  } catch (error) {
    console.error('Analysis failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
