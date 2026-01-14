// Headless test script for Arbiter core functionality
// Tests the Router and State without TUI

import { Router, type RouterCallbacks } from './router.js';
import { createInitialState } from './state.js';

// Test timeout in milliseconds
const TEST_TIMEOUT_MS = 120000;

// Track if we've received responses
let arbiterResponseCount = 0;
let orchestratorResponseCount = 0;
let testComplete = false;

/**
 * Create mock callbacks that log to console
 */
function createMockCallbacks(): RouterCallbacks {
  return {
    onHumanMessage: (text: string) => {
      console.log('\n=== HUMAN MESSAGE ===');
      console.log(text);
      console.log('======================\n');
    },
    onArbiterMessage: (text: string) => {
      console.log('\n=== ARBITER MESSAGE ===');
      console.log(text);
      console.log('========================\n');
      arbiterResponseCount++;
    },
    onOrchestratorMessage: (orchestratorNumber: number, text: string) => {
      console.log(`\n=== ORCHESTRATOR ${orchestratorNumber} MESSAGE ===`);
      console.log(text);
      console.log('================================\n');
      orchestratorResponseCount++;
    },
    onContextUpdate: (arbiterPercent: number, orchestratorPercent: number | null) => {
      console.log(
        `[Context] Arbiter: ${arbiterPercent.toFixed(1)}%, Orchestrator: ${
          orchestratorPercent !== null ? `${orchestratorPercent.toFixed(1)}%` : 'N/A'
        }`,
      );
    },
    onToolUse: (tool: string, count: number) => {
      console.log(`[Tool Use] ${tool} (total calls: ${count})`);
    },
    onArbiterIntent: (intent: string) => {
      console.log(`[Arbiter Intent] ${intent}`);
    },
  };
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main test function
 */
async function runTest(): Promise<void> {
  console.log('===========================================');
  console.log('  ARBITER HEADLESS TEST');
  console.log('===========================================\n');

  // Create initial state
  console.log('[Setup] Creating initial state...');
  const state = createInitialState();
  console.log('[Setup] Initial state created:', JSON.stringify(state, null, 2));

  // Create mock callbacks
  console.log('[Setup] Creating mock callbacks...');
  const callbacks = createMockCallbacks();

  // Create router
  console.log('[Setup] Creating router...');
  const router = new Router(state, callbacks);

  // Set up timeout
  const timeoutId = setTimeout(async () => {
    console.log('\n[Timeout] Test timeout reached (120 seconds)');
    console.log('[Cleanup] Stopping router...');
    testComplete = true;
    await router.stop();
    printSummary();
    process.exit(0);
  }, TEST_TIMEOUT_MS);

  try {
    // Start the router (initializes Arbiter session)
    console.log('\n[Test] Starting router (initializing Arbiter session)...');
    await router.start();

    console.log('\n[Test] Router started.');

    // Send first test message
    console.log("\n[Test] Sending first message: 'Hello, what are you?'");
    await router.sendHumanMessage('Hello, what are you?');

    // Wait for first response before sending second message
    console.log('[Test] Waiting for Arbiter response...');
    const startTime = Date.now();
    while (arbiterResponseCount === 0 && Date.now() - startTime < 60000) {
      await sleep(500);
    }

    if (arbiterResponseCount === 0) {
      console.log('[Warning] No Arbiter response after 60 seconds');
    } else {
      console.log('[Test] First response received!');
    }

    // Send second test message immediately after receiving first response
    console.log(
      "\n[Test] Sending second message: 'Please spawn an orchestrator to list the files in the current directory'",
    );
    await router.sendHumanMessage(
      'Please spawn an orchestrator to list the files in the current directory',
    );

    console.log('[Test] Waiting for Orchestrator to be spawned and do work...');

    // Wait and check periodically
    let waitTime = 0;
    const checkInterval = 2000;
    while (waitTime < TEST_TIMEOUT_MS - 15000 && !testComplete) {
      await sleep(checkInterval);
      waitTime += checkInterval;

      console.log(
        `[Status] Elapsed: ${waitTime / 1000}s, Arbiter responses: ${arbiterResponseCount}, Orchestrator responses: ${orchestratorResponseCount}`,
      );

      // If orchestrator has responded, we can consider the test successful
      if (orchestratorResponseCount > 0) {
        console.log('\n[Success] Orchestrator has responded!');
        await sleep(3000); // Give a bit more time for any final responses
        break;
      }
    }

    // Clean up
    clearTimeout(timeoutId);
    console.log('\n[Cleanup] Stopping router...');
    await router.stop();

    printSummary();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('\n[Error] Test failed with error:');
    console.error(error);

    try {
      await router.stop();
    } catch (stopError) {
      console.error('[Error] Failed to stop router:', stopError);
    }

    process.exit(1);
  }
}

/**
 * Print test summary
 */
function printSummary(): void {
  console.log('\n===========================================');
  console.log('  TEST SUMMARY');
  console.log('===========================================');
  console.log(`Arbiter responses received: ${arbiterResponseCount}`);
  console.log(`Orchestrator responses received: ${orchestratorResponseCount}`);
  console.log(
    `Test result: ${
      arbiterResponseCount > 0 ? 'PASSED (received Arbiter response)' : 'NEEDS REVIEW'
    }`,
  );
  console.log('===========================================\n');
}

// Run the test
console.log('[Init] Starting headless test...\n');
runTest()
  .then(() => {
    console.log('[Done] Test completed.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('[Fatal] Unhandled error:', error);
    process.exit(1);
  });
