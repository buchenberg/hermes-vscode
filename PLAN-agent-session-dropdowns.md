# Plan: Agent & Session Type Dropdowns for Hermes VSCode

**Source reference:** `vscode-acp` (`~/Code/vscode-acp/`)  
**Target project:** `hermes-vscode` (`~/Code/hermes-vscode/`)  
**Date:** 2026-05-28

---

## Overview

The vscode-acp extension provides two key dropdown UX patterns that hermes-vscode currently lacks:

1. **Agent selection tree view** — A sidebar tree listing configured agents (Tier-1) and their sessions (Tier-2), surfaced via `SessionTreeProvider`.
2. **Chat toolbar dropdowns** — Mode ⚡ and model 🧠 pickers (plus dynamic ACP Session Config Options) rendered in the chat input toolbar.

This plan describes how to implement both in hermes-vscode.

---

## Phase 1: Chat Toolbar Dropdowns (Mode / Model / Config Options)

**Current state:** hermes-vscode already has `AcpClient.setSessionModel()` and `AcpClient.setSessionMode()` wired up in the ACP client, and `CurrentModeUpdate` is handled in `chatProvider.ts`. But the webview HTML has **no toolbar UI** for these — no picker buttons, no dropdowns.

**What to build:**

### 1.1 Add a picker toolbar row to the webview HTML

Add to `src/chat/chatProvider.ts` `_getHtml()` (or better, `src/chat/webview-app.ts` since esbuild bundles it):

A toolbar row between the header and messages area:

```html
<div class="input-toolbar" id="toolbar">
  <!-- Dynamic config-option pickers (ACP Session Config Options) -->
  <div class="config-options-row" id="configOptionsContainer"></div>
  <!-- Legacy mode picker (hidden when configOptions present) -->
  <div class="picker-wrap hidden" id="modePickerWrap">
    <button class="picker-btn" id="modePickerBtn">
      <span class="picker-icon">⚡</span>
      <span class="picker-label" id="modePickerLabel">Mode</span>
      <span class="picker-chevron">▾</span>
    </button>
    <div class="picker-dropdown" id="modeDropdown"></div>
  </div>
  <!-- Legacy model picker (hidden when configOptions present) -->
  <div class="picker-wrap hidden" id="modelPickerWrap">
    <button class="picker-btn" id="modelPickerBtn">
      <span class="picker-icon">🧠</span>
      <span class="picker-label" id="modelPickerLabel">Model</span>
      <span class="picker-chevron">▾</span>
    </button>
    <div class="picker-dropdown" id="modelDropdown"></div>
  </div>
  <span class="toolbar-spacer"></span>
</div>
```

### 1.2 Add picker CSS styles

From vscode-acp's `ChatWebviewProvider.ts` styles (lines 822–933), copy:
- `.picker-wrap` — positioned wrapper for button + dropdown
- `.picker-btn` — toolbar button with icon, label, chevron
- `.picker-dropdown` — positioned dropdown (opens upward from toolbar)
- `.picker-dropdown-item` — individual option with checkmark
- `.picker-dropdown-group-header` — grouped option headers
- `.picker-tooltip` — hover tooltip for option descriptions

### 1.3 Add picker TypeScript logic to `webview-app.ts`

Key functions to implement:

| Function | Purpose |
|----------|---------|
| `updateModePicker(modes)` | Populate legacy mode dropdown from `{ availableModes, currentModeId }` |
| `updateModelPicker(models)` | Populate legacy model dropdown from `{ availableModels, currentModelId }` |
| `renderModeDropdown()` / `renderModelDropdown()` | Build dropdown DOM with ✓ indicators |
| `setConfigOptionsState(opts)` | Replace all pickers with ACP SessionConfigOption select controls |
| `renderConfigPickers(opts)` | Dynamically build `<div class="picker-wrap">` per config option |
| `renderConfigDropdown(dropdown, opt)` | Build option dropdown (supports grouped options) |
| `buildConfigItem(opt, value)` | Single config option dropdown item |
| `closePickers()` | Close all open dropdowns |

State variables:
- `availableModes: { id, name, description }[]`
- `currentModeId: string | null`
- `availableModels: { modelId, name, description }[]`
- `currentModelId: string | null`
- `configOptions: SessionConfigOption[]`
- `useConfigOptions: boolean`

### 1.4 Add message handling in `chatProvider.ts`

Add handlers for messages from the webview:

```typescript
case "setMode":
  await this._client?.setSessionMode(this._sessionId!, data.modeId);
  break;
case "setModel":
  await this._client?.setSessionModel(this._sessionId!, data.modelId);
  break;
case "setConfigOption":
  // See 1.5 below
  break;
```

Add forwarding of `current_mode_update` notification data to include the full modes object, not just `currentModeId`. Currently only forwards `currentModeId` — need to also capture `availableModes` from the agent's `newSession` response.

### 1.5 Add `setSessionConfigOption` to ACP client

`src/acp/client.ts` needs:

```typescript
async setSessionConfigOption(
  sessionId: string,
  configId: string,
  value: string
): Promise<{ configOptions: SessionConfigOption[] }> {
  return this._sendRequest("session/set_config_option", {
    sessionId, configId, value
  }) as Promise<{ configOptions: SessionConfigOption[] }>;
}
```

Add `SessionConfigOption` type to `src/acp/types.ts`:

```typescript
export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: "mode" | "model" | "thought_level" | string;
  type: "select";
  currentValue: string;
  options: ConfigOptionValue[] | ConfigOptionGroup[];
}

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOptionGroup {
  group: string;
  name?: string;
  options: ConfigOptionValue[];
}
```

Add `config_option_update` notification handling in `chatProvider.ts`:

```typescript
case "config_option_update":
  this._postMessage({
    type: "configOptionsUpdate",
    configOptions: update.configOptions,
  });
  break;
```

### 1.6 Capture modes/models/configOptions from `newSession` response

The `newSession` ACP response includes `modes`, `models`, and `configOptions`. Currently hermes-vscode's `chatProvider.newSession()` only captures `sessionId`. Update it to also forward modes/models/configOptions to the webview on session creation:

```typescript
const result = await this._client.newSession({...});
this._sessionId = result.sessionId;
this._postMessage({
  type: "sessionReady",
  sessionId: result.sessionId,
  modes: result.modes,           // NEW
  models: result.models,         // NEW
  configOptions: result.configOptions, // NEW
  availableCommands: result.availableCommands, // NEW
});
```

### 1.7 Update `NewSessionResult` type

In `src/acp/types.ts`:

```typescript
export interface NewSessionResult {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: ModeOption[] };
  models?: { currentModelId: string; availableModels: ModelOption[] };
  configOptions?: SessionConfigOption[];
  availableCommands?: AvailableCommand[];
}

export interface ModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelOption {
  modelId: string;
  name: string;
  description?: string;
}
```

---

## Phase 2: Agent Selection Tree View

**Current state:** hermes-vscode connects to a single Hermes ACP agent process configured via VS Code settings. There is no tree view, no session browser, no agent switcher — the user gets one agent and one session.

**What vscode-acp provides:** A two-tier tree:
- **Tier 1 — Agents:** Lists configured agents by name with status icons (connected/disconnected/loading)
- **Tier 2 — Sessions:** Expand an agent to see its session history with titles, timestamps, and connect/load/resume actions

### 2.1 Create `src/tree/SessionTreeProvider.ts`

**File:** `~/Code/hermes-vscode/src/tree/SessionTreeProvider.ts`

Implement `vscode.TreeDataProvider` with these tree item types:

```typescript
class AgentTreeItem extends vscode.TreeItem {
  // Shows agent name + status icon
  // contextValue: "agent" | "agent-connected" | "agent-error"
  // Command on click: "hermes.connectAgent" 
  // Collapsible: always (even when empty — shows loading/empty state)
}

class SessionTreeItem extends vscode.TreeItem {
  // Shows session title or first-prompt-preview with timestamp
  // contextValue: "session"
  // Command on click: loads/resumes the session
  // Icon shows session state
}

class InfoTreeItem extends vscode.TreeItem {
  // Placeholder states: "Loading sessions...", "No sessions", "Connect to see sessions"
  // Non-interactive
}
```

**Data source:** 
- Agents → read from VS Code `hermes.agents` configuration (or the existing `hermes.path`/`hermes.args` config if keeping single-agent model)
- Sessions → call `client.listSessions()` when an agent node is expanded

### 2.2 Register tree view in `extension.ts`

```typescript
const treeProvider = new SessionTreeProvider(
  () => client,
  chatProvider,
  outputChannel,
);
context.subscriptions.push(
  vscode.window.registerTreeDataProvider("hermes.sessions", treeProvider),
);
```

### 2.3 Add to `package.json` contributes

```json
"contributes": {
  "views": {
    "hermes": [
      {
        "id": "hermes.sessions",
        "name": "Sessions"
      }
    ]
  },
  "viewsContainers": {
    "activitybar": [
      {
        "id": "hermes",
        "title": "Hermes Agent",
        "icon": "$(hubot)"
      }
    ]
  }
}
```

### 2.4 Wire tree → chat interaction

When a session is clicked in the tree:
1. If it's the active session → focus the chat view
2. If it's a different session for the same agent → call `client.loadSession()` or `client.resumeSession()`, then update chatProvider's sessionId
3. If it's a different agent → disconnect current, spawn new agent process, create session, update chatProvider

The `chatProvider` needs new public methods:

```typescript
switchToSession(sessionId: string): Promise<void>
switchToAgentSession(agentName: string, sessionId: string): Promise<void>
```

---

## Phase 3: Session History Store (Optional Enhancement)

vscode-acp maintains a lightweight `SessionHistoryStore` that persists session metadata locally (`~/.vscode-acp/sessions/`). This enables the tree to show session history even before connecting to an agent.

For hermes-vscode, implement as:

**File:** `src/tree/SessionHistoryStore.ts`

- Stores per-agent session entries (id, title, createdAt, lastActiveAt, firstPrompt, cwd)
- Uses VS Code's `globalState` or a JSON file
- Reconciles with agent-provided session list on `listSessions()`
- Prunes entries the agent no longer knows about

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/chat/chatProvider.ts` | **Modify** | Add `setMode`/`setModel`/`setConfigOption` webview message handlers; forward modes/models/configOptions on session creation; add `config_option_update` notification handling |
| `src/chat/webview-app.ts` | **Modify** | Add picker toolbar HTML + CSS + all dropdown rendering/state logic |
| `src/acp/client.ts` | **Modify** | Add `setSessionConfigOption()` method |
| `src/acp/types.ts` | **Modify** | Add `SessionConfigOption`, `ConfigOptionValue`, `ConfigOptionGroup`, `ModeOption`, `ModelOption` types; extend `NewSessionResult` |
| `src/tree/SessionTreeProvider.ts` | **Create** | Agent → sessions tree data provider |
| `src/tree/SessionHistoryStore.ts` | **Create** | Local session metadata persistence |
| `src/extension.ts` | **Modify** | Register tree view, instantiate providers |
| `package.json` | **Modify** | Add views, viewsContainers, commands |

---

## Migration Notes

1. **CSS namespace:** vscode-acp uses raw CSS in the HTML template. Since hermes-vscode bundles via esbuild, the CSS can either stay inline or move to a separate imported CSS file. Keep inline initially for simplicity.

2. **Single vs multi-agent:** hermes-vscode currently connects to exactly one Hermes process. The tree view should start with single-agent support and be designed for future multi-agent expansion.

3. **ACP protocol compatibility:** Both projects use the same ACP JSON-RPC protocol. The `session/set_model`, `session/set_mode`, and `session/set_config_option` methods should already be supported by the Hermes agent server (`hermes acp`). Verify these endpoints exist before implementing the UI.

4. **State persistence:** Chat history is already persisted via `vscode.getState()/setState()`. Mode/model/config option state should be persisted alongside chat state so it survives webview reloads.

---

## Verification Checklist

- [ ] Mode dropdown appears in toolbar when agent reports `modes` in `newSession`
- [ ] Model dropdown appears in toolbar when agent reports `models` in `newSession`
- [ ] Selecting a mode/model from dropdown sends correct ACP call and updates label
- [ ] Config options dynamically replace legacy pickers when agent provides `configOptions`
- [ ] Grouped config options render with section headers
- [ ] Tooltip shows option descriptions on hover
- [ ] Picker state survives webview reload (vscode state persistence)
- [ ] Agent tree view shows configured agents
- [ ] Expanding agent node loads session list
- [ ] Clicking a session in tree switches chat to that session
- [ ] Empty/loading/error states render correctly in tree
