/**
 * Chat panel webview provider — manages the Hermes Agent chat sidebar.
 *
 * Uses @agentclientprotocol/sdk via HermesClient for ACP communication.
 */

import * as vscode from "vscode";
import * as path from "path";
import { HermesClient } from "../acp/hermesClient";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { SessionHistoryStore } from "../persistence/sessionHistoryStore";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "hermes.chatView";

  private _view?: vscode.WebviewView;
  private _client?: HermesClient;
  private _sessionId?: string;
  private _isSending = false;

  private _modes: any[] = [];
  private _models: any[] = [];
  private _configOptions: any[] = [];
  private _sessionStore?: SessionHistoryStore;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _outputChannel: vscode.OutputChannel,
    sessionStore?: SessionHistoryStore,
  ) {
    this._sessionStore = sessionStore;
  }

  setSessionStore(store: SessionHistoryStore): void {
    this._sessionStore = store;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  setClient(client: HermesClient): void {
    this._client = client;
  }

  // ── Handle agent → client session updates (called from extension.ts Client impl) ──

  handleSessionUpdate(params: SessionNotification): Promise<void> {
    const update: any = (params as any).update;
    const sessionUpdate = update.sessionUpdate;

    this._outputChannel.appendLine(
      `[Hermes:notif] ← session/update ${sessionUpdate}`,
    );

    switch (sessionUpdate) {
      case "agent_message_chunk":
        this._handleMessageChunk(update);
        break;
      case "user_message_chunk":
        this._handleUserMessageChunk(update);
        break;
      case "agent_thought_chunk":
        this._handleThoughtChunk(update);
        break;
      case "tool_call":
        this._handleToolCallStart(update);
        break;
      case "tool_call_update":
        this._handleToolCallProgress(update);
        break;
      case "usage":
        this._handleUsageUpdate(update);
        break;
      case "plan":
        this._handlePlanUpdate(update);
        break;
      case "current_mode_update":
        this._handleModeUpdate(update);
        break;
      case "session_info_update":
        this._handleSessionInfoUpdate(update);
        break;
      case "available_commands_update":
        this._handleAvailableCommandsUpdate(update);
        break;
      default:
        this._outputChannel.appendLine(
          `[Hermes:notif] unknown sessionUpdate: ${sessionUpdate}`,
        );
    }

    return Promise.resolve();
  }

  // ── Session Management ──────────────────────────────────────────────────

  async newSession(): Promise<void> {
    if (!this._client) return;

    try {
      const resolvedCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

      const result: any = await this._client.conn.newSession({
        cwd: resolvedCwd,
        mcpServers: [],
      } as any);

      this._sessionId = result.sessionId;

      if (result.modes) this._modes = this._toConfigOptions(result.modes);
      if (result.models) {
        this._outputChannel.appendLine(`[Hermes:DEBUG] newSession result.models type: ${Array.isArray(result.models) ? 'array' : typeof result.models}, keys: ${Object.keys(result.models).join(',')}`);
        if (!Array.isArray(result.models) && result.models.currentModelId) {
          this._outputChannel.appendLine(`[Hermes:DEBUG] newSession currentModelId: ${result.models.currentModelId}`);
        }
        this._models = this._toConfigOptions(result.models);
      }
      if (result.configOptions) this._configOptions = result.configOptions;

      this._sessionStore?.addSession({
        id: result.sessionId,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        isActive: true,
      });

      this._postMessage({
        type: "sessionReady",
        sessionId: result.sessionId,
        modes: this._modes,
        models: this._models,
        configOptions: this._configOptions,
      });

      this._outputChannel.appendLine(`[Hermes] Session created: ${result.sessionId}`);
    } catch (err) {
      this._outputChannel.appendLine(`[Hermes] New session failed: ${err}`);
      throw err;
    }
  }

  async loadSession(sessionId: string): Promise<void> {
    if (!this._client) return;
    try {
      const result: any = await this._client.conn.loadSession({
        sessionId,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        mcpServers: [],
      } as any);
      this._sessionId = result.sessionId;

      if (result.modes) this._modes = this._toConfigOptions(result.modes);
      if (result.models) this._models = this._toConfigOptions(result.models);

      this._sessionStore?.updateSession(sessionId, {
        lastActive: new Date().toISOString(),
        isActive: true,
      });

      this._postMessage({
        type: "sessionLoaded",
        sessionId: result.sessionId,
        modes: this._modes,
        models: this._models,
      });
    } catch (err) {
      this._outputChannel.appendLine(`[Hermes] Load session failed: ${err}`);
      throw err;
    }
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  sendUserMessage(text: string): void {
    this._handleUserMessage(text);
  }

  private async _handleUserMessage(text: string): Promise<void> {
    try {
      const stopReason = await this.sendMessage(text);
      this._outputChannel.appendLine(`[Hermes] Message sent: ${stopReason}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Hermes: Failed to send message - ${err}`);
    }
  }

  // Track active tool calls to detect missing completion events
  private _activeToolCalls = new Map<string, string>(); // toolCallId → toolName

  async sendMessage(text: string): Promise<string> {
    if (!this._client || !this._sessionId) {
      throw new Error("Not connected");
    }

    this._activeToolCalls.clear();
    this._postMessage({ type: "generationStarted" });

    try {
      const result: any = await this._client.conn.prompt({
        sessionId: this._sessionId,
        prompt: [{ type: "text", text }],
      } as any);

      // Log prompt result structure
      this._outputChannel.appendLine(
        `[Hermes:DEBUG] prompt result keys: ${JSON.stringify(Object.keys(result || {}))}`,
      );
      this._outputChannel.appendLine(
        `[Hermes:DEBUG] prompt result stopReason: ${result?.stopReason}`,
      );

      // Check for tool calls that never got a completion event
      if (this._activeToolCalls.size > 0) {
        const missed: string[] = [];
        this._activeToolCalls.forEach((name, id) => missed.push(`${id}(${name})`));
        this._outputChannel.appendLine(
          `[Hermes:DEBUG] ⚠️ ${missed.length} tool calls never received completion: ${missed.join(", ")}`,
        );
        // Send synthetic completion events for any missed tool calls
        this._activeToolCalls.forEach((_name, id) => {
          this._postMessage({
            type: "toolCallProgress",
            toolCallId: id,
            status: "completed",
            output: "",
          });
        });
        this._activeToolCalls.clear();
      }

      this._postMessage({ type: "generationComplete" });
      return result.stopReason ?? "done";
    } catch (err) {
      this._postMessage({ type: "generationError", error: String(err) });
      throw err;
    }
  }

  async cancelRequest(): Promise<void> {
    if (!this._client || !this._sessionId) return;
    try {
      await this._client.conn.cancel({ sessionId: this._sessionId } as any);
    } catch {
      // Cancel can fail if nothing is running — ignore
    }
  }

  private async _handleSetModel(model: string, provider?: string): Promise<void> {
    if (!this._client || !this._sessionId) return;
    try {
      await this._client.conn.unstable_setSessionModel({
        sessionId: this._sessionId,
        modelId: model,
      } as any);
    } catch (err) {
      this._outputChannel.appendLine(`[Hermes] Failed to set model: ${err}`);
    }
  }

  private async _handleSetMode(mode: string): Promise<void> {
    if (!this._client || !this._sessionId) return;
    try {
      await this._client.conn.setSessionMode({
        sessionId: this._sessionId,
        modeId: mode,
      } as any);
    } catch (err) {
      this._outputChannel.appendLine(`[Hermes] Failed to set mode: ${err}`);
    }
  }

  private async _handleSetConfig(key: string, value: any): Promise<void> {
    if (!this._client || !this._sessionId) return;
    try {
      await this._client.conn.setSessionConfigOption({
        sessionId: this._sessionId,
        key,
        value,
      } as any);
    } catch (err) {
      this._outputChannel.appendLine(`[Hermes] Failed to set config: ${err}`);
    }
  }

  // ── Webview Message Handling ─────────────────────────────────────────────

  private _onWebviewMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "requestState":
        this._postMessage({
          type: "sessionReady",
          sessionId: this._sessionId,
          modes: this._modes,
          models: this._models,
          configOptions: this._configOptions,
        });
        break;

      case "sendMessage":
        this._handleUserMessage(msg.text as string);
        break;

      case "cancelRequest":
        this.cancelRequest();
        break;

      case "setSessionModel":
        this._handleSetModel(msg.model as string, msg.provider as string | undefined);
        break;

      case "setSessionMode":
        this._handleSetMode(msg.mode as string);
        break;

      case "setSessionConfig":
        this._handleSetConfig(msg.key as string, msg.value);
        break;

      case "newSession":
        this.newSession();
        break;

      case "stopGeneration":
        this.cancelRequest();
        break;
    }
  }

  // ── Notification Handlers (all use any for ACP→SDK type bridge) ──────────

  private _handleMessageChunk(update: any): void {
    this._postMessage({
      type: "agentMessageChunk",
      text: update.content?.text ?? "",
      messageId: update.messageId,
    });
  }

  private _handleUserMessageChunk(update: any): void {
    this._postMessage({
      type: "userMessageChunk",
      text: update.content?.text ?? "",
      messageId: update.messageId,
    });
  }

  private _handleThoughtChunk(update: any): void {
    const content = update.content;
    this._postMessage({
      type: "agentThoughtChunk",
      text: typeof content === "string" ? content : content?.text ?? "",
    });
  }

  private _handleToolCallStart(update: any): void {
    const id = update.toolCallId ?? update.tool_call_id;
    const name = update.toolName ?? update.tool_name ?? update.title ?? "Unknown tool";
    this._activeToolCalls.set(id, name);
    this._outputChannel.appendLine(
      `[Hermes:DEBUG] tool_call START id=${id} name=${name} keys=${JSON.stringify(Object.keys(update))}`,
    );
    this._postMessage({
      type: "toolCallStart",
      toolCallId: id,
      toolName: name,
      title: update.title,
    });
  }

  private _handleToolCallProgress(update: any): void {
    const id = update.toolCallId ?? update.tool_call_id;
    const had = this._activeToolCalls.has(id);
    // Remove from tracking when completed or errored
    if (update.status === "completed" || update.status === "error") {
      this._activeToolCalls.delete(id);
    }
    this._outputChannel.appendLine(
      `[Hermes:DEBUG] tool_call_update id=${id} status=${update.status} wasTracked=${had} keys=${JSON.stringify(Object.keys(update))}`,
    );
    this._postMessage({
      type: "toolCallProgress",
      toolCallId: id,
      status: update.status,
      output: update.output ?? update.rawOutput,
      title: update.title,
    });
  }

  private _handleUsageUpdate(update: any): void {
    this._postMessage({ type: "usageUpdate", usage: update.usage });
  }

  private _handlePlanUpdate(update: any): void {
    this._postMessage({ type: "planUpdate", plan: update.plan ?? update });
  }

  private _handleModeUpdate(update: any): void {
    this._postMessage({ type: "modeUpdate", mode: update.mode ?? update.currentMode });
  }

  private _handleSessionInfoUpdate(update: any): void {
    this._postMessage({ type: "sessionInfoUpdate", title: update.title });
    if (update.title && this._sessionId) {
      this._sessionStore?.updateSession(this._sessionId, { title: update.title });
    }
  }

  private _handleAvailableCommandsUpdate(update: any): void {
    this._postMessage({ type: "availableCommands", commands: update.availableCommands });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private _postMessage(msg: Record<string, unknown>): void {
    this._view?.webview.postMessage(msg);
  }

  private _toConfigOptions(state: any): any[] {
    if (Array.isArray(state)) {
      return state.map((s: any) => ({
        id: s.id || s.modeId || s.modelId || "",
        label: s.label || s.name || s.id || "",
        selected: s.selected || s.current || false,
        provider: s.provider,
      }));
    }
    if (state.availableModes) {
      return state.availableModes.map((m: any) => ({
        id: m.id,
        label: m.label || m.name || m.id,
        selected: m.id === state.currentModeId,
      }));
    }
    if (state.availableModels) {
      this._outputChannel.appendLine(`[Hermes:DEBUG] _toConfigOptions models: currentModelId=${state.currentModelId}, count=${state.availableModels.length}`);
      return state.availableModels.map((m: any) => ({
        id: m.modelId || m.id,
        label: m.name || m.label || m.modelId || m.id,
        selected: (m.modelId || m.id) === state.currentModelId,
        provider: m.provider,
      }));
    }
    return [];
  }

  // ── VS Code WebviewViewProvider ─────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      (msg) => this._onWebviewMessage(msg),
    );
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private _getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this._extensionUri.fsPath, "dist", "webview-bundle.js")),
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this._extensionUri.fsPath, "node_modules", "@vscode/codicons", "dist", "codicon.css"),
      ),
    );
    const hljsCss = webview.asWebviewUri(
      vscode.Uri.file(path.join(this._extensionUri.fsPath, "dist", "github-dark.min.css")),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${codiconsUri}">
  <link rel="stylesheet" href="${hljsCss}">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: var(--vscode-sideBar-background);
      --fg: var(--vscode-sideBar-foreground);
      --dim: var(--vscode-descriptionForeground);
      --border: var(--vscode-sideBar-border);
      --accent: var(--vscode-focusBorder);
      --tool-bg: var(--vscode-editor-background);
      --tool-fg: var(--vscode-editor-foreground);
      --radius: 8px;
      --msg-user: var(--vscode-textLink-foreground);
      --msg-assistant: var(--vscode-foreground);
      --code-bg: var(--vscode-textCodeBlock-background);
    }
    html, body { height: 100%; overflow: hidden; }
    body {
      display: flex; flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--fg);
      background: var(--bg);
    }
    #session-toolbar {
      display: flex; gap: 6px; padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--tool-bg);
    }
    #session-toolbar select {
      flex: 1; min-width: 0;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px; padding: 3px 6px;
      font-size: 12px; font-family: inherit;
      cursor: pointer;
    }
    #session-toolbar select:focus { outline: 1px solid var(--accent); }
    #session-toolbar select:disabled { opacity: 0.5; cursor: default; }
    #session-toolbar label { font-size: 10px; color: var(--dim); align-self: center; white-space: nowrap; }

    /* Toolbar actions */
    .toolbar-actions { display: flex; gap: 4px; align-items: center; }
    .toolbar-btn {
      background: none; border: 1px solid var(--border);
      border-radius: 4px; padding: 3px 6px; cursor: pointer;
      color: var(--dim); font-size: 14px;
      display: flex; align-items: center;
    }
    .toolbar-btn:hover { color: var(--fg); background: var(--tool-bg); }
    .toolbar-btn.active { color: var(--accent); border-color: var(--accent); }

    /* Status indicator */
    .status {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--vscode-testing-iconFailed);
      flex-shrink: 0; margin-right: 4px;
    }
    .status.connected { background: var(--vscode-testing-iconPassed); }

    #messages {
      flex: 1; overflow-y: auto;
      padding: 8px;
    }
    .msg {
      margin-bottom: 16px;
      animation: fadeIn 0.2s ease;
      display: flex;
      flex-direction: column;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } }

    /* User messages — right-aligned, accent-colored */
    .msg-user { align-items: flex-end; }
    .msg-user .msg-bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 14px 14px 4px 14px;
    }

    /* Assistant messages — left-aligned, neutral */
    .msg-assistant { align-items: flex-start; }
    .msg-assistant .msg-bubble {
      background: var(--tool-bg);
      border: 1px solid var(--border);
      border-radius: 14px 14px 14px 4px;
    }

    /* Shared bubble styles */
    .msg-bubble {
      padding: 10px 14px;
      max-width: 88%;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    /* ── Markdown element styling ─────────────────────────────── */
    .msg-bubble h1, .msg-bubble h2, .msg-bubble h3,
    .msg-bubble h4, .msg-bubble h5, .msg-bubble h6 {
      margin: 16px 0 8px; line-height: 1.3;
    }
    .msg-bubble h1 { font-size: 1.4em; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    .msg-bubble h2 { font-size: 1.25em; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 3px; }
    .msg-bubble h3 { font-size: 1.1em; font-weight: 600; }
    .msg-bubble h4 { font-size: 1em; font-weight: 600; }
    .msg-bubble h5 { font-size: 0.95em; font-weight: 600; }
    .msg-bubble h6 { font-size: 0.9em; font-weight: 600; color: var(--dim); }
    .msg-bubble h1:first-child, .msg-bubble h2:first-child,
    .msg-bubble h3:first-child, .msg-bubble h4:first-child { margin-top: 0; }

    .msg-bubble p { margin: 0 0 8px; }
    .msg-bubble p:last-child { margin-bottom: 0; }

    .msg-bubble ul, .msg-bubble ol { margin: 4px 0 8px; padding-left: 24px; }
    .msg-bubble li { margin-bottom: 2px; }
    .msg-bubble li > ul, .msg-bubble li > ol { margin: 2px 0; }

    .msg-bubble blockquote {
      margin: 8px 0; padding: 4px 12px;
      border-left: 3px solid var(--accent);
      color: var(--dim); background: var(--tool-bg);
      border-radius: 0 4px 4px 0;
    }

    .msg-bubble a { color: var(--vscode-textLink-foreground); }
    .msg-bubble a:hover { color: var(--vscode-textLink-activeForeground); }

    .msg-bubble strong { font-weight: 700; }
    .msg-bubble em { font-style: italic; }

    .msg-bubble hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }

    /* Inline code */
    .msg-bubble code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--code-bg);
      padding: 1px 5px; border-radius: 3px;
    }
    .msg-bubble pre code {
      background: none; padding: 0; border-radius: 0;
    }

    /* Code blocks */
    .msg-bubble pre {
      margin: 8px 0; padding: 12px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em; line-height: 1.45;
      position: relative;
    }

    /* Tables */
    .msg-bubble table { border-collapse: collapse; margin: 8px 0; width: 100%; }
    .msg-bubble th, .msg-bubble td {
      border: 1px solid var(--border); padding: 6px 10px; text-align: left;
    }
    .msg-bubble th { background: var(--tool-bg); font-weight: 600; }
    .msg-bubble tr:nth-child(even) td { background: var(--tool-bg); }

    /* Images */
    .msg-bubble img { max-width: 100%; border-radius: var(--radius); }

    /* Task lists */
    .msg-bubble input[type="checkbox"] { margin-right: 6px; }

    .msg-system { text-align: center; color: var(--dim); font-size: 11px; margin: 8px 0; }
    .tool-block {
      margin: 8px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .tool-block .header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: var(--tool-bg);
      font-size: 12px; font-weight: 500;
      cursor: pointer;
    }
    .tool-block .body {
      padding: 8px 10px; font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap; max-height: 300px; overflow: auto;
      background: var(--code-bg);
    }
    .thinking {
      color: var(--dim); font-style: italic;
      padding: 4px 0; font-size: 12px;
    }
    /* Reasoning (agent thought chunks) */
    .reasoning {
      color: var(--dim); font-style: italic;
      padding: 4px 0; margin-bottom: 6px;
      font-size: 12px;
      border-left: 2px solid var(--border);
      padding-left: 8px;
    }
    .reasoning-cursor {
      display: inline-block;
      color: var(--accent);
      animation: blink 1s step-end infinite;
      margin-left: 1px;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    /* Tool calls */
    .tool-call {
      margin: 6px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .tool-call .tool-header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: var(--tool-bg);
      font-size: 12px;
      cursor: pointer;
    }
    .tool-call .tool-header:hover { opacity: 0.85; }
    .tool-call .tool-icon { font-size: 14px; }
    .tool-call .tool-name { font-weight: 500; flex: 1; }
    .tool-call .tool-status {
      font-size: 10px; padding: 2px 6px;
      border-radius: 4px;
      background: var(--dim); color: var(--bg);
    }
    .tool-call .tool-status.running {
      background: var(--vscode-testing-iconQueued); color: var(--bg);
    }
    .tool-call .tool-status.done {
      background: var(--vscode-testing-iconPassed); color: var(--bg);
    }
    .tool-call .tool-status.error {
      background: var(--vscode-testing-iconFailed); color: var(--bg);
    }
    .tool-call .tool-output {
      display: none;
      padding: 8px 10px; font-size: 12px;
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap; max-height: 300px; overflow: auto;
      background: var(--code-bg);
      border-top: 1px solid var(--border);
    }
    .tool-call.open .tool-output { display: block; }
    /* Plan / todo list */
    .plan {
      margin: 8px 0; padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--tool-bg);
    }
    .plan h4 { margin: 0 0 6px; font-size: 13px; }
    .plan-item {
      padding: 3px 0; font-size: 12px;
      display: flex; gap: 6px; align-items: flex-start;
    }
    .plan-item .check { flex-shrink: 0; }
    .plan-item.done { color: var(--dim); text-decoration: line-through; }
    .plan-item.in-progress { font-weight: 500; }
    /* Code blocks */
    pre {
      position: relative;
      margin: 8px 0;
      border-radius: var(--radius);
      overflow: hidden;
    }
    pre code {
      display: block; padding: 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      overflow-x: auto;
    }
    .copy-btn {
      position: absolute; top: 4px; right: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none; border-radius: 4px;
      padding: 2px 8px; font-size: 10px;
      cursor: pointer;
    }
    .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    /* Message-level copy actions */
    .msg-actions {
      display: flex;
      gap: 6px;
      margin-top: 6px;
      justify-content: flex-end;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .msg:hover .msg-actions,
    .msg-actions:hover {
      opacity: 1;
    }
    .msg-action-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      padding: 3px 10px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }
    .msg-action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #input-area {
      display: flex; gap: 4px;
      padding: 8px;
      border-top: 1px solid var(--border);
    }
    #input-area textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--radius);
      padding: 8px;
      resize: none;
      font-family: inherit;
      font-size: var(--vscode-font-size);
      min-height: 36px;
      max-height: 120px;
    }
    #input-area textarea:focus { outline: 1px solid var(--accent); }
    #input-area button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: var(--radius);
      padding: 6px 12px;
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
    }
    #input-area button:hover { background: var(--vscode-button-hoverBackground); }
    #input-area button:disabled { opacity: 0.5; cursor: default; }
    #debug-panel {
      display: none;
      border-top: 1px solid var(--border);
      max-height: 200px; overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px; padding: 4px 8px;
      background: var(--code-bg);
    }
    #debug-panel.visible { display: block; }
    .debug-entry { padding: 1px 0; white-space: pre-wrap; }
    .debug-entry .time { color: var(--dim); margin-right: 6px; }
    .debug-entry .dir-in { color: var(--vscode-testing-iconPassed); }
    .debug-entry .dir-out { color: var(--vscode-testing-iconQueued); }
    .debug-entry .dir-err { color: var(--vscode-testing-iconFailed); }
    .debug-entry .summary { color: var(--fg); }
    .empty-state {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; height: 100%; gap: 12px;
      color: var(--dim); text-align: center; padding: 24px;
    }
    .empty-state h3 { font-weight: 400; }
    .empty-state .suggestions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
    .empty-state .suggestion {
      background: var(--tool-bg); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 6px 12px; font-size: 12px;
      cursor: pointer;
    }
    /* Typing dots inside assistant bubble */
    .msg-bubble .typing {
      display: flex; align-items: center; gap: 5px;
      padding: 6px 0;
    }
    .typing-dot {
      width: 6px; height: 6px;
      background: var(--dim);
      border-radius: 50%;
      animation: bounce 1.2s infinite ease-in-out;
    }
    .typing-dot:nth-child(1) { animation-delay: 0s; }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-6px); opacity: 1; }
    }
    /* Pulse the status dot when generating */
    .status.generating {
      animation: pulse 1s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.3); }
    }
  </style>
</head>
<body>
  <div id="session-toolbar">
    <div class="status" id="status-indicator" title="Connection status"></div>
    <label>Mode:</label>
    <select id="mode-select"><option value="">Auto</option></select>
    <label>Model:</label>
    <select id="model-select"><option value="">Default</option></select>
    <select id="config-select"><option value="">Config…</option></select>
    <div class="toolbar-actions">
      <button class="toolbar-btn" id="debug-toggle" title="Toggle debug panel">
        <span class="codicon codicon-debug"></span>
      </button>
      <button class="toolbar-btn" id="new-session-btn" title="New session">
        <span class="codicon codicon-add"></span>
      </button>
    </div>
  </div>
  <div id="messages">
    <div class="empty-state" id="empty-state">
      <h3>Hermes Agent</h3>
      <p>AI coding assistant ready to help</p>
      <div class="suggestions">
        <div class="suggestion" data-prompt="Explain this project">Explain this project</div>
        <div class="suggestion" data-prompt="What can you help me with?">What can you do?</div>
        <div class="suggestion" data-prompt="Review my code for bugs">Review my code</div>
      </div>
    </div>
  </div>
  <div id="debug-panel"></div>
  <div id="input-area">
    <textarea id="input-box" placeholder="Ask Hermes…" rows="1"></textarea>
    <button id="send-btn" title="Send (Enter)"><span class="codicon codicon-send"></span></button>
    <button id="stop-btn" title="Stop (Esc)"><span class="codicon codicon-debug-stop"></span></button>
  </div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
