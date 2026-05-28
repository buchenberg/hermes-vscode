/**
 * ACP JSON-RPC types for Hermes Agent communication.
 *
 * The Agent Client Protocol (ACP) is a JSON-RPC 2.0 protocol over stdio.
 * Hermes Agent implements an ACP server via `hermes acp`.
 */

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: object;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: object;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── ACP Initialize ────────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number;
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities: ClientCapabilities;
}

export interface ClientCapabilities {
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  logging?: Record<string, never>;
}

export interface InitializeResult {
  protocolVersion: number;
  serverInfo?: {
    name: string;
    version: string;
  };
  capabilities: ServerCapabilities;
}

export interface ServerCapabilities {
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  logging?: Record<string, never>;
}

// ── ACP Session ───────────────────────────────────────────────────────────

export interface NewSessionParams {
  cwd: string;
  mcpServers: McpServerConfig[];
  toolsets?: string[];
}

export interface McpServerConfig {
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface NewSessionResult {
  sessionId: string;
  /** Available modes configured in Hermes (e.g. "default", "plan", "code") */
  modes?: SessionConfigOption[];
  /** Available models configured in Hermes */
  models?: SessionConfigOption[];
  /** Additional session-level config options (e.g. "yolo", "auto-approve") */
  configOptions?: SessionConfigOption[];
}

export interface SessionConfigOption {
  id: string;
  label?: string;
  description?: string;
  selected?: boolean;
  /** For model options: optionally specify the provider */
  provider?: string;
}

export interface LoadSessionResult {
  messages: ChatMessage[];
  sessionId: string;
  title?: string;
  /** Available modes configured in Hermes for this session */
  modes?: SessionConfigOption[];
  /** Available models configured in Hermes for this session */
  models?: SessionConfigOption[];
  /** Additional session-level config options for this session */
  configOptions?: SessionConfigOption[];
}

export interface ListSessionsResult {
  sessions: SessionInfo[];
  nextCursor?: string;
}

export interface SessionInfo {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// ── ACP Messages ──────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: ContentBlock[];
  timestamp?: string;
  usage?: Usage;
  toolCalls?: ToolCall[];
  reasoning?: string;
  plan?: PlanUpdate;
  error?: string;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ResourceContentBlock
  | ToolCallContentBlock;

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  type: "image";
  data: string;       // base64
  mimeType: string;
}

export interface ResourceContentBlock {
  type: "resource";
  resource: ResourceContents;
}

export interface ToolCallContentBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  status: "started" | "in_progress" | "completed" | "error";
  title?: string;
  output?: string;
  kind?: ToolKind;
}

export type ToolKind = "read" | "edit" | "execute" | "search" | "fetch" | "think" | "other";

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;      // base64
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
  status: "pending" | "running" | "completed" | "error";
  kind?: ToolKind;
  title?: string;
}

export interface PlanUpdate {
  todos: PlanTodo[];
}

export interface PlanTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

// ── ACP Events (server → client notifications) ────────────────────────────

/**
 * ACP `session/update` notification params.
 * The `update` field is a discriminated union keyed by `sessionUpdate`.
 */
export interface SessionUpdateNotification {
  sessionId: string;
  update: SessionUpdateUnion;
}

export type SessionUpdateUnion =
  | UserMessageChunk
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCallStart
  | ToolCallProgress
  | PlanUpdateChunk
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | SessionInfoUpdate
  | UsageUpdate;

export interface UserMessageChunk {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
  messageId?: string;
}

export interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
  messageId?: string;
}

export interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
  messageId?: string;
}

export interface ToolCallStart {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContentVariant[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallProgress {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContentVariant[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallLocation {
  path: string;
}

export interface ToolCallContentVariant {
  type: "content" | "diff" | "terminal";
  content?: ContentBlock;
  path?: string;
  newText?: string;
  oldText?: string;
  terminalId?: string;
}

export interface PlanUpdateChunk {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export interface UsageUpdate {
  sessionUpdate: "usage";
  usage: Usage;
}

export interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string;
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AvailableCommand[];
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: {
    type: "unstructured";
    placeholder?: string;
  };
}

// ── ACP Chat ──────────────────────────────────────────────────────────────

export interface SendMessageParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export interface SendMessageResult {
  messageId: string;
}

// ── ACP Resources ─────────────────────────────────────────────────────────

export interface ReadResourceParams {
  uri: string;
}

export interface ReadResourceResult {
  contents: ResourceContents[];
}

// ── ACP Prompts ────────────────────────────────────────────────────────────

export interface GetPromptParams {
  name: string;
  arguments?: Record<string, string>;
}

export interface GetPromptResult {
  messages: Array<{
    role: "user" | "assistant";
    content: ContentBlock;
  }>;
}

// ── Completions ───────────────────────────────────────────────────────────

export interface GetCompletionParams {
  sessionId: string;
  /** The code before the cursor position */
  prefix: string;
  /** The code after the cursor position */
  suffix: string;
  /** Language identifier (e.g. 'typescript', 'python') */
  language: string;
  /** Absolute path of the file being edited */
  filePath: string;
}

export interface GetCompletionResult {
  /** The completion text to insert at cursor */
  text: string;
  /** Optional reason for empty response (model declined, etc.) */
  reason?: string;
}
