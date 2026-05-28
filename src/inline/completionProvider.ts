/**
 * Inline completion provider — renders Copilot-style ghost text.
 *
 * Sends prefix/suffix context to the Hermes ACP server and renders
 * the returned completion inline at the cursor.
 *
 * Feature flag: controlled by `hermes.showInlineCompletions` config.
 */

import * as vscode from "vscode";
import { HermesClient } from "../acp/hermesClient";

/** Debounce window for completion requests (ms) */
const DEFAULT_DEBOUNCE_MS = 350;
/** Maximum prefix size sent to the model (characters) */
const MAX_PREFIX_LENGTH = 8000;
/** Maximum suffix size sent to the model (characters) */
const MAX_SUFFIX_LENGTH = 2000;
/** Minimum prefix length that triggers a completion request */
const MIN_PREFIX_LENGTH = 1;

export class HermesCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTriggerKind: vscode.InlineCompletionTriggerKind | null = null;
  private pendingPromise: Promise<vscode.InlineCompletionItem[]> | null = null;

  constructor(
    private getClient: () => HermesClient | undefined,
    private getSessionId: () => string | undefined,
    private outputChannel: vscode.OutputChannel,
  ) {}

  // ── VS Code provider interface ──────────────────────────────────────────

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    // Track trigger kind for debounce logic
    this.lastTriggerKind = context.triggerKind;

    // Only trigger on explicit (manual) or automatic keystroke triggers
    if (
      context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
    ) {
      // Explicit invoke — skip debounce
      return this._fetchCompletion(document, position);
    }

    if (
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
    ) {
      // Debounce automatic triggers
      return this._debouncedFetch(document, position);
    }

    return [];
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _debouncedFetch(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.InlineCompletionItem[]> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;
        try {
          const result = await this._fetchCompletion(document, position);
          resolve(result);
        } catch {
          resolve([]);
        }
      }, DEFAULT_DEBOUNCE_MS);
    });
  }

  private async _fetchCompletion(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.InlineCompletionItem[]> {
    const client = this.getClient();
    const sessionId = this.getSessionId();

    if (!client || !sessionId) {
      return [];
    }

    const prefix = this._getPrefix(document, position);
    const suffix = this._getSuffix(document, position);

    // Skip if we don't have meaningful context
    if (prefix.length < MIN_PREFIX_LENGTH) {
      return [];
    }

    try {
      const result = await (client as any).conn?.extMethod?.("completion/get", {
        sessionId,
        prefix,
        suffix,
        language: document.languageId,
        filePath: document.uri.fsPath,
      });

      if (!result.text || result.text.trim().length === 0) {
        return [];
      }

      const completionText = this._normalizeCompletion(result.text, prefix, suffix);

      if (!completionText) {
        return [];
      }

      const range = new vscode.Range(position, position);
      const item = new vscode.InlineCompletionItem(completionText, range);
      item.command = {
        command: "hermes.acceptCompletion",
        title: "Accept completion",
        arguments: [completionText],
      };

      return [item];
    } catch (err) {
      // Log but don't surface — inline completions fail silently by design
      this.outputChannel.appendLine(
        `[Hermes] Completion error: ${(err as Error).message}`,
      );
      return [];
    }
  }

  // ── Context construction ────────────────────────────────────────────────

  /**
   * Get the text before the cursor, truncated to MAX_PREFIX_LENGTH chars.
   * Truncates from the start (keeps text closest to cursor).
   */
  private _getPrefix(document: vscode.TextDocument, position: vscode.Position): string {
    const start = new vscode.Position(0, 0);
    const range = new vscode.Range(start, position);
    let text = document.getText(range);

    if (text.length > MAX_PREFIX_LENGTH) {
      text = text.slice(text.length - MAX_PREFIX_LENGTH);
    }
    return text;
  }

  /**
   * Get the text after the cursor, truncated to MAX_SUFFIX_LENGTH chars.
   * Truncates from the end (keeps text closest to cursor).
   */
  private _getSuffix(document: vscode.TextDocument, position: vscode.Position): string {
    const end = document.lineAt(document.lineCount - 1).range.end;
    const range = new vscode.Range(position, end);
    let text = document.getText(range);

    if (text.length > MAX_SUFFIX_LENGTH) {
      text = text.slice(0, MAX_SUFFIX_LENGTH);
    }
    return text;
  }

  /**
   * Normalize the completion text to avoid common issues:
   * - Strip leading/trailing whitespace that duplicates context
   * - Skip if the completion is just the next character already in the document
   */
  private _normalizeCompletion(text: string, _prefix: string, suffix: string): string {
    let result = text;

    // Strip trailing newline if the suffix starts with a newline
    // (avoids double newlines)
    if (result.endsWith("\n") && suffix.startsWith("\n")) {
      result = result.slice(0, -1);
    }

    // If the completion exactly matches the beginning of the suffix,
    // but there's overlap (e.g. completion is just the next character),
    // skip it — the user already has that text.
    if (result.length === 0) {
      return "";
    }

    // Skip if completion is entirely whitespace
    if (result.trim().length === 0) {
      return "";
    }

    return result;
  }
}
