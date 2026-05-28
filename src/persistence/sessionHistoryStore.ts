import * as vscode from "vscode";

export interface SessionRecord {
  id: string;
  title?: string;
  model?: string;
  provider?: string;
  mode?: string;
  createdAt: string; // ISO string
  lastActive: string; // ISO string
  isActive: boolean;
}

const STORAGE_KEY = "hermes.sessionHistory";

export class SessionHistoryStore {
  private _records: SessionRecord[] = [];

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._load();
  }

  addSession(record: SessionRecord): void {
    // Remove duplicate if it exists
    this._records = this._records.filter((r) => r.id !== record.id);
    this._records.unshift(record);
    // Cap at 100 records
    if (this._records.length > 100) {
      this._records = this._records.slice(0, 100);
    }
    this._save();
  }

  getSession(id: string): SessionRecord | undefined {
    return this._records.find((r) => r.id === id);
  }

  getAllSessions(): SessionRecord[] {
    return [...this._records];
  }

  updateSession(id: string, updates: Partial<Omit<SessionRecord, "id">>): SessionRecord | undefined {
    const record = this._records.find((r) => r.id === id);
    if (!record) return undefined;
    Object.assign(record, updates);
    this._save();
    return record;
  }

  deleteSession(id: string): boolean {
    const len = this._records.length;
    this._records = this._records.filter((r) => r.id !== id);
    if (this._records.length < len) {
      this._save();
      return true;
    }
    return false;
  }

  /** Mark all as inactive (e.g., on extension deactivation) */
  deactivateAll(): void {
    for (const r of this._records) {
      r.isActive = false;
    }
    this._save();
  }

  private _load(): void {
    const raw = this._context.globalState.get<string>(STORAGE_KEY);
    if (raw) {
      try {
        this._records = JSON.parse(raw);
      } catch {
        this._records = [];
      }
    }
  }

  private _save(): void {
    this._context.globalState.update(STORAGE_KEY, JSON.stringify(this._records));
  }
}
