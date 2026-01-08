# Knowledge Map

*Last updated: 2026-01-08*

## Architecture

System design and component relationships.

- [TUI Integration Architecture](architecture/tui-integration.md) - How TUI connects to Router, state flow, callbacks, TUI bridge pattern, Ink integration, animation system
- [Hierarchical Orchestration](architecture/hierarchical-orchestration.md) - Core context management design, spawn_orchestrator MCP tool, UI model ("each other's users")
- [Router Design](architecture/router-design.md) - Message forwarding principles, text tagging removal
- [Logging Architecture](architecture/logging-architecture.md) - Message flow, debug logging, context tracking, tool use events
- [Context Calculation](architecture/context-calculation.md) - SDK context window formula: baseline + (max - first cache_read) + last(cache_create), dedupe by message.id, ~0.64% accuracy

## TUI

Terminal user interface implementation details.

- [Tile-based Renderer](tui/tile-renderer.md) - 16x16 fantasy tileset, ANSI true color, half-block technique, compositing rules, animation system, scene state

## Gotchas

Non-obvious behaviors and known issues.

- [Arbiter Echo Bug](gotchas/arbiter-echo-bug.md) - Message routing causes Arbiter to echo orchestrator messages with prefixes
- [Ink ANSI Clearing](gotchas/ink-ansi-clearing.md) - Ink clears raw ANSI writes on re-render, requires interval-based repainting workaround
- [ForestIntro Exit Mechanism](gotchas/forestintro-exit-mechanism.md) - Player must walk OFF screen (x >= SCENE_WIDTH_TILES) to exit, not just reach rightmost tile
- [ForestIntro Dialogue Positioning](gotchas/forestintro-dialogue-positioning.md) - Dialogue box Y position must account for scene offset and tile height calculations
