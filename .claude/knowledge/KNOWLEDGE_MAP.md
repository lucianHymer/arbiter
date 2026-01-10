# Knowledge Map

*Last updated: 2026-01-10*

## Architecture

System design and component relationships.

- [TUI Integration Architecture](architecture/tui-integration.md) - How TUI connects to Router, state flow, callbacks, TUI bridge pattern, Ink integration, animation system
- [Hierarchical Orchestration](architecture/hierarchical-orchestration.md) - Core context management design, spawn_orchestrator MCP tool, UI model ("each other's users")
- [Router Design](architecture/router-design.md) - Message forwarding principles, text tagging removal
- [Logging Architecture](architecture/logging-architecture.md) - Message flow, debug logging, context tracking, tool use events
- [Context Calculation](architecture/context-calculation.md) - Session fork polling approach for 100% accurate context tracking
- [Structured Output Routing](architecture/structured-output-routing.md) - Deterministic orchestrator message routing via SDK structured outputs

## TUI

Terminal user interface implementation details.

- [Tile-based Renderer](tui/tile-renderer.md) - 16x16 fantasy tileset, ANSI true color, half-block technique, compositing rules, animation system, scene state
- [Working Indicator Pattern](tui/working-indicator.md) - Transient tool indicator implementation, animation system, auto-clear strategies, implementation options
- [Input Handling](tui/input-handling.md) - Two-mode (INSERT/NORMAL) vim-like input system, state management, submission flow

## Gotchas

Non-obvious behaviors and known issues.

- [Arbiter Echo Bug](gotchas/arbiter-echo-bug.md) - Message routing causes Arbiter to echo orchestrator messages with prefixes
- [Ink ANSI Clearing](gotchas/ink-ansi-clearing.md) - Ink clears raw ANSI writes on re-render, requires interval-based repainting workaround
- [ForestIntro Exit Mechanism](gotchas/forestintro-exit-mechanism.md) - Player must walk OFF screen (x >= SCENE_WIDTH_TILES) to exit, not just reach rightmost tile
- [ForestIntro Dialogue Positioning](gotchas/forestintro-dialogue-positioning.md) - Dialogue box Y position must account for scene offset and tile height calculations
