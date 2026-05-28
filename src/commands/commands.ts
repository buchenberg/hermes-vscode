/**
 * Hermes Agent commands — registered in package.json and implemented here.
 */

import * as vscode from "vscode";
import { HermesClient } from "../acp/hermesClient";
import { ChatViewProvider } from "../chat/chatProvider";
import { SessionHistoryStore, SessionRecord } from "../persistence/sessionHistoryStore";
import { SessionTreeProvider } from "../views/sessionTreeProvider";

/**
 * Register all Hermes commands for the extension.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  client: () => HermesClient | undefined,
  chatProvider: ChatViewProvider,
  outputChannel: vscode.OutputChannel,
  statusBarItem: vscode.StatusBarItem,
  sessionStore?: SessionHistoryStore,
  sessionTree?: SessionTreeProvider,
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // ── Start Agent ──────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.startAgent", async () => {
      outputChannel.appendLine("[Hermes] Starting agent...");
      try {
        // trigger the auto-start flow from extension.ts
        await vscode.commands.executeCommand("hermes.restartAgent");
      } catch (err) {
        outputChannel.appendLine(`[Hermes] Start failed: ${err}`);
        statusBarItem.text = "$(error) Hermes";
        vscode.window.showErrorMessage(`Hermes: Failed to start - ${err}`);
      }
    }),
  );

  // ── Stop Agent ──────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.stopAgent", async () => {
      outputChannel.appendLine("[Hermes] Stopping agent...");
      try {
        await client()?.stop();
        statusBarItem.text = "$(circle-slash) Hermes";
        statusBarItem.tooltip = "Hermes Agent — stopped";
        vscode.window.showInformationMessage("Hermes Agent stopped");
      } catch (err) {
        outputChannel.appendLine(`[Hermes] Stop failed: ${err}`);
      }
    }),
  );

  // ── Restart Agent ───────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.restartAgent", async () => {
      outputChannel.appendLine("[Hermes] Restarting agent...");
      try {
        await client()?.stop();
        // Re-trigger auto-start
        const config = vscode.workspace.getConfiguration("hermes");
        if (config.get<boolean>("autoStart", true)) {
          // Force a config change event to trigger restart
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } catch (err) {
        outputChannel.appendLine(`[Hermes] Restart failed: ${err}`);
        vscode.window.showErrorMessage(`Hermes: Restart failed - ${err}`);
      }
    }),
  );

  // ── Open Chat ───────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.openChat", async () => {
      await vscode.commands.executeCommand("hermes-sidebar-container.focus");
    }),
  );

  // ── Send Selection ──────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const text = editor.document.getText(selection);

      if (!text) {
        vscode.window.showInformationMessage("No text selected");
        return;
      }

      const filePath = editor.document.uri.fsPath;
      const fileName = editor.document.fileName.split("/").pop() || editor.document.fileName;
      const language = editor.document.languageId;
      const lineStart = selection.start.line + 1;
      const lineEnd = selection.end.line + 1;

      const message = `In file \`${fileName}\` (${language}) lines ${lineStart}-${lineEnd}:\n\n\`\`\`${language}\n${text}\n\`\`\``;

      chatProvider.sendUserMessage(message);
      await vscode.commands.executeCommand("hermes-sidebar-container.focus");
    }),
  );

  // ── Explain Code ────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.explainCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const fileName = editor.document.fileName.split("/").pop() || editor.document.fileName;
      const language = editor.document.languageId;
      const scope = selection.isEmpty ? "this file" : "this selection";

      const message = `Explain what ${scope} does:\n\nFile: \`${fileName}\` (${language})\n\n\`\`\`${language}\n${text}\n\`\`\``;

      chatProvider.sendUserMessage(message);
      await vscode.commands.executeCommand("hermes-sidebar-container.focus");
    }),
  );

  // ── Fix Code ────────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.fixCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const text = editor.document.getText(selection.isEmpty ? undefined : selection);
      const fileName = editor.document.fileName.split("/").pop() || editor.document.fileName;
      const language = editor.document.languageId;
      const scope = selection.isEmpty ? "this file" : "the selected code";

      const message = `Fix any bugs, issues, or improvements for ${scope}:\n\nFile: \`${fileName}\` (${language})\n\n\`\`\`${language}\n${text}\n\`\`\``;

      chatProvider.sendUserMessage(message);
      await vscode.commands.executeCommand("hermes-sidebar-container.focus");
    }),
  );

  // ── Review Code ─────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.reviewCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const text = document.getText();
      const fileName = document.fileName.split("/").pop() || document.fileName;
      const language = document.languageId;

      const message = `Review this file for bugs, security issues, code quality, and suggestions:\n\nFile: \`${fileName}\` (${language})\n\n\`\`\`${language}\n${text}\n\`\`\``;

      chatProvider.sendUserMessage(message);
      await vscode.commands.executeCommand("hermes-sidebar-container.focus");
    }),
  );

  // ── Setup Agent ─────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.setupAgent", async () => {
      const terminal = vscode.window.createTerminal("Hermes Setup");
      terminal.show();
      const hermesPath = vscode.workspace.getConfiguration("hermes").get<string>("path", "hermes");
      terminal.sendText(`${hermesPath} acp --setup`);
    }),
  );

  // ── Show Status ─────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.showAgentStatus", async () => {
      const hc = client();
      const config = vscode.workspace.getConfiguration("hermes");

      let status = "Hermes Agent Status\n" + "═".repeat(50) + "\n\n";

      if (hc) {
        status += "Status:  ✅ Connected\n";
        status += `Session: ${chatProvider.sessionId || "none"}\n`;
      } else {
        status += "Status:  ⚠️  Not connected\n";
      }

      status += `\nHermes path: ${config.get("path", "hermes")}\n`;
      status += `Auto-start: ${config.get("autoStart", true) ? "Yes" : "No"}\n`;

      await vscode.window.showInformationMessage(
        "Hermes Agent Status",
        { modal: true, detail: status },
        "OK",
      );
    }),
  );

  // ── New Session ─────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.newSession", async () => {
      await chatProvider.newSession();
      vscode.window.showInformationMessage("Hermes: New session started");
    }),
  );

  // ── Show Logs ───────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.showLogs", async () => {
      outputChannel.show(true);
    }),
  );

  // ── Resume Session ──────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.resumeSession", async (sessionId?: string) => {
      if (!sessionId) {
        // Prompt user to pick from history
        const records = sessionStore?.getAllSessions() || [];
        if (records.length === 0) {
          vscode.window.showInformationMessage("No saved sessions to resume.");
          return;
        }
        const items = records.map((r) => ({
          label: r.title || `Session ${r.id.slice(0, 8)}`,
          description: `${r.model || "unknown"} — ${new Date(r.lastActive).toLocaleDateString()}`,
          detail: r.id,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select a session to resume...",
        });
        if (!picked) return;
        sessionId = picked.detail;
      }

      if (!sessionId) return;

      try {
        await chatProvider.loadSession(sessionId);
        sessionStore?.updateSession(sessionId, {
          lastActive: new Date().toISOString(),
          isActive: true,
        });
        sessionTree?.refresh();
        outputChannel.appendLine(`[Hermes] Resumed session: ${sessionId}`);
      } catch (err) {
        outputChannel.appendLine(`[Hermes] Failed to resume session: ${err}`);
        vscode.window.showErrorMessage(`Hermes: Failed to resume session - ${err}`);
      }
    }),
  );

  // ── Fork Session ────────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.forkSession", async (record?: SessionRecord) => {
      if (!record) return;
      try {
        // Create new session and send the context
        await chatProvider.newSession();
        outputChannel.appendLine(`[Hermes] Forked session from: ${record.id}`);

        // Record the new session in history with forked context info
        if (sessionStore && chatProvider.sessionId) {
          sessionStore.addSession({
            id: chatProvider.sessionId,
            title: record.title ? `${record.title} (fork)` : undefined,
            model: record.model,
            provider: record.provider,
            mode: record.mode,
            createdAt: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            isActive: true,
          });
        }
        sessionTree?.refresh();
      } catch (err) {
        outputChannel.appendLine(`[Hermes] Failed to fork session: ${err}`);
        vscode.window.showErrorMessage(`Hermes: Failed to fork session - ${err}`);
      }
    }),
  );

  // ── Delete Session ──────────────────────────────────────────────────
  disposables.push(
    vscode.commands.registerCommand("hermes.deleteSession", async (sessionId?: string) => {
      if (!sessionId || !sessionStore) return;
      const deleted = sessionStore.deleteSession(sessionId);
      if (deleted) {
        outputChannel.appendLine(`[Hermes] Deleted session: ${sessionId}`);
        sessionTree?.refresh();
      }
    }),
  );

  return disposables;
}
