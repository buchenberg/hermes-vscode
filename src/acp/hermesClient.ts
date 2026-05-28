/**
 * Hermes ACP client — thin wrapper around @agentclientprotocol/sdk.
 *
 * Manages subprocess lifecycle and delegates all ACP protocol handling
 * to the SDK's ClientSideConnection + ndJsonStream.
 */

import * as cp from "child_process";
import { Writable, Readable } from "stream";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type { Agent, Client, Stream } from "@agentclientprotocol/sdk";
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  LoadSessionRequest,
  LoadSessionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

// ── Types ─────────────────────────────────────────────────────────────────

export interface HermesClientOptions {
  hermesPath: string;
  hermesArgs?: string[];
  cwd: string;
  env?: Record<string, string>;
}

export type { Agent, Client, Stream };

// ── HermesClient ──────────────────────────────────────────────────────────

export class HermesClient {
  private _conn!: ClientSideConnection;
  private _proc: cp.ChildProcess | null = null;
  private _initResponse!: InitializeResponse;

  /** The underlying SDK connection. Use this for all ACP calls. */
  get conn(): ClientSideConnection {
    return this._conn;
  }

  /** The child process (for lifecycle management). */
  get process(): cp.ChildProcess | null {
    return this._proc;
  }

  /** Initialize response (for agent info after connect). */
  get initResponse(): InitializeResponse {
    return this._initResponse;
  }

  constructor(private readonly _options: HermesClientOptions) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Spawns `hermes acp`, hooks up ndJsonStream, creates ClientSideConnection,
   * sends the initialize handshake, and returns the response.
   *
   * @param toClient — factory that receives the Agent interface and returns
   *   a Client implementation handling agent → client notifications.
   */
  async start(
    toClient: (agent: Agent) => Client,
  ): Promise<InitializeResponse> {
    if (this._proc) {
      throw new Error("HermesClient already started");
    }

    const hermesPath = this._options.hermesPath;
    const args = ["acp", ...(this._options.hermesArgs ?? [])];

    const env = {
      ...process.env,
      ...this._options.env,
      HERMES_NO_TTY: "1",
    };

    this._proc = cp.spawn(hermesPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this._options.cwd,
    });

    // Convert Node.js streams to Web Streams for ndJsonStream
    const webStdin = Writable.toWeb(
      this._proc.stdin!,
    ) as globalThis.WritableStream<Uint8Array>;
    const webStdout = Readable.toWeb(
      this._proc.stdout!,
    ) as globalThis.ReadableStream<Uint8Array>;

    const stream = ndJsonStream(webStdin, webStdout);
    this._conn = new ClientSideConnection(toClient, stream);

    // Send initialize — SDK types only allow protocolVersion +
    // clientCapabilities + clientInfo (no custom capabilities).
    // The hermes ACP adapter ignores clientCapabilities, so this is safe.
    this._initResponse = await this._conn.initialize({
      protocolVersion: 1,
      clientInfo: { name: "hermes-vscode", version: "0.1.0" },
    });

    return this._initResponse;
  }

  /** Stops the hermes process gracefully (SIGTERM) then forces after 3s. */
  async stop(): Promise<void> {
    if (!this._proc || this._proc.killed) return;

    this._proc.kill("SIGTERM");

    setTimeout(() => {
      if (this._proc && !this._proc.killed) {
        this._proc.kill("SIGKILL");
      }
    }, 3000);

    this._proc = null;
  }

  // ── Events ────────────────────────────────────────────────────────────

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this._proc?.on("exit", cb);
  }

  onError(cb: (err: Error) => void): void {
    this._proc?.on("error", cb);
  }

  onStderr(cb: (data: string) => void): void {
    this._proc?.stderr?.on("data", (data: Buffer) => cb(data.toString()));
  }
}
