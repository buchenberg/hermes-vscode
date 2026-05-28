/**
 * Hermes Agent VS Code Extension — Main Entry Point
 *
 * Integrates Hermes Agent as a coding agent inside VS Code via ACP
 * (Agent Client Protocol). Uses @agentclientprotocol/sdk for
 * protocol handling and spawns `hermes acp` as a subprocess.
 */

import * as vscode from "vscode";
import * as path from "path";
import { HermesClient } from "./acp/hermesClient";
import type { Client, Agent } from "./acp/hermesClient";
import type { SessionNotification, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { ChatViewProvider } from "./chat/chatProvider";
import { registerCommands } from "./commands/commands";
import { HermesCompletionProvider } from "./inline/completionProvider";
import { SessionHistoryStore } from "./persistence/sessionHistoryStore";
import { SessionTreeProvider } from "./views/sessionTreeProvider";

let client: HermesClient | undefined;
let chatProvider: ChatViewProvider;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let completionProvider: vscode.Disposable | undefined;

// ── Debug helpers ─────────────────────────────────────────────────────────

let debugEnabled = false;

function debugLog(msg: string): void {
  if (debugEnabled) {
    outputChannel?.appendLine(`[Hermes:DEBUG] ${msg}`);
  }
}

function updateDebugMode(): void {
  debugEnabled = vscode.workspace.getConfiguration("hermes").get<boolean>("debug", false);
  if (debugEnabled) {
    outputChannel?.appendLine("[Hermes:DEBUG] Debug logging ENABLED");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Hermes Agent", { log: true });
  outputChannel.appendLine("[Hermes] Extension activating...");
  updateDebugMode();

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(circle-slash) Hermes";
  statusBarItem.tooltip = "Hermes Agent — starting...";
  statusBarItem.command = "hermes.showAgentStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const sessionStore = new SessionHistoryStore(context);
  chatProvider = new ChatViewProvider(context.extensionUri, outputChannel, sessionStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const sessionTreeProvider = new SessionTreeProvider(sessionStore);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("hermes-sessions", sessionTreeProvider),
  );

  const commandDisposables = registerCommands(
    context,
    () => client,
    chatProvider,
    outputChannel,
    statusBarItem,
    sessionStore,
    sessionTreeProvider,
  );
  context.subscriptions.push(...commandDisposables);

  updateInlineCompletions(context);

  const config = vscode.workspace.getConfiguration("hermes");
  if (config.get<boolean>("autoStart", true)) {
    startHermesAgent(context).catch((err) => {
      outputChannel.appendLine(`[Hermes] Auto-start failed: ${err}`);
      statusBarItem.text = "$(error) Hermes";
      statusBarItem.tooltip = `Hermes Agent — failed: ${err}`;
    });
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("hermes")) {
        outputChannel.appendLine("[Hermes] Config changed — restarting agent...");
        restartHermesAgent(context);
      }
      if (e.affectsConfiguration("hermes.showInlineCompletions")) {
        updateInlineCompletions(context);
      }
      if (e.affectsConfiguration("hermes.debug")) {
        updateDebugMode();
      }
    }),
  );

  outputChannel.appendLine("[Hermes] Extension activated");
}

export function deactivate(): void {
  outputChannel?.appendLine("[Hermes] Extension deactivating...");
  completionProvider?.dispose();
  completionProvider = undefined;
  if (client) {
    client.stop().catch(() => {});
    client = undefined;
  }
  outputChannel?.appendLine("[Hermes] Extension deactivated");
}

// ── Agent Lifecycle ────────────────────────────────────────────────────────

async function startHermesAgent(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("hermes");
  const hermesPath = config.get<string>("path", "hermes");
  const hermesArgs = config.get<string[]>("args", []);
  const workingDirectory =
    (config.get<string>("workingDirectory", "") ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ??
    process.cwd();

  const resolvedCwd = workingDirectory.replace(
    "${workspaceFolder}",
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
  );

  outputChannel.appendLine(`[Hermes] Starting ACP client: ${hermesPath} acp`);
  outputChannel.appendLine(`[Hermes] Working directory: ${resolvedCwd}`);

  const hc = new HermesClient({
    hermesPath,
    hermesArgs,
    cwd: resolvedCwd,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      USER: process.env.USER || "",
    },
  });

  // Build the Client implementation that handles agent → client callbacks
  const toClient = (agent: Agent): Client => ({
    sessionUpdate: (params: SessionNotification) => {
      return chatProvider.handleSessionUpdate(params);
    },
    requestPermission: async (params: any): Promise<RequestPermissionResponse> => {
      // Auto-approve all tool calls for now
      outputChannel.appendLine(`[Hermes] Auto-approving permission: ${JSON.stringify(params).slice(0, 200)}`);
      return { outcome: { outcome: "selected", optionId: "always" as any } } as any;
    },
  });

  hc.onStderr((data: string) => {
    outputChannel.append(`[Hermes:stderr] ${data}`);
  });

  hc.onExit((code: number | null, signal: string | null) => {
    outputChannel.appendLine(`[Hermes] ACP process exited (code=${code}, signal=${signal})`);
    statusBarItem.text = "$(circle-slash) Hermes";
    statusBarItem.tooltip = `Hermes Agent — exited (code=${code})`;
    client = undefined;
  });

  hc.onError((err: Error) => {
    outputChannel.appendLine(`[Hermes] ACP error: ${err.message}`);
  });

  try {
    await hc.start(toClient);
    const agentInfo = hc.initResponse.agentInfo;
    outputChannel.appendLine(
      `[Hermes] Connected — server: ${agentInfo?.name ?? "hermes-agent"} v${agentInfo?.version ?? "?"}`,
    );

    client = hc;
    chatProvider.setClient(client);

    // Create initial session
    await chatProvider.newSession();

    statusBarItem.text = "$(check) Hermes";
    statusBarItem.tooltip = "Hermes Agent — connected";
  } catch (err) {
    outputChannel.appendLine(`[Hermes] Start failed: ${err}`);
    statusBarItem.text = "$(error) Hermes";
    statusBarItem.tooltip = `Hermes Agent — failed: ${err}`;
    throw err;
  }
}

async function restartHermesAgent(context: vscode.ExtensionContext): Promise<void> {
  try {
    await client?.stop();
    client = undefined;
  } catch {
    // Ignore cleanup errors
  }

  await startHermesAgent(context).catch((err) => {
    outputChannel.appendLine(`[Hermes] Restart failed: ${err}`);
  });
}

// ── Inline Completions Toggle ───────────────────────────────────────────────

function updateInlineCompletions(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("hermes");
  const enabled = config.get<boolean>("showInlineCompletions", false);

  if (completionProvider) {
    completionProvider.dispose();
    completionProvider = undefined;
  }

  if (!enabled) {
    outputChannel.appendLine("[Hermes] Inline completions disabled");
    return;
  }

  const provider = new HermesCompletionProvider(
    () => client as any, // HermesClient is compatible enough for completions
    () => chatProvider.sessionId,
    outputChannel,
  );

  completionProvider = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    provider,
  );

  context.subscriptions.push(completionProvider);
  outputChannel.appendLine("[Hermes] Inline completions enabled");
}
