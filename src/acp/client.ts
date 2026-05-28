/**
 * ACP JSON-RPC 2.0 client communicating with Hermes ACP server over stdio.
 *
 * Spawns `hermes acp` as a child process and handles all JSON-RPC
 * request/response/notification routing.
 */

import * as cp from "child_process";
import { EventEmitter } from "events";
import {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  InitializeParams,
  InitializeResult,
  NewSessionParams,
  NewSessionResult,
  LoadSessionResult,
  ListSessionsResult,
  SendMessageParams,
  SendMessageResult,
  ReadResourceParams,
  ReadResourceResult,
  SessionConfigOption,
  SessionInfo,
} from "./types";

export interface AcpClientOptions {
  hermesPath: string;
  hermesArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes for agent responses
const STARTUP_TIMEOUT_MS = 30_000;

export class AcpClient extends EventEmitter {
  private process: cp.ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = "";
  private _initialized = false;

  constructor(private options: AcpClientOptions) {
    super();
  }

  get initialized(): boolean {
    return this._initialized;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<InitializeResult> {
    if (this.process) {
      throw new Error("ACP client already started");
    }

    const args = ["acp", ...(this.options.hermesArgs ?? [])];
    const env = {
      ...process.env,
      ...this.options.env,
      // Ensure hermes doesn't try to use interactive prompts
      HERMES_NO_TTY: "1",
    };

    this.process = cp.spawn(this.options.hermesPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.options.cwd,
    });

    this.process.stdout?.on("data", (data: Buffer) => this._onData(data));
    this.process.stderr?.on("data", (data: Buffer) => {
      // Route stderr through events for optional display
      this.emit("stderr", data.toString());
    });

    this.process.on("error", (err) => {
      this.emit("error", err);
    });

    this.process.on("exit", (code, signal) => {
      this._initialized = false;
      this.emit("exit", code, signal);
      // Reject all pending requests
      const entries = Array.from(this.pending.entries());
      for (const [id, pending] of entries) {
        pending.reject(new Error(`ACP process exited (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
    });

    // Initialize session
    const initParams: InitializeParams = {
      protocolVersion: 1,
      clientInfo: {
        name: "hermes-vscode",
        version: "0.1.0",
      },
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
    };

    const result = await this._sendRequest("initialize", initParams, STARTUP_TIMEOUT_MS) as InitializeResult;
    this._initialized = true;

    // Send initialized notification
    this._sendNotification("notifications/initialized", {});

    this.emit("ready");
    return result;
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    // Try graceful shutdown
    try {
      await this._sendRequest("shutdown", {}, 5000);
      this._sendNotification("exit", {});
    } catch {
      // Force kill on timeout/error
    }

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Force after 3s
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 3000);
    }

    this.process = null;
    this._initialized = false;
    this.pending.clear();
  }

  // ── Session Management ──────────────────────────────────────────────────

  async newSession(params: NewSessionParams): Promise<NewSessionResult> {
    return this._sendRequest("session/new", params) as Promise<NewSessionResult>;
  }

  async loadSession(sessionId: string): Promise<LoadSessionResult> {
    return this._sendRequest("session/load", { sessionId }) as Promise<LoadSessionResult>;
  }

  async listSessions(cursor?: string): Promise<ListSessionsResult> {
    return this._sendRequest("session/list", { cursor }) as Promise<ListSessionsResult>;
  }

  async forkSession(sessionId: string): Promise<{ sessionId: string }> {
    return this._sendRequest("session/fork", { sessionId }) as Promise<{ sessionId: string }>;
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    return this._sendRequest("session/resume", { sessionId }) as Promise<{ sessionId: string }>;
  }

  // ── Messaging ───────────────────────────────────────────────────────────

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    return this._sendRequest("session/prompt", params) as Promise<SendMessageResult>;
  }

  // ── Resources ────────────────────────────────────────────────────────────

  async readResource(uri: string): Promise<ReadResourceResult> {
    return this._sendRequest("resources/read", { uri }) as Promise<ReadResourceResult>;
  }

  // ── Model / Config ─────────────────────────────────────────────────────

  async setSessionModel(sessionId: string, model: string, provider?: string): Promise<void> {
    await this._sendRequest("session/set_model", { sessionId, model, provider });
  }

  async setSessionMode(sessionId: string, mode: string): Promise<void> {
    await this._sendRequest("session/set_mode", { sessionId, mode });
  }

  async getSessionConfigOptions(sessionId: string): Promise<{
    modes: SessionConfigOption[];
    models: SessionConfigOption[];
    configOptions: SessionConfigOption[];
  }> {
    return this._sendRequest("session/config_options", { sessionId }) as Promise<{
      modes: SessionConfigOption[];
      models: SessionConfigOption[];
      configOptions: SessionConfigOption[];
    }>;
  }

  // ── Completions ────────────────────────────────────────────────────────

  async getCompletion(params: {
    sessionId: string;
    prefix: string;
    suffix: string;
    language: string;
    filePath: string;
  }): Promise<{ text: string; reason?: string }> {
    return this._sendRequest("completions/get", params as Record<string, unknown>) as Promise<{
      text: string;
      reason?: string;
    }>;
  }

  // ── Event Emitter overloads ─────────────────────────────────────────────

  on(event: "ready", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  on(event: "stderr", listener: (data: string) => void): this;
  on(event: "message", listener: (msg: JsonRpcMessage) => void): this;
  on(event: "notification", listener: (method: string, params: object) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit(event: "ready"): boolean;
  emit(event: "error", err: Error): boolean;
  emit(event: "exit", code: number | null, signal: string | null): boolean;
  emit(event: "stderr", data: string): boolean;
  emit(event: "message", msg: JsonRpcMessage): boolean;
  emit(event: "notification", method: string, params: object): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _onData(data: Buffer): void {
    this.buffer += data.toString();

    // Parse complete lines (JSON-RPC messages are newline-delimited)
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg: JsonRpcMessage = JSON.parse(line);
        this._handleMessage(msg);
      } catch (err) {
        this.emit("error", new Error(`ACP parse error: ${(err as Error).message} (raw: ${line.slice(0, 200)})`));
      }
    }
  }

  private _handleMessage(msg: JsonRpcMessage): void {
    this.emit("message", msg);

    if ("method" in msg && "id" in msg) {
      // Incoming request (server → client)
      this._handleRequest(msg as JsonRpcRequest);
    } else if ("method" in msg && !("id" in msg)) {
      // Notification (server → client)
      const notif = msg as JsonRpcNotification;
      this.emit("notification", notif.method, notif.params ?? {});
    } else if ("id" in msg) {
      // Response to our request
      const resp = msg as JsonRpcResponse;
      const pending = this.pending.get(resp.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(`ACP error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
    }
  }

  private _handleRequest(req: JsonRpcRequest): void {
    // Simple handler for server→client requests if needed
    // For now just respond with method_not_found
    this._sendResponse(req.id, {
      code: -32601,
      message: `Method not found: ${req.method}`,
    });
  }

  private _sendRequest(method: string, params: object, timeout = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error("ACP client not started"));
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.process!.stdin!.write(JSON.stringify(request) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private _sendNotification(method: string, params: object): void {
    if (!this.process || !this.process.stdin) return;

    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    try {
      this.process.stdin.write(JSON.stringify(notification) + "\n");
    } catch {
      // Silently ignore — process may have exited
    }
  }

  private _sendResponse(id: number | string, error: { code: number; message: string }): void {
    if (!this.process || !this.process.stdin) return;

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error,
    };

    try {
      this.process.stdin.write(JSON.stringify(response) + "\n");
    } catch {
      // Silently ignore
    }
  }
}
