/**
 * Hermes Agent — Webview Application
 *
 * Bundled by esbuild. Imports marked + highlight.js directly
 * instead of loading them as separate vendor scripts.
 */

import { marked } from "marked";
import hljs from "highlight.js";
// CSS loaded via <link> in chatProvider's HTML template — importing here
// would produce __require("./github-dark.min.css") which throws in webview

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── DOM refs ────────────────────────────────────────────────────────────

const messagesEl = document.getElementById("messages")!;
const inputBox = document.getElementById("input-box") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const statusInd = document.getElementById("status-indicator")!;
const emptyState = document.getElementById("empty-state")!;

// Session toolbar dropdowns
const modeSelect = document.getElementById("mode-select") as HTMLSelectElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const configSelect = document.getElementById("config-select") as HTMLSelectElement;

let currentAssistantMsg: ReturnType<typeof addMessage> | null = null;
let currentAssistantContent = "";
let isGenerating = false;
let isConnected = false;

// ── Debug tracking ──────────────────────────────────────────────────────

const debugPanel = document.getElementById("debug-panel")!;
const debugToggle = document.getElementById("debug-toggle")!;
const debugEntries: { time: string; dir: string; summary: string; detail?: string }[] = [];
const MAX_DEBUG = 100;

function debugAddEntry(dir: string, summary: string, detail?: string): void {
  const now = new Date();
  const time =
    now.toLocaleTimeString("en-US", { hour12: false }) +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");
  debugEntries.push({ time, dir, summary, detail });
  if (debugEntries.length > MAX_DEBUG) debugEntries.shift();
  renderDebugPanel();
}

function renderDebugPanel(): void {
  if (!debugPanel.classList.contains("visible")) return;
  debugPanel.innerHTML = debugEntries
    .slice(-40)
    .map(
      (e) =>
        '<div class="debug-entry">' +
        '<span class="time">' +
        e.time +
        "</span>" +
        '<span class="dir-' +
        e.dir +
        '">[' +
        (e.dir === "err" ? "ERR" : e.dir === "in" ? "←IN" : "OUT→") +
        "]</span> " +
        '<span class="summary">' +
        escapeHtml(e.summary) +
        "</span>" +
        (e.detail
          ? ' <span style="color:var(--dim)">' +
            escapeHtml(String(e.detail).slice(0, 120)) +
            "</span>"
          : "") +
        "</div>",
    )
    .join("");
}

debugToggle.addEventListener("click", () => {
  debugPanel.classList.toggle("visible");
  debugToggle.classList.toggle("active");
  if (debugPanel.classList.contains("visible")) {
    renderDebugPanel();
  }
});

// ── Status ───────────────────────────────────────────────────────────────

function setConnected(connected: boolean): void {
  isConnected = connected;
  statusInd.className = "status" + (connected ? " connected" : "");
  sendBtn.disabled = !connected;
  debugAddEntry("in", connected ? "connected ✅" : "disconnected");
}

// ── Send ──────────────────────────────────────────────────────────────────

function sendMessage(): void {
  const text = inputBox.value.trim();
  if (!text || !isConnected || isGenerating) return;
  inputBox.value = "";
  inputBox.style.height = "36px";

  // Hide empty state
  if (emptyState) emptyState.style.display = "none";

  // Add user message
  addMessage("user", text);
  vscode.postMessage({ type: "sendMessage", text });
  debugAddEntry("out", "sendMessage", text.slice(0, 80));

  // Create assistant placeholder
  currentAssistantMsg = addMessage("assistant", "");
  currentAssistantContent = "";
  setGenerating(true);

  // Scroll
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setGenerating(gen: boolean): void {
  isGenerating = gen;
  sendBtn.style.display = gen ? "none" : "";
  stopBtn.style.display = gen ? "" : "none";
  inputBox.disabled = gen;
  // Show/hide typing dots inside the assistant bubble
  if (gen && currentAssistantMsg) {
    currentAssistantMsg.bubble.innerHTML = '<div class="typing"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>';
  }
  // Pulse the status dot when generating
  statusInd.classList.toggle("generating", gen);
  debugAddEntry("in", gen ? "generation STARTED" : "generation STOPPED");
}

// ── Toolbar dropdowns ────────────────────────────────────────────────────

interface SelectOption {
  id: string;
  label?: string;
  description?: string;
  selected?: boolean;
  provider?: string;
}

function populateSelect(el: HTMLSelectElement, options: SelectOption[], placeholder: string): void {
  if (!options || options.length === 0) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.innerHTML = `<option value="">${placeholder}</option>`;
  el.disabled = false;
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.id;
    option.textContent = opt.label || opt.id;
    if (opt.selected) option.selected = true;
    el.appendChild(option);
  }
}

function setupToolbarDropdown(el: HTMLSelectElement, type: string): void {
  el.addEventListener("change", () => {
    const value = el.value;
    if (!value) return;
    if (type === "model") {
      const selectedOpt = el.selectedOptions[0];
      const provider = selectedOpt?.getAttribute("data-provider");
      vscode.postMessage({ type: "setSessionModel", model: value, provider: provider || undefined });
    } else if (type === "mode") {
      vscode.postMessage({ type: "setSessionMode", mode: value });
    } else if (type === "config") {
      vscode.postMessage({ type: "setSessionConfig", configId: value });
    }
  });
}

// ── Message rendering ────────────────────────────────────────────────────

// ── Copy-to-clipboard helper ─────────────────────────────────────────────

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    // Clipboard API might be unavailable; silently ignore
  });
}

// ── Build message copy actions bar ───────────────────────────────────────

function buildCopyActions(bubble: HTMLElement, rawMarkdown: string): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  // "Copy text" — plain text extracted from the rendered HTML
  const copyTextBtn = document.createElement("button");
  copyTextBtn.className = "msg-action-btn";
  copyTextBtn.textContent = "Copy text";
  copyTextBtn.title = "Copy rendered text (no markdown syntax)";
  copyTextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const renderedText = bubble.textContent || "";
    copyToClipboard(renderedText);
    copyTextBtn.textContent = "Copied!";
    setTimeout(() => (copyTextBtn.textContent = "Copy text"), 1500);
  });
  actions.appendChild(copyTextBtn);

  // "Copy markdown" — raw markdown source
  const copyMdBtn = document.createElement("button");
  copyMdBtn.className = "msg-action-btn";
  copyMdBtn.textContent = "Copy markdown";
  copyMdBtn.title = "Copy raw markdown source";
  copyMdBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyToClipboard(rawMarkdown);
    copyMdBtn.textContent = "Copied!";
    setTimeout(() => (copyMdBtn.textContent = "Copy markdown"), 1500);
  });
  actions.appendChild(copyMdBtn);

  return actions;
}

function addMessage(role: string, text: string) {
  const div = document.createElement("div");
  div.className = "msg msg-" + role;

  // Reasoning placeholder
  const reasoningDiv = document.createElement("div");
  reasoningDiv.className = "reasoning";
  reasoningDiv.style.display = "none";
  div.appendChild(reasoningDiv);

  // Blinking cursor element (appended during streaming, removed when done)
  const reasoningCursor = document.createElement("span");
  reasoningCursor.className = "reasoning-cursor";
  reasoningCursor.textContent = "▌";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  div.appendChild(bubble);

  // Copy action buttons (assistant messages only, hidden until content settles)
  const actions = buildCopyActions(bubble, text);
  actions.style.display = role === "assistant" ? "flex" : "none";
  div.appendChild(actions);

  messagesEl.appendChild(div);
  updateBubbleContent(bubble, text);

  return {
    el: div,
    bubble,
    reasoning: reasoningDiv,
    reasoningCursor,
    actions,
    rawMarkdown: text,
    _reasoningText: "",
    toolCalls: new Map<string, { el: HTMLElement; status: string }>(),
    setReasoning(text: string) {
      if (text && !text.startsWith("🧠")) {
        text = "🧠 " + text;
      }
      this._reasoningText = text;
      // Remove all existing child nodes except the cursor
      while (this.reasoning.firstChild && this.reasoning.firstChild !== this.reasoningCursor) {
        this.reasoning.firstChild.remove();
      }
      // Insert text node before cursor (or append if cursor not yet attached)
      this.reasoning.insertBefore(
        document.createTextNode(text),
        this.reasoning.firstChild,
      );
      // Ensure cursor is attached at the end
      if (!this.reasoningCursor.parentNode) {
        this.reasoning.appendChild(this.reasoningCursor);
      }
      this.reasoning.style.display = text ? "" : "none";
    },
    removeReasoningCursor() {
      if (this.reasoningCursor.parentNode) {
        this.reasoningCursor.remove();
      }
    },
    setContent(html: string) {
      this.setContent = (h: string) => {
        this.rawMarkdown = h;
        updateBubbleContent(this.bubble, h);
        // Rebuild actions so buttons reference updated raw markdown
        const newActions = buildCopyActions(this.bubble, h);
        this.actions.replaceWith(newActions);
        this.actions = newActions;
      };
      this.setContent(html);
    },
    appendContent(delta: string) {
      currentAssistantContent += delta;
      this.rawMarkdown = currentAssistantContent;
      updateBubbleContent(this.bubble, currentAssistantContent);
      // Rebuild actions so buttons reference updated raw markdown
      const newActions = buildCopyActions(this.bubble, currentAssistantContent);
      this.actions.replaceWith(newActions);
      this.actions = newActions;
    },
  };
}

function updateBubbleContent(bubble: HTMLElement, text: string): void {
  // Render markdown to HTML using marked + highlight.js
  const html = renderMarkdown(text);

  bubble.innerHTML = html;

  // Wire copy buttons on code blocks
  bubble.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = btn.getAttribute("data-code");
      navigator.clipboard.writeText(code || "").catch(() => {
        // Clipboard API might be unavailable; silently ignore
      });
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
  });
}

// ── Markdown rendering (marked + highlight.js) ───────────────────────────

marked.setOptions({
  gfm: true,
  breaks: false,
});

const renderer = new marked.Renderer();
renderer.code = function ({ text: code, lang }: { text: string; lang?: string }): string {
  if (lang) {
    try {
      const validLang = hljs.getLanguage(lang) ? lang : undefined;
      if (validLang) {
        const highlighted = hljs.highlight(code, { language: validLang }).value;
        const escapedCode = code.replace(/"/g, "&quot;");
        return (
          '<pre><button class="copy-btn" data-code="' +
          escapedCode +
          '">Copy</button><code class="hljs language-' +
          validLang +
          '">' +
          highlighted +
          "</code></pre>"
        );
      }
    } catch (_e) {
      // Fall through to unhighlighted
    }
  }
  const escapedCode = code.replace(/"/g, "&quot;");
  return (
    '<pre><button class="copy-btn" data-code="' +
    escapedCode +
    '">Copy</button><code>' +
    escapeHtml(code) +
    "</code></pre>"
  );
};

marked.setOptions({ renderer });

function renderMarkdown(text: string): string {
  if (!text) return "";
  return marked.parse(text) as string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Handle messages from extension ────────────────────────────────────────

window.addEventListener("message", (event) => {
  const msg = event.data;
  debugAddEntry(
    "in",
    msg.type as string,
    msg.type === "agentMessageChunk"
      ? ((msg.text as string)?.slice(0, 60) || "")
      : msg.type === "toolCallStart"
        ? ((msg.toolName as string) || "")
        : msg.type === "toolCallProgress"
          ? ((msg.status as string) + " " + ((msg.toolCallId as string) || ""))
          : msg.type === "agentThoughtChunk"
            ? ((msg.text as string)?.slice(0, 60) || "")
            : (msg.error as string) || "",
  );
  switch (msg.type) {
    case "sessionReady":
      setConnected(true);
      // Populate toolbar dropdowns from session config
      if (msg.modes) populateSelect(modeSelect, msg.modes, "Select mode...");
      if (msg.models) {
        populateSelect(modelSelect, msg.models, "Select model...");
        for (let i = 0; i < modelSelect.options.length; i++) {
          const opt = modelSelect.options[i];
          const modelOpt = msg.models.find((m: SelectOption) => m.id === opt.value);
          if (modelOpt?.provider) {
            opt.setAttribute("data-provider", modelOpt.provider);
          }
        }
      }
      if (msg.configOptions) populateSelect(configSelect, msg.configOptions, "Select config...");
      break;

    case "sessionLoaded":
      setConnected(true);
      // Render history
      if (emptyState) emptyState.style.display = "none";
      (msg.messages || []).forEach(
        (m: { role: string; content?: { text: string }[] }) => {
          addMessage(m.role, m.content?.[0]?.text || "");
        },
      );
      // Populate toolbar dropdowns from loaded session config
      if (msg.modes) populateSelect(modeSelect, msg.modes, "Select mode...");
      if (msg.models) {
        populateSelect(modelSelect, msg.models, "Select model...");
        for (let i = 0; i < modelSelect.options.length; i++) {
          const opt = modelSelect.options[i];
          const modelOpt = msg.models.find((m: SelectOption) => m.id === opt.value);
          if (modelOpt?.provider) {
            opt.setAttribute("data-provider", modelOpt.provider);
          }
        }
      }
      if (msg.configOptions) populateSelect(configSelect, msg.configOptions, "Select config...");
      break;

    case "agentMessageChunk":
      if (!currentAssistantMsg) {
        if (emptyState) emptyState.style.display = "none";
        currentAssistantMsg = addMessage("assistant", "");
        currentAssistantContent = "";
        setGenerating(true);
      }
      // Provider sends flat { text: "..." } not nested { chunk: { type, text } }
      currentAssistantMsg.appendContent((msg.text as string) || "");
      currentAssistantMsg.removeReasoningCursor();
      break;

    case "toolCallStart":
      if (!currentAssistantMsg) {
        if (emptyState) emptyState.style.display = "none";
        currentAssistantMsg = addMessage("assistant", "");
        currentAssistantContent = "";
        setGenerating(true);
      }
      renderToolCall(currentAssistantMsg, {
        toolCallId: msg.toolCallId as string,
        toolName: ((msg.title as string) || (msg.toolName as string) || "Unknown tool"),
        status: "started",
      });
      break;

    case "toolCallProgress":
      if (!currentAssistantMsg) {
        if (emptyState) emptyState.style.display = "none";
        currentAssistantMsg = addMessage("assistant", "");
        currentAssistantContent = "";
        setGenerating(true);
      }
      renderToolCall(currentAssistantMsg, {
        toolCallId: msg.toolCallId as string,
        toolName: ((msg.title as string) || (msg.toolName as string) || ""),
        status: msg.status as string,
        output: msg.output as string,
      });
      break;

    case "agentThoughtChunk":
      if (!currentAssistantMsg) {
        if (emptyState) emptyState.style.display = "none";
        currentAssistantMsg = addMessage("assistant", "");
        currentAssistantContent = "";
        setGenerating(true);
      }
      currentAssistantMsg.setReasoning(
        (currentAssistantMsg._reasoningText || "") + ((msg.text as string) || ""),
      );
      break;

    case "userMessageChunk":
      if (emptyState) emptyState.style.display = "none";
      addMessage("user", (msg.text as string) || "");
      break;

    case "generationStarted":
      setGenerating(true);
      break;

    case "generationComplete":
      if (currentAssistantMsg) {
        currentAssistantMsg.removeReasoningCursor();
        // Mark running tool calls as done and collapse the card
        currentAssistantMsg.toolCalls.forEach((tc) => {
          if (tc.status === "running") {
            const statusEl = tc.el.querySelector(".tool-status")!;
            statusEl.textContent = "✓";
            statusEl.className = "tool-status done";
            tc.status = "done";
          }
        });
        // Collapse tools card
        const toolsCard = (currentAssistantMsg as any)._toolsCard as HTMLElement | undefined;
        if (toolsCard) toolsCard.classList.remove("open");
      }
      currentAssistantMsg = null;
      currentAssistantContent = "";
      setGenerating(false);
      break;

    case "generationError":
      if (currentAssistantMsg) {
        currentAssistantMsg.setContent(
          currentAssistantContent + "\\n\\n❌ Error: " + msg.error,
        );
      }
      currentAssistantMsg = null;
      currentAssistantContent = "";
      setGenerating(false);
      break;

    case "usageUpdate":
      // Could show token count
      break;

    case "planUpdate":
      renderPlan(msg.plan || msg.todos);
      break;

    case "sessionUpdate":
    case "sessionInfoUpdate":
    case "modeUpdate":
      // Reserved for future header/title updates
      break;

    case "sessionConfig":
      // Populate toolbar dropdowns from session config
      if (msg.modes) populateSelect(modeSelect, msg.modes, "Select mode...");
      if (msg.models) {
        populateSelect(modelSelect, msg.models, "Select model...");
        // Store provider as data attribute on options
        for (let i = 0; i < modelSelect.options.length; i++) {
          const opt = modelSelect.options[i];
          const modelOpt = msg.models.find((m: SelectOption) => m.id === opt.value);
          if (modelOpt?.provider) {
            opt.setAttribute("data-provider", modelOpt.provider);
          }
        }
      }
      if (msg.configOptions) populateSelect(configSelect, msg.configOptions, "Select config...");
      break;

    case "configOptionsUpdate":
      // Update one category of options dynamically
      if (msg.modes) populateSelect(modeSelect, msg.modes, "Select mode...");
      if (msg.models) {
        populateSelect(modelSelect, msg.models, "Select model...");
        for (let i = 0; i < modelSelect.options.length; i++) {
          const opt = modelSelect.options[i];
          const modelOpt = msg.models.find((m: SelectOption) => m.id === opt.value);
          if (modelOpt?.provider) {
            opt.setAttribute("data-provider", modelOpt.provider);
          }
        }
      }
      if (msg.configOptions) populateSelect(configSelect, msg.configOptions, "Select config...");
      break;
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
});

function ensureToolsCard(container: ReturnType<typeof addMessage>) {
  if ((container as any)._toolsCard) return;
  const card = document.createElement("div");
  card.className = "tools-card open";
  card.innerHTML =
    '<div class="tools-card-header">' +
    '<span class="tools-card-icon">🧰</span>' +
    '<span class="tools-card-title">Tools</span>' +
    '<span class="tools-card-count"></span>' +
    '<span class="tools-card-chevron">▾</span>' +
    "</div>" +
    '<div class="tools-card-body"></div>';
  card.querySelector(".tools-card-header")!.addEventListener("click", () => {
    card.classList.toggle("open");
  });
  container.el.appendChild(card);
  // Refs on the message object
  (container as any)._toolsCard = card;
  (container as any)._toolsBody = card.querySelector(".tools-card-body")!;
  (container as any)._toolsCount = card.querySelector(".tools-card-count")!;
  (container as any)._toolsSeen = 0;
}

function renderToolCall(
  container: ReturnType<typeof addMessage>,
  chunk: {
    toolCallId: string;
    toolName: string;
    status?: string;
    output?: string;
  },
): void {
  const id = chunk.toolCallId;
  ensureToolsCard(container);

  const body = (container as any)._toolsBody as HTMLElement;
  const count = (container as any)._toolsCount as HTMLElement;

  if (!container.toolCalls.has(id)) {
    const row = document.createElement("div");
    row.className = "tool-row";
    row.innerHTML =
      '<span class="tool-row-icon">🔹</span>' +
      '<span class="tool-row-name">' +
      escapeHtml(chunk.toolName || "Tool call") +
      "</span>" +
      '<span class="tool-status running">running</span>' +
      '<pre class="tool-row-output"></pre>';
    body.appendChild(row);
    container.toolCalls.set(id, { el: row, status: "running" });
    (container as any)._toolsSeen++;
    count.textContent = String((container as any)._toolsSeen);
  }

  const tc = container.toolCalls.get(id)!;
  const nameEl = tc.el.querySelector(".tool-row-name")! as HTMLElement;
  const statusEl = tc.el.querySelector(".tool-status")!;
  const outputEl = tc.el.querySelector(".tool-row-output")! as HTMLElement;

  if (chunk.toolName && (!nameEl.textContent || nameEl.textContent === "Tool call")) {
    nameEl.textContent = chunk.toolName;
  }

  if (chunk.status === "completed") {
    statusEl.textContent = "✓";
    statusEl.className = "tool-status done";
    if (chunk.output) {
      outputEl.textContent = chunk.output.slice(0, 5000);
      outputEl.style.display = "block";
    }
    tc.status = "done";
  } else if (chunk.status === "error") {
    statusEl.textContent = "✗";
    statusEl.className = "tool-status error";
    if (chunk.output) {
      outputEl.textContent = chunk.output;
      outputEl.style.display = "block";
    }
    tc.status = "error";
  } else if (chunk.status === "started") {
    statusEl.textContent = "…";
    statusEl.className = "tool-status running";
  }
}

function renderPlan(todos: { status: string; content: string }[]): void {
  if (!currentAssistantMsg) return;
  const planDiv = document.createElement("div");
  planDiv.className = "plan";
  planDiv.innerHTML = "<h4>📋 Plan</h4>";
  (todos || []).forEach((t) => {
    const icon =
      t.status === "completed"
        ? "✅"
        : t.status === "in_progress"
          ? "🔄"
          : t.status === "cancelled"
            ? "❌"
            : "⬜";
    const cls =
      t.status === "completed"
        ? "done"
        : t.status === "in_progress"
          ? "in-progress"
          : "";
    planDiv.innerHTML +=
      '<div class="plan-item ' +
      cls +
      '"><span class="check">' +
      icon +
      "</span>" +
      escapeHtml(t.content) +
      "</div>";
  });
  currentAssistantMsg.el.appendChild(planDiv);
}

// ── Event listeners ───────────────────────────────────────────────────────

sendBtn.addEventListener("click", sendMessage);

inputBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

inputBox.addEventListener("input", () => {
  inputBox.style.height = "36px";
  inputBox.style.height = Math.min(inputBox.scrollHeight, 120) + "px";
});

stopBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "stopGeneration" });
});

document.getElementById("new-session-btn")!.addEventListener("click", () => {
  // Clear messages
  messagesEl.innerHTML = "";
  messagesEl.appendChild(emptyState);
  emptyState.style.display = "";
  currentAssistantMsg = null;
  currentAssistantContent = "";
  vscode.postMessage({ type: "newSession" });
});

// Suggestion clicks
document.querySelectorAll(".suggestion").forEach((el) => {
  el.addEventListener("click", () => {
    const prompt = el.getAttribute("data-prompt");
    if (prompt) {
      inputBox.value = prompt;
      sendMessage();
    }
  });
});

// Focus input
inputBox.focus();

// Wire up toolbar dropdowns
setupToolbarDropdown(modeSelect, "mode");
setupToolbarDropdown(modelSelect, "model");
setupToolbarDropdown(configSelect, "config");

// Request current state from provider (may have connected before we were listening)
vscode.postMessage({ type: "requestState" });
