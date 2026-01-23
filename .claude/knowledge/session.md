### [20:03] [architecture] Orchestrator Spawning and Tracking System
**Details**: The system manages orchestrator lifecycle through several coordinated components:

**State Tracking (state.ts):**
- `AppState.currentOrchestrator`: Single OrchestratorState object (or null)
- Only one active orchestrator at a time
- Tracks: id, sessionId, number (I, II, III...), contextPercent, currentTool, toolCallCount

**Router Management (router.ts):**
- `orchestratorCount`: Incremented counter (starts at 0, increments to 1, 2, 3...)
- `currentOrchestratorSession`: OrchestratorSession object bundling all state
- Intent-based routing: when Arbiter returns intent='summon_orchestrator':
  1. pendingOrchestratorSpawn flag is set
  2. After Arbiter response completes, orchestratorCount++
  3. startOrchestratorSession(orchestratorCount) is called
  4. New session replaces old one (cleanupOrchestrator called first)
- Cleanup: cleanupOrchestrator() nulls currentOrchestratorSession and state.currentOrchestrator
- Callbacks fire: onOrchestratorSpawn(number) and onOrchestratorDisconnect()

**Visual Representation (tui-termkit.ts):**
- 10 demon sprites created at initialization (demon-1 through demon-10)
- Initial state: all invisible (visible: false)
- Positions scattered around campfire (row 0-4, col 3-6 mostly)
- Each demon uses DEMON_1 through DEMON_10 tiles (tile indices 220-229)

**Demon Spawning Flow:**
1. Router calls onOrchestratorSpawn(orchestratorNumber: 1-indexed)
2. TUI callbacks convert: demonIndex = orchestratorNumber - 1 (0-indexed)
3. queueDemonSpawn(demonIndex) pushes to pendingDemons array
4. processSummonQueue() executes async:
   - Arbiter walks to fire position (row 3, col 4)
   - Spellbook appears at (row 4, col 4)
   - For each queued demon: waits 500ms, calls demons[i].magicSpawn()
5. magicSpawn() animation: plays magic sound, shows smoke tile, sets visible=true after 400ms

**Old Orchestrator Handling:**
- When new orchestrator spawns, cleanupOrchestrator() is called first
- If old orchestrator was active: pendingDemons queue is cleared
- dismissAllOrchestrators() is called on release_orchestrators intent:
  - Waits for any in-progress summon to finish
  - Despawns all visible demons (magicDespawn animation)
  - Hides spellbook
  - Arbiter walks back to scroll position (row 2, col 3)

**Multiple Orchestrators Tracking:**
- System tracks orchestratorCount (total spawned, never resets)
- Only currentOrchestrator visible in UI state at any time
- Each gets Roman numeral: I=1, II=2, III=3, etc.
- Visual demons are numbered 1-10 max, mapped by 0-indexed position
**Files**: src/state.ts, src/router.ts, src/tui/tui-termkit.ts, src/tui/callbacks.ts, src/tui/sprite.ts
---

### [23:10] [architecture] Shared task list between Arbiter and Orchestrators
**Details**: The Arbiter and Orchestrators share a task list via the CLAUDE_CODE_TASK_LIST_ID environment variable.

## Setup
- Task list ID is generated/loaded in src/index.ts via getOrCreateTaskListId()
- ID is persisted in .claude/arbiter-task-list-id for session continuity
- process.env.CLAUDE_CODE_TASK_LIST_ID is set BEFORE any SDK queries
- Tasks stored in ~/.claude/tasks/<task-list-id>/*.json

## Task Watcher (src/tui/taskWatcher.ts)
- createTaskWatcher() monitors the task directory
- Polls every 1 second for changes
- Provides getTasks(), onUpdate(callback), start(), stop()
- generateTaskListId() and getOrCreateTaskListId() helper functions

## Quest Log Overlay (src/tui/questLog.ts)
- Floating RPG-style panel in bottom-left of tile scene
- Shows tasks with status indicators: ○ pending, ◐ in_progress, ● completed
- Owner tags: [I] for Orchestrator I, [A] for Arbiter
- Toggle with 't' key in NORMAL mode
- Scrollable with j/k or arrow keys

## TUI Integration
- Task watcher starts in start(), stops in stop()
- Quest log draws after tiles in animation loop and fullDraw
- Task updates trigger questLog.draw() when visible

## System Prompt Updates
- Arbiter: Create high-level tasks, assign to Orchestrators, verify via task status
- Orchestrator: Check TaskList first, claim tasks, update status religiously, leave accurate state for successor

## Task Commands
- TaskList: See all tasks
- TaskGet(taskId): Full details
- TaskCreate(subject, description): New task  
- TaskUpdate(taskId, status/owner/addBlockedBy/addBlocks): Update task
**Files**: src/index.ts, src/tui/taskWatcher.ts, src/tui/questLog.ts, src/tui/tui-termkit.ts, src/arbiter.ts, src/orchestrator.ts
---

