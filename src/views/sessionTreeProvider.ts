import * as vscode from "vscode";
import { SessionHistoryStore, SessionRecord } from "../persistence/sessionHistoryStore";

type SessionTreeItem = vscode.TreeItem & {
  sessionRecord?: SessionRecord;
};

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly _store: SessionHistoryStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): vscode.ProviderResult<SessionTreeItem[]> {
    if (!element) {
      // Root: list all sessions
      const sessions = this._store.getAllSessions();
      if (sessions.length === 0) {
        const empty = new vscode.TreeItem("No sessions yet", vscode.TreeItemCollapsibleState.None);
        empty.iconPath = new vscode.ThemeIcon("history");
        empty.description = "Start a chat to create one";
        return [empty];
      }
      return sessions.map((s) => this._sessionToTreeItem(s));
    }

    // Children: actions for a specific session
    if (element.sessionRecord) {
      const session = element.sessionRecord;
      const resumeItem = new vscode.TreeItem("Resume Session", vscode.TreeItemCollapsibleState.None);
      resumeItem.iconPath = new vscode.ThemeIcon("play");
      resumeItem.command = { command: "hermes.resumeSession", title: "Resume", arguments: [session.id] };
      resumeItem.tooltip = `Resume session ${session.id}`;

      const forkItem = new vscode.TreeItem("Fork Session", vscode.TreeItemCollapsibleState.None);
      forkItem.iconPath = new vscode.ThemeIcon("repo-forked");
      forkItem.command = { command: "hermes.forkSession", title: "Fork", arguments: [session] };
      forkItem.tooltip = `Create a new session with ${session.model || "default"} config`;

      const deleteItem = new vscode.TreeItem("Delete", vscode.TreeItemCollapsibleState.None);
      deleteItem.iconPath = new vscode.ThemeIcon("trash");
      deleteItem.command = { command: "hermes.deleteSession", title: "Delete", arguments: [session.id] };
      deleteItem.tooltip = `Delete session record`;

      return [resumeItem, forkItem, deleteItem];
    }

    return [];
  }

  private _sessionToTreeItem(record: SessionRecord): SessionTreeItem {
    const ago = _timeAgo(new Date(record.lastActive).getTime());
    const title = record.title || `Session ${record.id.slice(0, 8)}`;

    const item: SessionTreeItem = new vscode.TreeItem(
      title,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    item.description = [
      record.model || "",
      record.mode ? `[${record.mode}]` : "",
      ago,
      record.isActive ? "●" : "",
    ]
      .filter(Boolean)
      .join("  ");

    item.iconPath = record.isActive
      ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("comment-discussion");

    item.tooltip = [
      `ID: ${record.id}`,
      record.model ? `Model: ${record.model}${record.provider ? ` (${record.provider})` : ""}` : "",
      record.mode ? `Mode: ${record.mode}` : "",
      `Created: ${new Date(record.createdAt).toLocaleString()}`,
      `Last active: ${new Date(record.lastActive).toLocaleString()}`,
    ]
      .filter(Boolean)
      .join("\n");

    item.sessionRecord = record;

    // Clicking the item resumes the session
    item.command = { command: "hermes.resumeSession", title: "Resume", arguments: [record.id] };

    return item;
  }
}

function _timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
