# Knowledge Map

*Last updated: 2026-01-05*

## Architecture

System design and component relationships.

- [TUI Integration Architecture](architecture/tui-integration.md) - How TUI connects to Router, state flow, callbacks, Blessed integration, animation system
- [Hierarchical Orchestration](architecture/hierarchical-orchestration.md) - Core context management design, spawn_orchestrator MCP tool, UI model ("each other's users")
- [Router Design](architecture/router-design.md) - Message forwarding principles, text tagging removal

## TUI

Terminal user interface implementation details.

- [Tile-based Renderer](tui/tile-renderer.md) - 16x16 fantasy tileset, ANSI true color, half-block technique, compositing rules

## Gotchas

Non-obvious behaviors and known issues.

- [Arbiter Echo Bug](gotchas/arbiter-echo-bug.md) - Message routing causes Arbiter to echo orchestrator messages with prefixes
