/**
 * Test file for queue formatting and trigger detection functions
 *
 * Since these functions are private to router.ts, we re-implement the logic
 * here to test the expected behavior.
 */

// ============================================
// Re-implemented functions (copied from router.ts)
// ============================================

/**
 * Check if a message contains the @ARBITER: trigger
 * Returns true if the message starts with @ARBITER: (case insensitive)
 */
function hasArbiterTrigger(text: string): boolean {
  return /^@ARBITER:/i.test(text.trim());
}

/**
 * Strip the @ARBITER: prefix from a message for display
 * Only strips from the beginning of the message
 */
function stripTriggerTag(text: string): string {
  return text.trim().replace(/^@ARBITER:\s*/i, '');
}

/**
 * Determine the trigger type from a message
 * Returns 'handoff' if message contains HANDOFF keyword after @ARBITER:
 * Returns 'input' otherwise
 */
function getTriggerType(text: string): 'input' | 'handoff' {
  const stripped = stripTriggerTag(text);
  // Check if it's a handoff (contains HANDOFF keyword at start)
  if (/^HANDOFF\b/i.test(stripped)) {
    return 'handoff';
  }
  return 'input';
}

/**
 * Convert a number to Roman numerals (copied from state.ts)
 */
function toRoman(num: number): string {
  if (num < 1 || num > 3999) {
    throw new Error('Number must be between 1 and 3999');
  }

  const romanNumerals: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];

  let result = '';
  let remaining = num;

  for (const [value, symbol] of romanNumerals) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }

  return result;
}

/**
 * Format queued messages and trigger message for the Arbiter
 * Uses delimiters with explicit labels
 */
function formatQueueForArbiter(
  queue: string[],
  triggerMessage: string,
  triggerType: 'input' | 'handoff' | 'human',
  orchNumber: number
): string {
  const orchLabel = `Orchestrator ${toRoman(orchNumber)}`;
  const parts: string[] = [];

  // Add work log section if there are queued messages
  if (queue.length > 0) {
    parts.push(`\u00AB${orchLabel} - Work Log (no response needed)\u00BB`);
    for (const msg of queue) {
      parts.push(`\u2022 ${msg}`);
    }
    parts.push(''); // Empty line separator
  }

  // Add the trigger section based on type
  switch (triggerType) {
    case 'input':
      parts.push(`\u00AB${orchLabel} - Awaiting Input\u00BB`);
      break;
    case 'handoff':
      parts.push(`\u00AB${orchLabel} - Handoff\u00BB`);
      break;
    case 'human':
      parts.push(`\u00ABHuman Interjection\u00BB`);
      break;
  }
  parts.push(triggerMessage);

  return parts.join('\n');
}

// ============================================
// Test utilities
// ============================================

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string): void {
  if (condition) {
    console.log(`  PASS: ${testName}`);
    passCount++;
  } else {
    console.log(`  FAIL: ${testName}`);
    failCount++;
  }
}

function assertEqual(actual: any, expected: any, testName: string): void {
  const pass = actual === expected;
  if (pass) {
    console.log(`  PASS: ${testName}`);
    passCount++;
  } else {
    console.log(`  FAIL: ${testName}`);
    console.log(`        Expected: ${JSON.stringify(expected)}`);
    console.log(`        Actual:   ${JSON.stringify(actual)}`);
    failCount++;
  }
}

// ============================================
// Tests
// ============================================

console.log('\n=== Testing hasArbiterTrigger() ===\n');

// Test: Returns true for "@ARBITER: question"
assert(hasArbiterTrigger('@ARBITER: question') === true,
  '@ARBITER: question -> true');

// Test: Returns true for "@arbiter: question" (case insensitive)
assert(hasArbiterTrigger('@arbiter: question') === true,
  '@arbiter: question (lowercase) -> true');

// Test: Returns true for "  @ARBITER: question" (with leading whitespace)
assert(hasArbiterTrigger('  @ARBITER: question') === true,
  '  @ARBITER: question (leading whitespace) -> true');

// Test: Returns false for "no trigger here"
assert(hasArbiterTrigger('no trigger here') === false,
  'no trigger here -> false');

// Test: Returns false for "some text @ARBITER: in middle"
assert(hasArbiterTrigger('some text @ARBITER: in middle') === false,
  'some text @ARBITER: in middle -> false');

// Additional edge cases
assert(hasArbiterTrigger('@ARBITER:question') === true,
  '@ARBITER:question (no space after colon) -> true');

assert(hasArbiterTrigger('@Arbiter: MixedCase') === true,
  '@Arbiter: MixedCase -> true');

assert(hasArbiterTrigger('') === false,
  'empty string -> false');

console.log('\n=== Testing stripTriggerTag() ===\n');

// Test: Strips "@ARBITER: " from start
assertEqual(stripTriggerTag('@ARBITER: question'), 'question',
  'strips @ARBITER: from start');

// Test: Strips "@ARBITER:question" (no space)
assertEqual(stripTriggerTag('@ARBITER:question'), 'question',
  'strips @ARBITER: (no space after colon)');

// Test: Handles case insensitivity
assertEqual(stripTriggerTag('@arbiter: QUESTION'), 'QUESTION',
  'handles case insensitivity');

// Test: Returns original if no trigger
assertEqual(stripTriggerTag('no trigger here'), 'no trigger here',
  'returns original if no trigger');

// Additional edge cases
assertEqual(stripTriggerTag('  @ARBITER: question  '), 'question',
  'handles leading/trailing whitespace');

assertEqual(stripTriggerTag('@ARBITER:   multiple spaces'), 'multiple spaces',
  'strips multiple spaces after colon');

assertEqual(stripTriggerTag('text @ARBITER: in middle'), 'text @ARBITER: in middle',
  'does not strip trigger in middle of text');

console.log('\n=== Testing getTriggerType() ===\n');

// Test: Returns 'handoff' for "@ARBITER: HANDOFF ..."
assertEqual(getTriggerType('@ARBITER: HANDOFF work is complete'), 'handoff',
  '@ARBITER: HANDOFF -> handoff');

// Test: Returns 'input' for "@ARBITER: Should I..."
assertEqual(getTriggerType('@ARBITER: Should I proceed?'), 'input',
  '@ARBITER: Should I... -> input');

// Additional test cases
assertEqual(getTriggerType('@ARBITER: handoff completed'), 'handoff',
  '@ARBITER: handoff (lowercase) -> handoff');

assertEqual(getTriggerType('@ARBITER: HANDOFF'), 'handoff',
  '@ARBITER: HANDOFF (just keyword) -> handoff');

assertEqual(getTriggerType('@ARBITER: Some question?'), 'input',
  '@ARBITER: Some question? -> input');

assertEqual(getTriggerType('@ARBITER: I need clarification'), 'input',
  '@ARBITER: I need clarification -> input');

// Edge case: HANDOFF not at start
assertEqual(getTriggerType('@ARBITER: This is not a HANDOFF'), 'input',
  '@ARBITER: This is not a HANDOFF -> input (HANDOFF not at start)');

console.log('\n=== Testing formatQueueForArbiter() ===\n');

// Test: Formats with empty queue correctly (no work log section)
const emptyQueueResult = formatQueueForArbiter([], 'Need input please', 'input', 1);
const expectedEmptyQueue = '\u00ABOrchestrator I - Awaiting Input\u00BB\nNeed input please';
assertEqual(emptyQueueResult, expectedEmptyQueue,
  'empty queue - no work log section');

// Test: Formats with queue correctly (adds work log section)
const withQueueResult = formatQueueForArbiter(
  ['Read file.ts', 'Modified config'],
  'Done with work',
  'handoff',
  1
);
const expectedWithQueue =
  '\u00ABOrchestrator I - Work Log (no response needed)\u00BB\n' +
  '\u2022 Read file.ts\n' +
  '\u2022 Modified config\n' +
  '\n' +
  '\u00ABOrchestrator I - Handoff\u00BB\n' +
  'Done with work';
assertEqual(withQueueResult, expectedWithQueue,
  'with queue - adds work log section');

// Test: Uses correct header for 'input' trigger type
const inputResult = formatQueueForArbiter([], 'Should I proceed?', 'input', 2);
assert(inputResult.includes('\u00ABOrchestrator II - Awaiting Input\u00BB'),
  'input type uses Awaiting Input header');

// Test: Uses correct header for 'handoff' trigger type
const handoffResult = formatQueueForArbiter([], 'Work complete', 'handoff', 2);
assert(handoffResult.includes('\u00ABOrchestrator II - Handoff\u00BB'),
  'handoff type uses Handoff header');

// Test: Uses correct header for 'human' trigger type
const humanResult = formatQueueForArbiter([], 'User question', 'human', 3);
assert(humanResult.includes('\u00ABHuman Interjection\u00BB'),
  'human type uses Human Interjection header');

// Test: Correct Roman numeral for orchestrator number
const orchIIIResult = formatQueueForArbiter([], 'test', 'input', 3);
assert(orchIIIResult.includes('Orchestrator III'),
  'uses correct Roman numeral (III)');

const orchIVResult = formatQueueForArbiter([], 'test', 'input', 4);
assert(orchIVResult.includes('Orchestrator IV'),
  'uses correct Roman numeral (IV)');

// Test: Multiple queued messages
const multiQueueResult = formatQueueForArbiter(
  ['Step 1', 'Step 2', 'Step 3'],
  'Question',
  'input',
  1
);
assert(multiQueueResult.includes('\u2022 Step 1'),
  'includes first queued message with bullet');
assert(multiQueueResult.includes('\u2022 Step 2'),
  'includes second queued message with bullet');
assert(multiQueueResult.includes('\u2022 Step 3'),
  'includes third queued message with bullet');

// ============================================
// Summary
// ============================================

console.log('\n=== Test Summary ===\n');
console.log(`  Passed: ${passCount}`);
console.log(`  Failed: ${failCount}`);
console.log(`  Total:  ${passCount + failCount}`);

if (failCount > 0) {
  console.log('\nSome tests FAILED!\n');
  process.exit(1);
} else {
  console.log('\nAll tests PASSED!\n');
  process.exit(0);
}
