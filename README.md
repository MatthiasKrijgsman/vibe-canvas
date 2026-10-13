# VibeCanvas

A canvas for Claude Code: write prompts as cards, drop them on a project to start a
Claude Code session in a terminal on the canvas, or drop them on a running terminal to
send them as the next message. Everything — prompts, terminals, positions, zoom — is
restored when you reopen the app, and each terminal resumes its Claude Code session.

Sessions run the real `claude` CLI in a pseudo-terminal, so they use your existing
Claude Code login and plan (any `ANTHROPIC_API_KEY` is removed from their environment).

## Run

```bash
npm install
npm run dev
```

## Package as an app

```bash
npm run package       # dist/VibeCanvas-<version>-arm64.dmg and .zip
npm run package:dir   # just dist/mac-arm64/VibeCanvas.app (faster)
```

Builds are ad-hoc signed, which is enough to run them on your own Mac. To give the app to
others, sign it with a Developer ID certificate and notarize it (see `electron-builder.yml`).
The packaged app and `npm run dev` share the same canvas data, so run one at a time.

## Using it

- **New prompt**: double-click the canvas, `⌘N`, or the toolbar button.
- **Add a project**: the `+` next to *Projects* (any folder).
- **Start a session**: drag a prompt by its header onto a project in the sidebar, then pick
  the model (Opus 5.5 by default) and effort level. The `+` on a project starts an empty session.
  A session keeps its model and effort when it is resumed.
- **Send to a session**: drag a prompt onto a terminal. Prompts snap back so you can reuse them.
  While Claude works on it, the prompt is locked and linked to the terminal by an animated line;
  it unlocks when Claude finishes (the `×` in its footer unlocks it early).
- **Images**: drop image files onto a prompt (or paste with `⌘V` while editing it) and they
  go along as attachments when the prompt is sent. Dropping images on empty canvas starts a
  new prompt with them; dropping one straight onto a terminal attaches it to the input there.
- **Terminals**: drag by the title bar, `Shift+Enter` for a newline. The dot shows status
  (clay = working, amber = needs input, green = waiting).
- **Layout**: cards snap to the dot grid; resize any card from its edges or corners.
- **Camera**: drag with the middle mouse button (or two-finger scroll) to pan, pinch to zoom.
  Left-dragging empty canvas draws a selection box.

## How it works

- `src/main/pty.ts` spawns `claude --session-id <id> -- <prompt>` (or `--resume <id>` on
  restore) with node-pty, and runs a local endpoint that Claude Code hooks post to
  (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop`) for status
  and session-id tracking. The hooks are passed via `--settings`, so your own config is untouched.
- Messages are typed into Claude Code by pasting: each image path first (Claude Code turns
  a pasted image path into an `[Image #N]` attachment), then the text, then Enter. A new
  session with images starts empty and gets its first message once `SessionStart` fires.
  Images are copied into the app's `images` folder so the originals can move.
- `src/main/env.ts` builds the terminal environment from your login shell.
- State lives in `~/Library/Application Support/VibeCanvas/canvas-state.json`
  (`VIBECANVAS_PROFILE=<dir>` uses a different folder).
- Fonts are loaded at runtime from your installed Claude desktop app; system fonts are
  used if it isn't installed.
