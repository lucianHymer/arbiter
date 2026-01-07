# The Arbiter

> OF THAT WHICH WAS, THAT WHICH IS, AND THAT WHICH SHALL COME TO BE

A hierarchical AI orchestration system with an RPG-style terminal interface. Choose your wizard, walk the forest path, and consult the ancient Arbiter for tasks too large for a single context window.

## Quick Start

```bash
npm install
npm run dev
```

## How It Works

```
You → Arbiter → Orchestrators → Subagents
        ↑           ↑             ↑
      manager    workers      do the work
```

Each layer has ~200K context. The Arbiter delegates to Orchestrators, who spawn Subagents. Big tasks become manageable.

## Controls

- **Arrow keys** - Navigate (character select, forest path)
- **Enter** - Submit message / confirm selection
- **Esc** - Switch to scroll mode (j/k to scroll chat)
- **i** or **Enter** - Back to typing mode
- **Ctrl+O** - Toggle logbook
- **q** or **Ctrl+C** - Quit

## Warning

Runs with `bypassPermissions`. The AI has full system access. Don't run on machines with secrets you want to keep.

## Testing

```bash
npm run test:headless  # Full flow without TUI
```
