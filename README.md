# plain-summary

A Claude Code mod that adds a **Plain summary** pane beside the chat. It explains what Claude does in ASD-STE100 Simplified Technical English, without putting that instruction into Claude's own context.

- **Summary tab:** after each turn, a short summary: what you asked, what Claude did, why, the result, and words to know. It is written by a fork of the session (the session's own model, served from the prompt cache), so the main conversation never sees it.
- **Timeline tab:** a vertical, timestamped list of each turn and every tool call, each call rewritten as one plain sentence by Haiku.
- `/plain` opens the pane; `/plain now` summarizes the last turn on demand.
- History is kept per session in the mod's local store (the 20 most recent sessions), so it survives an app restart.

Short chat turns (no tool calls, an answer under 600 characters) get no summary of their own.

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
