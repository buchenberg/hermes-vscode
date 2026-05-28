# Hermes Agent — VS Code Extension

AI coding agent for VS Code powered by [Hermes Agent](https://github.com/buchenberg/hermes-agent). Chat, session management, inline completions, code actions — all via the Agent Client Protocol (ACP).

## Features

- **Sidebar chat panel** — converse with the agent directly in VS Code
- **Session toolbar** — switch models, modes, and config options mid-conversation from dropdowns in the chat header
- **Agent Sessions tree view** — browse saved sessions with model/mode badges and time-ago labels; click to resume, fork, or delete
- **Session history persistence** — sessions survive VS Code restarts, stored in extension globalState
- **Streaming responses** — see the agent think and act in real time
- **Tool call visualization** — terminal, file edit, web search, and browser actions rendered inline
- **Inline completions** — Copilot-style ghost text (experimental, opt-in)
- **Code actions** — explain, fix, review, and send selection to agent
- **Status bar indicator** — at-a-glance agent connection status

## Prerequisites

[Hermes Agent](https://github.com/buchenberg/hermes-agent) installed and on your `PATH`:

```bash
pip install hermes-agent
# or
brew install buchenberg/tap/hermes-agent
```

Verify it works:

```bash
hermes --help
```

## Installation

### From source (development)

```bash
cd hermes-vscode
npm install
npm run compile
```

Then press F5 in VS Code to launch the Extension Development Host.

### From VSIX (release)

Download the `.vsix` from releases, then:

```
code --install-extension hermes-vscode-0.1.0.vsix
```

Or in VS Code: Extensions → `...` → Install from VSIX.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `hermes.path` | `hermes` | Path to the hermes CLI |
| `hermes.args` | `[]` | Extra args for `hermes acp` |
| `hermes.autoStart` | `true` | Start the agent on VS Code launch |
| `hermes.model` | `""` | Model override (e.g. `anthropic/claude-sonnet-4`) |
| `hermes.provider` | `""` | Provider override |
| `hermes.workingDirectory` | `${workspaceFolder}` | Agent working directory |
| `hermes.showInlineCompletions` | `false` | Enable inline ghost text completions |

## Session Management

The **Agent Sessions** view (in the Hermes sidebar, below the chat) shows all your past sessions with model, mode, and last-active information. Each session appears as a tree item with inline action buttons:

- **Resume** — reopen the session in the chat panel with full message history
- **Fork** — create a new session seeded from this session's model/mode config
- **Delete** — remove the session from history

Sessions are automatically recorded whenever you start a new chat. The **chat toolbar** (above the message area) lets you switch modes, models, and config options on the fly without restarting the agent.

## Commands

| Command | Keybinding | Description |
|---|---|---|
| `Hermes: Open Chat` | `Ctrl+Shift+Alt+H` | Open the chat panel |
| `Hermes: Send Selection to Chat` | `Ctrl+Shift+H` | Send selected code to the agent |
| `Hermes: Explain This Code` | — | Ask the agent to explain selection/file |
| `Hermes: Fix This Code` | — | Ask the agent to fix issues in selection/file |
| `Hermes: Review This File` | — | Ask the agent to review the current file |
| `Hermes: Start Agent` | — | Manually start the Hermes ACP process |
| `Hermes: Stop Agent` | — | Stop the agent |
| `Hermes: Restart Agent` | — | Restart the agent |
| `Hermes: New Session` | — | Start a fresh conversation |
| `Hermes: Setup Agent` | — | Configure model/provider |
| `Hermes: Resume Session` | — | Reopen a saved session by name or pick from list |
| `Hermes: Fork Session` | — | Fork the current session to a new one (keeps model/mode) |
| `Hermes: Delete Session` | — | Delete the current session from history |
| `Hermes: Show Logs` | — | Open the Hermes output channel |

## Architecture

```
┌─────────────┐     JSON-RPC 2.0     ┌──────────────┐
│  VS Code    │◄────────────────────►│  hermes acp   │
│  Extension  │      over stdio      │  (ACP server) │
└─────────────┘                      └──────────────┘
```

- `src/acp/` — ACP JSON-RPC client, protocol types (`SessionConfigOption`, `NewSessionResult`, etc.)
- `src/chat/` — Sidebar webview chat provider with session toolbar dropdowns
- `src/views/` — Session tree view provider (`SessionTreeProvider`)
- `src/persistence/` — Session history store backed by `globalState`
- `src/inline/` — Inline completion provider (ghost text)
- `src/commands/` — Command palette actions (including session management)
- `media/` — Icons and assets

## Development

```bash
npm install       # Install dependencies
npm run compile   # Build TypeScript
npm run watch     # Watch mode
npm run lint      # Lint
npm run package   # Create .vsix
```

## License

MIT — see [Hermes Agent](https://github.com/buchenberg/hermes-agent) for details.
