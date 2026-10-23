# plain-summary

A Claude Code mod that adds a **Plain summary** pane beside the chat. It explains what Claude does in ASD-STE100 Simplified Technical English, without putting that instruction into Claude's own context.

- **One fold per thing you did:** each message you send, shell command you run, or side task you start begins a fold. The fold holds everything Claude did until your next one. Notifications and system messages never start a fold.
- **Folded, a fold is two lines:** your words, then "→ outcome" in one short line that says plainly when something failed or is not done. The newest fold is open; the rest stay folded until you open them (or "Open all").
- **Open, it shows detail one level at a time:** Claude's tool calls grouped by purpose (a blocked or failed group opens itself and says why), each step with "Show command", Claude's reply in 1 to 3 short lines, and "Show full reply" for the original text.
- Summaries are written by Haiku once Claude's turn ends: one call per fold, kept out of the main conversation. A prompt rule keeps warnings and instructions to you meaning exactly what Claude said. A quick chat answer needs no model call.
- `/plain` opens the pane; `/plain model haiku|sonnet|opus` sets the summary model; `/plain now` re-summarises the newest fold.
- History is kept per session in the mod's local store (the 20 most recent sessions), so it survives an app restart.

## Install

At the prompt of a terminal session:

```
/plugin install plain-summary --marketplace jamesbarker185/claude-mods
```

From a shell:

```bash
claude plugin install plain-summary --marketplace jamesbarker185/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `jamesbarker185/claude-mods`, then Add plugin.

## Cloud sessions

A cloud session loads plugins named in the project's `.claude/settings.json`. Add:

```json
{
  "extraKnownMarketplaces": {
    "claude-mods": { "source": { "source": "github", "repo": "jamesbarker185/claude-mods" } }
  },
  "enabledPlugins": { "plain-summary@claude-mods": true }
}
```
