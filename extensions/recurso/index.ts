import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NEW = "recurso_new_thread";
const TOOL_FORK = "recurso_fork_thread";
const TOOL_MESSAGE = "recurso_message_thread";
const TOOL_PEEK = "recurso_peek_thread";
const TOOL_LIST = "recurso_list_threads";
const TOOL_ABORT = "recurso_abort_thread";

const RECURSO_TOOLS = [TOOL_NEW, TOOL_FORK, TOOL_MESSAGE, TOOL_PEEK, TOOL_LIST, TOOL_ABORT];
const RECURSO_API_VERSION = "1.1.5";
const RECURSO_SNAPSHOT_SCHEMA_VERSION = 1;
const RECURSO_OPENAI_CACHE_LINEAGE_ENV = "RECURSO_OPENAI_CACHE_LINEAGE";
const RECURSO_SHUTDOWN_BEHAVIOR_ENV = "RECURSO_SHUTDOWN_BEHAVIOR";
const RECURSO_DASHBOARD_DEFAULT_PACKAGE = "github:neuchatech/recurso-dashboard";
const RECURSO_DASHBOARD_DEFAULT_PORT = 3737;
const EXTENSION_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(dirname(EXTENSION_FILE)));
const PI_DEFAULT_SESSION_DIR_VALUES = new Set(["default", "pi", "pi-default", "history"]);
const RECURSO_ISOLATED_SESSION_DIR_VALUES = new Set(["isolated", "local", "recurso"]);

type DeliveryMode = "followUp" | "steer";
type ThreadMessageType = "question" | "done" | "progress";
type ThreadStatus = "starting" | "running" | "idle" | "waiting" | "done" | "aborted" | "exited" | "error";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

interface RpcState {
  isStreaming?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
}

interface ThreadEntry {
  id: string;
  parentId: string;
  task: string;
  cwd: string;
  depth: number;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  pid?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastError?: string;
  lastAssistantText?: string;
  lastTool?: string;
  lastMessage?: RoutedThreadMessage;
  rpc: RpcProcess;
}

interface ThreadSnapshot {
  schemaVersion?: number;
  id: string;
  parentId: string;
  ownerManagerId?: string;
  direct?: boolean;
  task: string;
  depth: number;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  pid?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  lastError?: string;
  lastAssistantText?: string;
  lastTool?: string;
  lastMessage?: RoutedThreadMessage;
}

interface RunSnapshot {
  schemaVersion?: number;
  managerId?: string;
  parentId?: string | null;
  runId?: string;
  managerPid?: number;
  depth?: number;
  packageRoot?: string;
  updatedAt?: number;
  threads?: ThreadSnapshot[];
}

interface RoutedThreadMessage {
  from: string;
  target: string;
  type: ThreadMessageType;
  message: string;
  deliverAs: DeliveryMode;
  routedAt: number;
}

interface StartThreadOptions {
  ctx: any;
  task: string;
  context?: string;
  sourceSessionFile?: string;
  forkFromThread?: string;
  name?: string;
  model?: string;
  provider?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

interface DashboardCommand {
  command: string;
  args: string[];
  source: string;
}

interface DashboardCommandOptions {
  install: boolean;
  noInstall: boolean;
  port?: number;
}

class JsonlReader {
  private buffer = "";

  push(chunk: Buffer | string, onLine: (line: string) => void): void {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }
}

class RpcProcess {
  private proc: ChildProcess | null = null;
  private stdoutReader = new JsonlReader();
  private pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private requestId = 0;
  private stderrTail = "";

  constructor(
    private readonly args: string[],
    private readonly options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      onEvent: (event: any) => void;
      onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
      onProtocolError: (message: string) => void;
    },
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get exitCode(): number | null | undefined {
    return this.proc?.exitCode;
  }

  get killed(): boolean {
    return this.proc?.killed ?? true;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error("RPC process already started");

    const piBin = process.env.RECURSO_PI_BIN || "pi";
    this.proc = spawn(piBin, this.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutReader.push(chunk, (line) => this.handleLine(line));
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-12000);
      if (process.env.RECURSO_DEBUG) {
        process.stderr.write(text);
      }
    });

    this.proc.on("exit", (code, signal) => {
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`RPC process exited before response. Stderr: ${this.stderrTail}`));
      }
      this.pending.clear();
      this.options.onExit(code, signal);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    if (this.proc.exitCode !== null) {
      throw new Error(`RPC process exited immediately with code ${this.proc.exitCode}. Stderr: ${this.stderrTail}`);
    }
  }

  async send(command: Record<string, unknown>, timeoutMs = 30000): Promise<RpcResponse> {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error("RPC process is not writable");
    }

    const id = `recurso_${++this.requestId}`;
    const fullCommand = { ...command, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}. Stderr: ${this.stderrTail}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(`${JSON.stringify(fullCommand)}\n`);
    });
  }

  sendUiResponse(response: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(`${JSON.stringify(response)}\n`);
  }

  async prompt(message: string, deliverAs: DeliveryMode): Promise<void> {
    const response = await this.send({
      type: "prompt",
      message,
      streamingBehavior: deliverAs,
    });
    assertSuccess(response);
  }

  async abortTurn(): Promise<void> {
    const response = await this.send({ type: "abort" });
    assertSuccess(response);
  }

  async getState(): Promise<RpcState> {
    const response = await this.send({ type: "get_state" });
    assertSuccess(response);
    return response.data as RpcState;
  }

  async getMessages(): Promise<any[]> {
    const response = await this.send({ type: "get_messages" });
    assertSuccess(response);
    return Array.isArray(response.data?.messages) ? response.data.messages : [];
  }

  async setQueueModes(): Promise<void> {
    await this.send({ type: "set_steering_mode", mode: "all" }).then(assertSuccess).catch(() => undefined);
    await this.send({ type: "set_follow_up_mode", mode: "all" }).then(assertSuccess).catch(() => undefined);
  }

  async setSessionName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await this.send({ type: "set_session_name", name: trimmed }).then(assertSuccess);
  }

  terminate(): void {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc && this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
      }
    }, 5000);
  }

  private handleLine(line: string): void {
    let data: any;
    try {
      data = JSON.parse(line);
    } catch (error) {
      this.options.onProtocolError(`Invalid RPC JSON line: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (data?.type === "response" && typeof data.id === "string" && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id)!;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      pending.resolve(data as RpcResponse);
      return;
    }

    if (data?.type === "extension_ui_request") {
      this.handleExtensionUiRequest(data);
      this.options.onEvent(data);
      return;
    }

    this.options.onEvent(data);
  }

  private handleExtensionUiRequest(data: any): void {
    if (!data?.id || !data?.method) return;
    if (data.method === "confirm") {
      this.sendUiResponse({ type: "extension_ui_response", id: data.id, confirmed: false });
      return;
    }
    if (data.method === "select" || data.method === "input" || data.method === "editor") {
      this.sendUiResponse({ type: "extension_ui_response", id: data.id, cancelled: true });
    }
  }
}

class RecursoManager {
  private threads = new Map<string, ThreadEntry>();
  private routedMessageToolCalls = new Set<string>();
  private baseCwd: string | undefined;
  private readonly managerId = process.env.RECURSO_THREAD_ID || "parent";
  private readonly parentId = process.env.RECURSO_PARENT_THREAD_ID || "";
  private readonly runId = process.env.RECURSO_RUN_ID || `${safeName(this.managerId)}-${process.pid}`;
  private readonly depth = numberFromEnv("RECURSO_DEPTH", 0);
  private readonly maxDepth = numberFromEnv("RECURSO_MAX_DEPTH", 3);
  private readonly maxParallelThreads = numberFromEnv("RECURSO_MAX_PARALLEL_THREADS", 10);
  private bootstrapChildren = process.env.RECURSO_BOOTSTRAP_CHILDREN === "1";

  constructor(private readonly pi: ExtensionAPI) {}

  setCwd(cwd: string): void {
    this.baseCwd = cwd;
    ensureDir(this.recursoDir(cwd));
    const childSessionDir = this.configuredLocalSessionDir(cwd);
    if (childSessionDir) ensureDir(childSessionDir);
    ensureDir(this.promptsDir(cwd));
    ensureDir(this.runsDir(cwd));
    this.writeSnapshot(cwd);
  }

  setBootstrapChildren(value: boolean): void {
    if (process.env.RECURSO_BOOTSTRAP_CHILDREN === "0") {
      this.bootstrapChildren = false;
      return;
    }
    if (process.env.RECURSO_BOOTSTRAP_CHILDREN === "1") {
      this.bootstrapChildren = true;
      return;
    }
    this.bootstrapChildren = value;
  }

  currentThreadId(): string {
    return this.managerId;
  }

  async startFresh(options: StartThreadOptions): Promise<ThreadEntry> {
    return this.startThread(options);
  }

  async fork(options: StartThreadOptions): Promise<ThreadEntry> {
    if (!options.sourceSessionFile) {
      throw new Error("Cannot fork without a source session file.");
    }
    return this.startThread(options);
  }

  async sendToThread(target: string, message: string, deliverAs: DeliveryMode, from = this.managerId): Promise<string> {
    const thread = this.threads.get(target);
    if (!thread) {
      throw new Error(`Thread ${target} is not owned by this Recurso manager.`);
    }
    if (isDead(thread)) {
      throw new Error(`Thread ${target} is not live. Fork from its session to continue it.`);
    }

    const payload = formatThreadPrompt({ from, type: "progress", message });
    await thread.rpc.prompt(payload, deliverAs);
    await this.refreshThreadState(thread).catch(() => undefined);
    return `Sent ${deliverAs} message to ${target}.`;
  }

  async routeMessageFromTool(params: {
    from: string;
    target: string;
    type: ThreadMessageType;
    message: string;
    deliverAs: DeliveryMode;
  }): Promise<{ routed: boolean; note: string }> {
    const routed: RoutedThreadMessage = { ...params, routedAt: Date.now() };

    if (params.target === "parent" || (this.parentId && params.target === this.parentId)) {
      if (this.parentId) {
        return {
          routed: false,
          note: `Message emitted for supervisor routing from ${params.from} to ${params.target}.`,
        };
      }
      return {
        routed: false,
        note: "This Recurso manager has no parent thread.",
      };
    }

    if (params.target === "root" && this.parentId) {
      return {
        routed: false,
        note: `Message emitted for supervisor routing from ${params.from} to root.`,
      };
    }

    if (params.target === this.managerId || params.target === "root") {
      await this.deliverToLocalAgent(routed);
      return { routed: true, note: `Routed ${params.type} message from ${params.from} to this thread.` };
    }

    const targetThread = this.threads.get(params.target);
    if (targetThread && !isDead(targetThread)) {
      targetThread.lastMessage = routed;
      targetThread.updatedAt = Date.now();
      await targetThread.rpc.prompt(formatThreadPrompt(params), params.deliverAs);
      await this.refreshThreadState(targetThread).catch(() => undefined);
      this.writeSnapshot(targetThread.cwd);
      return { routed: true, note: `Routed ${params.type} message from ${params.from} to ${params.target}.` };
    }

    return {
      routed: false,
      note: `Message target ${params.target} is not local. A supervising Recurso manager may route it.`,
    };
  }

  async peek(threadId: string, mode: "compact" | "messages" | "tools" | "raw", maxEntries: number): Promise<{
    text: string;
    details: Record<string, unknown>;
  }> {
    const thread = this.threads.get(threadId);

    if (thread && !isDead(thread)) {
      await this.refreshThreadState(thread).catch(() => undefined);
      const messages = await thread.rpc.getMessages();
      return renderPeek(thread, messages, mode, maxEntries);
    }

    const sessionFile = thread?.sessionFile;
    if (sessionFile && fs.existsSync(sessionFile)) {
      const messages = readMessagesFromSession(sessionFile);
      return renderPeek(thread, messages, mode, maxEntries, sessionFile);
    }

    throw new Error(`Thread ${threadId} was not found in this manager.`);
  }

  list(): ThreadSnapshot[] {
    return Array.from(this.threads.values()).map(snapshotThread);
  }

  listRun(includeDescendants: boolean): ThreadSnapshot[] {
    const direct = this.list().map((thread) => ({
      ...thread,
      ownerManagerId: this.managerId,
      direct: true,
    }));
    if (!includeDescendants || !this.baseCwd) return direct;

    const byId = new Map<string, ThreadSnapshot>();
    for (const thread of direct) byId.set(thread.id, thread);

    for (const snapshot of this.readRunSnapshots(this.baseCwd)) {
      const ownerManagerId = snapshot.managerId || "unknown";
      for (const thread of snapshot.threads || []) {
        if (!thread?.id || byId.has(thread.id)) continue;
        byId.set(thread.id, {
          ...thread,
          ownerManagerId,
          direct: ownerManagerId === this.managerId,
        });
      }
    }

    return Array.from(byId.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async abort(threadId: string, action: "abort_turn" | "terminate"): Promise<string> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} was not found in this manager.`);

    if (action === "abort_turn") {
      await thread.rpc.abortTurn();
      thread.status = "aborted";
      thread.updatedAt = Date.now();
      this.writeSnapshot(thread.cwd);
      return `Aborted the current turn in ${threadId}. The thread process is still live.`;
    }

    thread.status = "aborted";
    thread.finishedAt = Date.now();
    thread.updatedAt = Date.now();
    thread.rpc.terminate();
    this.writeSnapshot(thread.cwd);
    return `Terminated thread ${threadId}.`;
  }

  shutdown(): void {
    for (const thread of this.threads.values()) {
      thread.rpc.terminate();
    }
    this.threads.clear();
    if (this.baseCwd) this.writeSnapshot(this.baseCwd);
  }

  release(): void {
    if (this.baseCwd) this.writeSnapshot(this.baseCwd);
  }

  private async startThread(options: StartThreadOptions): Promise<ThreadEntry> {
    const cwd = options.ctx.cwd || this.baseCwd || process.cwd();
    this.setCwd(cwd);

    if (this.depth >= this.maxDepth) {
      throw new Error(`Max Recurso depth ${this.maxDepth} reached.`);
    }

    const liveCount = this.liveThreadCount(cwd);
    if (liveCount >= this.maxParallelThreads) {
      throw new Error(`Max parallel Recurso threads ${this.maxParallelThreads} reached for this Recurso run.`);
    }

    const id = newThreadId();
    const childDepth = this.depth + 1;
    const workerKind = options.sourceSessionFile ? "forked worker" : "fresh worker";
    const promptFile = path.join(this.promptsDir(cwd), `${id}.md`);
    const prompt = buildThreadPrompt({
      id,
      parentId: this.managerId,
      workerKind,
      task: options.task,
      context: options.context,
      depth: childDepth,
      maxDepth: this.maxDepth,
    });
    fs.writeFileSync(promptFile, prompt, "utf8");

    const args = this.buildChildArgs(cwd, promptFile, options);
    const rpc = new RpcProcess(args, {
      cwd,
      env: {
        ...process.env,
        RECURSO_THREAD_ID: id,
        RECURSO_PARENT_THREAD_ID: this.managerId,
        RECURSO_RUN_ID: this.runId,
        RECURSO_DEPTH: String(childDepth),
      },
      onEvent: (event) => {
        void this.handleThreadEvent(id, event);
      },
      onExit: (code, signal) => {
        this.handleThreadExit(id, code, signal);
      },
      onProtocolError: (message) => {
        const thread = this.threads.get(id);
        if (thread) {
          thread.lastError = message;
          thread.updatedAt = Date.now();
          this.writeSnapshot(thread.cwd);
        }
      },
    });

    const thread: ThreadEntry = {
      id,
      parentId: this.managerId,
      task: options.task,
      cwd,
      depth: childDepth,
      status: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rpc,
      sessionName: options.name,
    };
    this.threads.set(id, thread);
    this.writeSnapshot(cwd);

    try {
      await rpc.start();
      thread.pid = rpc.pid;
      await rpc.setQueueModes();
      const initialState = await rpc.getState();
      applyState(thread, initialState);
      if (options.name) {
        await rpc.setSessionName(options.name);
        thread.sessionName = options.name;
      } else {
        const defaultName = `Recurso ${id}`;
        await rpc.setSessionName(defaultName).catch(() => undefined);
        thread.sessionName = defaultName;
      }
      thread.status = "idle";
      thread.updatedAt = Date.now();
      this.writeSnapshot(cwd);

      await rpc.prompt(buildInitialThreadMessage({
        id,
        parentId: this.managerId,
        workerKind,
        task: options.task,
        context: options.context,
      }), "followUp");
      thread.status = "running";
      thread.updatedAt = Date.now();
      await this.refreshThreadState(thread).catch(() => undefined);
      this.writeSnapshot(cwd);
      return thread;
    } catch (error) {
      thread.status = "error";
      thread.lastError = error instanceof Error ? error.message : String(error);
      thread.finishedAt = Date.now();
      thread.updatedAt = Date.now();
      rpc.terminate();
      this.writeSnapshot(cwd);
      throw error;
    }
  }

  private buildChildArgs(cwd: string, promptFile: string, options: StartThreadOptions): string[] {
    const args = [
      "--mode",
      "rpc",
      "--append-system-prompt",
      promptFile,
    ];
    const childSessionDir = this.childSessionDir(cwd, options);
    if (childSessionDir) {
      args.splice(2, 0, "--session-dir", childSessionDir);
    }

    if (this.bootstrapChildren) {
      args.push("--no-extensions", "--extension", EXTENSION_FILE);
    }

    if (options.sourceSessionFile) {
      args.push("--fork", options.sourceSessionFile);
    }
    if (options.provider) {
      args.push("--provider", options.provider);
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.thinking) {
      args.push("--thinking", options.thinking);
    }
    if (options.tools?.length) {
      args.push("--tools", unique([...options.tools, ...RECURSO_TOOLS]).join(","));
    }

    return args;
  }

  private async handleThreadEvent(threadId: string, event: any): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;

    thread.updatedAt = Date.now();

    if (event?.type === "agent_start") {
      thread.status = "running";
    } else if (event?.type === "agent_end") {
      if (thread.status !== "done" && thread.status !== "waiting") {
        thread.status = "idle";
      }
    } else if (event?.type === "message_end" && event.message?.role === "assistant") {
      const text = firstText(event.message);
      if (text) thread.lastAssistantText = text;
    } else if (event?.type === "tool_execution_start") {
      thread.lastTool = event.toolName;
      if (event.toolName === TOOL_MESSAGE) {
        await this.routeSupervisedMessage(thread, toolMessageArgsFromEvent(event), event.toolCallId).catch((error) => {
          thread.lastError = error instanceof Error ? error.message : String(error);
        });
      }
    } else if (event?.type === "tool_execution_end") {
      if (event.toolName === TOOL_MESSAGE) {
        await this.routeSupervisedMessage(thread, toolMessageArgsFromEvent(event), event.toolCallId).catch((error) => {
          thread.lastError = error instanceof Error ? error.message : String(error);
        });
      }
    } else if (event?.type === "extension_ui_request") {
      if (event.method === "confirm") {
        thread.lastError = "An extension UI confirmation was auto-denied in RPC mode.";
      }
    }

    this.writeSnapshot(thread.cwd);
  }

  private async routeSupervisedMessage(fromThread: ThreadEntry, args: any, toolCallId?: string): Promise<void> {
    if (toolCallId && this.routedMessageToolCalls.has(toolCallId)) return;
    const parsed = parseThreadMessageArgs(args);
    if (!parsed) return;

    fromThread.lastMessage = {
      from: fromThread.id,
      target: parsed.target,
      type: parsed.type,
      message: parsed.message,
      deliverAs: parsed.deliverAs,
      routedAt: Date.now(),
    };

    if (parsed.type === "question") fromThread.status = "waiting";
    if (parsed.type === "done") fromThread.status = "done";

    if (parsed.target === "parent" || parsed.target === this.managerId || parsed.target === "root") {
      await this.deliverToLocalAgent(fromThread.lastMessage);
      if (toolCallId) this.routedMessageToolCalls.add(toolCallId);
      return;
    }

    const target = this.threads.get(parsed.target);
    if (!target || isDead(target)) return;

    await target.rpc.prompt(
      formatThreadPrompt({
        from: fromThread.id,
        type: parsed.type,
        message: parsed.message,
      }),
      parsed.deliverAs,
    );
    target.lastMessage = fromThread.lastMessage;
    target.updatedAt = Date.now();
    if (toolCallId) this.routedMessageToolCalls.add(toolCallId);
  }

  private async deliverToLocalAgent(message: RoutedThreadMessage): Promise<void> {
    const text = formatThreadPrompt(message);
    try {
      await this.pi.sendUserMessage(text, { deliverAs: message.deliverAs });
    } catch (errorWithMode) {
      try {
        await this.pi.sendUserMessage(text);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        const modeText = errorWithMode instanceof Error ? errorWithMode.message : String(errorWithMode);
        throw new Error(`${messageText}${modeText && modeText !== messageText ? ` (${modeText})` : ""}`);
      }
    }
  }

  private handleThreadExit(threadId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.exitCode = code;
    thread.signal = signal;
    thread.finishedAt = Date.now();
    thread.updatedAt = Date.now();
    if (thread.status !== "aborted") {
      thread.status = code === 0 ? "exited" : "error";
    }
    if (code !== 0 && code !== null) {
      thread.lastError = `RPC process exited with code ${code}. ${thread.rpc.getStderrTail()}`.trim();
    }
    this.writeSnapshot(thread.cwd);
  }

  private async refreshThreadState(thread: ThreadEntry): Promise<void> {
    if (isDead(thread)) return;
    const state = await thread.rpc.getState();
    applyState(thread, state);
    thread.updatedAt = Date.now();
  }

  private recursoDir(cwd: string): string {
    return path.join(cwd, ".pi", "recurso");
  }

  private configuredLocalSessionDir(cwd: string): string | undefined {
    const configured = process.env.RECURSO_SESSION_DIR?.trim();
    if (!configured) return undefined;
    const normalized = configured.toLowerCase();
    if (RECURSO_ISOLATED_SESSION_DIR_VALUES.has(normalized)) return path.join(this.recursoDir(cwd), "sessions");
    if (PI_DEFAULT_SESSION_DIR_VALUES.has(normalized) || normalized === "cwd" || normalized === "pi-cwd") return undefined;
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  }

  private childSessionDir(cwd: string, options: StartThreadOptions): string | undefined {
    const configured = process.env.RECURSO_SESSION_DIR?.trim();
    const normalized = configured?.toLowerCase();
    if (normalized === "cwd" || normalized === "pi-cwd") return undefined;
    const local = this.configuredLocalSessionDir(cwd);
    if (local) return local;

    const parentSessionFile = currentSessionFile(options.ctx);
    return parentSessionFile ? path.dirname(parentSessionFile) : undefined;
  }

  private promptsDir(cwd: string): string {
    return path.join(this.recursoDir(cwd), "prompts");
  }

  private runsDir(cwd: string): string {
    return path.join(this.recursoDir(cwd), "runs");
  }

  private liveThreadCount(cwd: string): number {
    const seen = new Set<string>();
    let count = 0;

    for (const thread of this.threads.values()) {
      if (isLiveThreadSnapshot(thread)) {
        seen.add(thread.id);
        count += 1;
      }
    }

    try {
      for (const snapshot of this.readRunSnapshots(cwd)) {
        for (const thread of snapshot.threads || []) {
          if (typeof thread?.id !== "string" || seen.has(thread.id)) continue;
          if (!isLiveThreadSnapshot(thread)) continue;
          seen.add(thread.id);
          count += 1;
        }
      }
    } catch {
      // The in-memory count is still useful if diagnostic snapshots are unreadable.
    }

    return count;
  }

  private readRunSnapshots(cwd: string): RunSnapshot[] {
    const snapshots: RunSnapshot[] = [];
    const dir = this.runsDir(cwd);
    if (!fs.existsSync(dir)) return snapshots;

    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const file = path.join(dir, entry);
        const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
        if (snapshot?.runId !== this.runId || !Array.isArray(snapshot.threads)) continue;
        snapshots.push(snapshot);
      } catch {
        // Registry snapshots are diagnostic; ignore partially written or old files.
      }
    }

    return snapshots;
  }

  private writeSnapshot(cwd: string): void {
    try {
      ensureDir(this.runsDir(cwd));
      const snapshot = {
        schemaVersion: RECURSO_SNAPSHOT_SCHEMA_VERSION,
        managerId: this.managerId,
        parentId: this.parentId || null,
        runId: this.runId,
        managerPid: process.pid,
        depth: this.depth,
        packageRoot: PACKAGE_ROOT,
        updatedAt: Date.now(),
        threads: this.list(),
      };
      const out = path.join(this.runsDir(cwd), `${safeName(this.managerId)}-${process.pid}.json`);
      atomicWriteJson(out, snapshot);
    } catch {
      // Registry snapshots are diagnostic only.
    }
  }
}

export default function recurso(pi: ExtensionAPI) {
  const manager = new RecursoManager(pi);
  let dashboardProcess: ChildProcess | null = null;
  let dashboardUrl: string | null = null;

  pi.on("session_start", (_event, ctx) => {
    manager.setCwd(ctx.cwd);
    const ownTool = pi.getAllTools().find((tool) => tool.name === TOOL_NEW);
    manager.setBootstrapChildren(ownTool?.sourceInfo?.scope === "temporary");
  });

  pi.on("session_shutdown", () => {
    if (shutdownBehavior() === "terminate") {
      manager.shutdown();
    } else {
      manager.release();
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    return applyOpenAICacheLineage(event.payload, ctx);
  });

  pi.registerTool({
    name: TOOL_NEW,
    label: "Recurso New Thread",
    description: "Start a fresh live Pi RPC Recurso thread. The thread can be messaged later by ID.",
    promptSnippet: "Start a fresh Recurso thread",
    promptGuidelines: [
      "Use recurso_new_thread for independent work that does not need the parent conversation history.",
      "Give recurso_new_thread a bounded task and clear deliverable.",
      "Tell spawned threads to report completion with recurso_message_thread targeting parent.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Thread assignment and expected deliverable." }),
      context: Type.Optional(Type.String({ description: "Additional context appended to the thread instructions." })),
      name: Type.Optional(Type.String({ description: "Optional session display name for the thread." })),
      model: Type.Optional(Type.String({ description: "Optional Pi model pattern for the thread." })),
      provider: Type.Optional(Type.String({ description: "Optional Pi provider name for the thread." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist. Recurso tools are added automatically." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const thread = await manager.startFresh({
          ctx,
          ...params,
          provider: params.provider || currentProvider(ctx),
          model: params.model || currentModelId(ctx),
          thinking: params.thinking || currentThinkingLevel(ctx),
        });
        return {
          content: [{ type: "text", text: renderStartedThread(thread, "fresh") }],
          details: toolDetails(startedThreadDetails(thread)),
        };
      } catch (error) {
        return errorResult(error, "new_thread_failed", {
          parent_thread_id: manager.currentThreadId(),
          attempted_task: params.task,
        });
      }
    },
  });

  pi.registerTool({
    name: TOOL_FORK,
    label: "Recurso Fork Thread",
    description: "Fork the current Pi session, or an existing Recurso thread, into a live Pi RPC Recurso thread.",
    promptSnippet: "Fork a Recurso thread from current or previous context",
    promptGuidelines: [
      "Use recurso_fork_thread when the new thread needs the current conversation context.",
      "Use fork_from to branch from a previous Recurso thread's session.",
      "Do not poll forked threads while waiting. They should report via recurso_message_thread.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Thread assignment and expected deliverable." }),
      fork_from: Type.Optional(Type.String({ description: "Optional Recurso thread ID to fork from instead of the current session." })),
      context: Type.Optional(Type.String({ description: "Additional context appended to the thread instructions." })),
      name: Type.Optional(Type.String({ description: "Optional session display name for the thread." })),
      model: Type.Optional(Type.String({ description: "Optional Pi model pattern for the thread." })),
      provider: Type.Optional(Type.String({ description: "Optional Pi provider name for the thread." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const)),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist. Recurso tools are added automatically." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        let sourceSessionFile: string | undefined;
        if (params.fork_from) {
          const peeked = manager.list().find((thread) => thread.id === params.fork_from);
          sourceSessionFile = peeked?.sessionFile;
          if (!sourceSessionFile) {
            throw new Error(`Cannot fork from ${params.fork_from}: no session file is known yet.`);
          }
        } else {
          sourceSessionFile = currentSessionFile(ctx);
          if (!sourceSessionFile) {
            throw new Error("Cannot fork current session because Pi did not expose a session file. Use recurso_new_thread instead.");
          }
        }

        const thread = await manager.fork({
          ctx,
          task: params.task,
          context: params.context,
          name: params.name,
          model: params.model || currentModelId(ctx),
          provider: params.provider || currentProvider(ctx),
          thinking: params.thinking || currentThinkingLevel(ctx),
          tools: params.tools,
          sourceSessionFile,
          forkFromThread: params.fork_from,
        });
        return {
          content: [{ type: "text", text: renderStartedThread(thread, params.fork_from ? `forked from ${params.fork_from}` : "forked from current session") }],
          details: toolDetails(startedThreadDetails(thread)),
        };
      } catch (error) {
        return errorResult(error, "fork_failed", {
          parent_thread_id: manager.currentThreadId(),
          attempted_task: params.task,
          fork_from: params.fork_from || null,
        });
      }
    },
  });

  pi.registerTool({
    name: TOOL_MESSAGE,
    label: "Recurso Message Thread",
    description: "Send a follow-up or steering message to a Recurso thread, parent, or sibling routed by a supervising manager.",
    promptSnippet: "Message a Recurso thread; defaults to follow-up queueing",
    promptGuidelines: [
      "Use recurso_message_thread to communicate between Recurso threads.",
      "Use target parent to message the thread that spawned you.",
      "Default deliver_as is followUp. Use steer only for urgent corrections or blockers.",
      "After sending type question or done to parent, stop working unless the spawning thread sends more instructions.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Target thread ID, parent, or root." }),
      type: StringEnum(["question", "done", "progress"] as const),
      message: Type.String({ description: "Self-contained message." }),
      deliver_as: Type.Optional(StringEnum(["followUp", "steer"] as const)),
    }),
    async execute(_toolCallId, params) {
      const parsed = parseThreadMessageArgs(params);
      if (!parsed) return errorResult(new Error("Invalid message_thread arguments."));

      const result = await manager.routeMessageFromTool({
        from: process.env.RECURSO_THREAD_ID || "parent",
        target: parsed.target,
        type: parsed.type,
        message: parsed.message,
        deliverAs: parsed.deliverAs,
      });

      return {
        content: [{ type: "text", text: result.note }],
        details: toolDetails({
          routed: result.routed,
          from: process.env.RECURSO_THREAD_ID || "parent",
          target: parsed.target,
          type: parsed.type,
          message: parsed.message,
          deliverAs: parsed.deliverAs,
          deliver_as: parsed.deliverAs,
        }),
        terminate: isSupervisorTarget(parsed.target) && (parsed.type === "question" || parsed.type === "done"),
      };
    },
  });

  pi.registerTool({
    name: TOOL_PEEK,
    label: "Recurso Peek Thread",
    description: "Inspect a Recurso thread for debugging or when a received message needs more context. Do not use this as a waiting loop.",
    promptSnippet: "Debug or inspect a Recurso thread when needed",
    promptGuidelines: [
      "Do not use recurso_peek_thread just to check whether a worker is done.",
      "While waiting, stop and let recurso_message_thread wake you.",
      "Use recurso_peek_thread only when you suspect a thread is blocked, need diagnosis, or need context for a received message.",
      "Prefer compact mode first when peeking is necessary.",
    ],
    parameters: Type.Object({
      thread_id: Type.String({ description: "Thread ID to inspect." }),
      mode: Type.Optional(StringEnum(["compact", "messages", "tools", "raw"] as const)),
      max_entries: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "Maximum entries to show. Default 20." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const mode = params.mode || "compact";
        const maxEntries = clamp(Math.floor(params.max_entries || 20), 1, 100);
        const peek = await manager.peek(params.thread_id, mode, maxEntries);
        return {
          content: [{ type: "text", text: peek.text }],
          details: toolDetails(peek.details),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: TOOL_LIST,
    label: "Recurso List Threads",
    description: "List live Recurso threads in this run. Direct threads are owned by this manager; descendants come from run snapshots.",
    promptSnippet: "List Recurso threads",
    parameters: Type.Object({
      include_descendants: Type.Optional(Type.Boolean({ description: "Include descendant threads discovered from Recurso run snapshots. Default true." })),
    }),
    async execute(_toolCallId, params) {
      const includeDescendants = params.include_descendants !== false;
      const threads = manager.listRun(includeDescendants);
      if (threads.length === 0) {
        return {
          content: [{ type: "text", text: "No Recurso threads are live in this manager." }],
          details: toolDetails({ threads: [], includeDescendants }),
        };
      }
      return {
        content: [{ type: "text", text: renderThreadList(threads) }],
        details: toolDetails({ threads, includeDescendants }),
      };
    },
  });

  pi.registerTool({
    name: TOOL_ABORT,
    label: "Recurso Abort Thread",
    description: "Abort a Recurso thread's current turn or terminate the thread process.",
    promptSnippet: "Abort or terminate a Recurso thread",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Thread ID to abort or terminate." }),
      action: Type.Optional(StringEnum(["abort_turn", "terminate"] as const)),
    }),
    async execute(_toolCallId, params) {
      try {
        const text = await manager.abort(params.thread_id, params.action || "abort_turn");
        return {
          content: [{ type: "text", text }],
          details: toolDetails({ threadId: params.thread_id, action: params.action || "abort_turn" }),
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerCommand("recurso-status", {
    description: "Show live Recurso thread inventory",
    handler: async (_args, ctx) => {
      const threads = manager.list();
      const runThreads = manager.listRun(true);
      ctx.ui.notify(
        runThreads.length === 0 ? "Recurso: no live threads." : `Recurso: ${threads.length} direct, ${runThreads.length} in run tree.`,
        "info",
      );
    },
  });

  pi.registerCommand("recurso-stop-all", {
    description: "Terminate all live Recurso threads spawned by this manager",
    handler: async (_args, ctx) => {
      const count = manager.list().length;
      manager.shutdown();
      ctx.ui.notify(`Recurso stopped ${count} thread(s).`, "info");
    },
  });

  pi.registerCommand("recurso-dashboard", {
    description: "Start the optional Recurso Dashboard for this workspace",
    handler: async (args, ctx) => {
      try {
        if (dashboardProcess && childProcessIsAlive(dashboardProcess)) {
          ctx.ui.notify(`Recurso Dashboard is already running at ${dashboardUrl || "the previous dashboard URL"}.`, "info");
          return;
        }

        dashboardProcess = null;
        dashboardUrl = null;

        const cwd = commandCwd(ctx);
        const options = parseDashboardCommandOptions(args);
        let command = resolveDashboardCommand(cwd);

        if (!command) {
          const packageSpec = dashboardPackageSpec();
          if (options.noInstall) {
            ctx.ui.notify(dashboardInstallHelp(packageSpec), "info");
            return;
          }

          const confirmed = options.install || await confirmDashboardInstall(ctx, packageSpec);
          if (!confirmed) {
            ctx.ui.notify(dashboardInstallHelp(packageSpec), "info");
            return;
          }

          command = npmExecDashboardCommand(packageSpec);
        }

        const host = process.env.RECURSO_DASHBOARD_HOST || "127.0.0.1";
        const port = await findOpenDashboardPort(options.port || numberFromEnv("RECURSO_DASHBOARD_PORT", RECURSO_DASHBOARD_DEFAULT_PORT), host);
        const runsDir = runsDirForWorkspace(cwd);
        const url = `http://${host}:${port}`;
        const dashboardArgs = [
          ...command.args,
          "--workspace",
          cwd,
          "--runs-dir",
          runsDir,
          "--host",
          host,
          "--port",
          String(port),
        ];

        if (process.env.RECURSO_SESSION_DIR) {
          dashboardArgs.push("--session-dir", process.env.RECURSO_SESSION_DIR);
        }

        const proc = spawn(command.command, dashboardArgs, {
          cwd,
          env: {
            ...process.env,
            RECURSO_DASHBOARD_WORKSPACE: cwd,
            RECURSO_RUNS_DIR: runsDir,
            RECURSO_DASHBOARD_HOST: host,
            RECURSO_DASHBOARD_PORT: String(port),
          },
          detached: true,
          stdio: "ignore",
          shell: false,
        });

        dashboardProcess = proc;
        dashboardUrl = url;

        proc.once("exit", () => {
          if (dashboardProcess === proc) {
            dashboardProcess = null;
            dashboardUrl = null;
          }
        });

        proc.unref();
        await sleep(800);

        if (proc.exitCode !== null) {
          dashboardProcess = null;
          dashboardUrl = null;
          throw new Error(`Dashboard process exited immediately with code ${proc.exitCode}.`);
        }

        ctx.ui.notify(`Recurso Dashboard starting at ${url} (${command.source}).`, "info");
      } catch (error) {
        ctx.ui.notify(`Recurso Dashboard failed to start: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("recurso-dashboard-stop", {
    description: "Stop the Recurso Dashboard started by this Pi session",
    handler: async (_args, ctx) => {
      if (!dashboardProcess || !childProcessIsAlive(dashboardProcess)) {
        dashboardProcess = null;
        dashboardUrl = null;
        ctx.ui.notify("Recurso Dashboard is not running.", "info");
        return;
      }

      terminateDashboardProcess(dashboardProcess);
      dashboardProcess = null;
      dashboardUrl = null;
      ctx.ui.notify("Recurso Dashboard stopped.", "info");
    },
  });
}

function assertSuccess(response: RpcResponse): void {
  if (!response.success) {
    throw new Error(response.error || `RPC ${response.command} failed`);
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function commandCwd(ctx: any): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
}

function parseDashboardCommandOptions(args: any): DashboardCommandOptions {
  const words = commandWords(args);
  const options: DashboardCommandOptions = { install: false, noInstall: false };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--install") {
      options.install = true;
      continue;
    }
    if (word === "--no-install") {
      options.noInstall = true;
      continue;
    }
    if (word === "--port" && words[index + 1]) {
      options.port = parseDashboardPort(words[index + 1]);
      index += 1;
      continue;
    }
    if (word.startsWith("--port=")) {
      options.port = parseDashboardPort(word.slice("--port=".length));
    }
  }

  return options;
}

function commandWords(args: any): string[] {
  if (Array.isArray(args)) return args.map(String);
  if (typeof args === "string") return splitCommandWords(args);
  if (typeof args?.raw === "string") return splitCommandWords(args.raw);
  if (typeof args?.text === "string") return splitCommandWords(args.text);
  if (Array.isArray(args?.args)) return args.args.map(String);
  return [];
}

function splitCommandWords(value: string): string[] {
  return value.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  }) || [];
}

function parseDashboardPort(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}

function dashboardPackageSpec(): string {
  return process.env.RECURSO_DASHBOARD_PACKAGE || RECURSO_DASHBOARD_DEFAULT_PACKAGE;
}

function resolveDashboardCommand(cwd: string): DashboardCommand | undefined {
  const envBin = process.env.RECURSO_DASHBOARD_BIN?.trim();
  if (envBin) return { command: envBin, args: [], source: "RECURSO_DASHBOARD_BIN" };

  const binName = dashboardBinName();
  const workspaceBin = path.join(cwd, "node_modules", ".bin", binName);
  if (fileIsExecutable(workspaceBin)) return { command: workspaceBin, args: [], source: "workspace install" };

  const adjacentCheckout = path.resolve(PACKAGE_ROOT, "..", "recurso-dashboard", "bin", "recurso-dashboard.mjs");
  if (fs.existsSync(adjacentCheckout)) return { command: process.execPath, args: [adjacentCheckout], source: "adjacent dashboard checkout" };

  const pathBin = findOnPath(binName);
  if (pathBin) return { command: pathBin, args: [], source: "PATH" };

  return undefined;
}

function dashboardBinName(): string {
  return process.platform === "win32" ? "recurso-dashboard.cmd" : "recurso-dashboard";
}

function fileIsExecutable(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findOnPath(binName: string): string | undefined {
  const pathEnv = process.env.PATH || "";
  const names = process.platform === "win32"
    ? [binName, binName.replace(/\.cmd$/i, ""), binName.replace(/\.cmd$/i, ".exe")]
    : [binName];

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fileIsExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

function npmExecDashboardCommand(packageSpec: string): DashboardCommand {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return {
    command: npm,
    args: ["exec", "--yes", "--package", packageSpec, "--", "recurso-dashboard"],
    source: `npm exec ${packageSpec}`,
  };
}

async function confirmDashboardInstall(ctx: any, packageSpec: string): Promise<boolean> {
  if (typeof ctx?.ui?.confirm !== "function") return false;
  return Boolean(await ctx.ui.confirm(
    "Install Recurso Dashboard?",
    `The dashboard is optional. Recurso can run it for this workspace with npm exec --package ${packageSpec}. Continue?`,
  ));
}

function dashboardInstallHelp(packageSpec: string): string {
  return `Recurso Dashboard is optional. Install it with "npm install -D ${packageSpec}", or set RECURSO_DASHBOARD_BIN to a dashboard binary, then run /recurso-dashboard again.`;
}

function runsDirForWorkspace(cwd: string): string {
  return path.join(cwd, ".pi", "recurso", "runs");
}

async function findOpenDashboardPort(startPort: number, host: string): Promise<number> {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await dashboardPortIsOpen(port, host)) return port;
  }
  return startPort;
}

function dashboardPortIsOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function childProcessIsAlive(proc: ChildProcess): boolean {
  if (proc.killed || proc.exitCode !== null) return false;
  return typeof proc.pid === "number" ? pidIsAlive(proc.pid) : true;
}

function terminateDashboardProcess(proc: ChildProcess): void {
  try {
    if (process.platform !== "win32" && proc.pid) {
      process.kill(-proc.pid, "SIGTERM");
      return;
    }
  } catch {
    // Fall back to killing the process handle below.
  }

  try {
    proc.kill("SIGTERM");
  } catch {
    // The process may already be gone.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSupervisorTarget(target: string): boolean {
  const parentId = process.env.RECURSO_PARENT_THREAD_ID;
  return Boolean(parentId) && (target === "parent" || target === parentId);
}

function newThreadId(): string {
  return `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isDead(thread: ThreadEntry): boolean {
  return thread.rpc.killed || thread.rpc.exitCode !== null || thread.status === "exited" || thread.status === "error";
}

function isLiveThreadSnapshot(thread: { status?: string; pid?: number; exitCode?: number | null }): boolean {
  if (!thread) return false;
  if (thread.exitCode !== undefined && thread.exitCode !== null) return false;
  if (thread.status === "exited" || thread.status === "error") return false;
  if (typeof thread.pid === "number" && thread.pid > 0) return pidIsAlive(thread.pid);
  return true;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function currentSessionFile(ctx: any): string | undefined {
  try {
    const value = ctx.sessionManager?.getSessionFile?.();
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

function currentProvider(ctx: any): string | undefined {
  const provider = ctx?.model?.provider;
  return typeof provider === "string" && provider ? provider : undefined;
}

function currentModelId(ctx: any): string | undefined {
  const modelId = ctx?.model?.id;
  return typeof modelId === "string" && modelId ? modelId : undefined;
}

function currentThinkingLevel(ctx: any): ThinkingLevel | undefined {
  const level = ctx?.model?.thinkingLevel || ctx?.thinkingLevel;
  return isThinkingLevel(level) ? level : undefined;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function shutdownBehavior(): "keep" | "terminate" {
  return process.env[RECURSO_SHUTDOWN_BEHAVIOR_ENV]?.toLowerCase() === "terminate" ? "terminate" : "keep";
}

function applyState(thread: ThreadEntry, state: RpcState): void {
  if (state.sessionFile) thread.sessionFile = state.sessionFile;
  if (state.sessionId) thread.sessionId = state.sessionId;
  if (state.sessionName) thread.sessionName = state.sessionName;
  if (typeof state.messageCount === "number") thread.messageCount = state.messageCount;
  if (typeof state.pendingMessageCount === "number") thread.pendingMessageCount = state.pendingMessageCount;
  if (state.isStreaming) {
    thread.status = "running";
  } else if (thread.status === "running" || thread.status === "starting") {
    thread.status = "idle";
  }
}

function snapshotThread(thread: ThreadEntry): ThreadSnapshot {
  return {
    schemaVersion: RECURSO_SNAPSHOT_SCHEMA_VERSION,
    id: thread.id,
    parentId: thread.parentId,
    task: thread.task,
    depth: thread.depth,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    finishedAt: thread.finishedAt,
    pid: thread.pid,
    sessionFile: thread.sessionFile,
    sessionId: thread.sessionId,
    sessionName: thread.sessionName,
    messageCount: thread.messageCount,
    pendingMessageCount: thread.pendingMessageCount,
    exitCode: thread.exitCode,
    signal: thread.signal,
    lastError: thread.lastError,
    lastAssistantText: thread.lastAssistantText,
    lastTool: thread.lastTool,
    lastMessage: thread.lastMessage,
  };
}

function buildThreadPrompt(input: {
  id: string;
  parentId: string;
  workerKind: "fresh worker" | "forked worker";
  task: string;
  context?: string;
  depth: number;
  maxDepth: number;
}): string {
  const parentTarget = input.parentId === "parent" ? "parent" : input.parentId;
  const parentLine =
    input.parentId === "parent"
      ? 'The thread that spawned you is the root parent session. Use target "parent" to message it.'
      : `The thread that spawned you is ${input.parentId}. Prefer target "${input.parentId}" when messaging it; target "parent" is only a live-run convenience alias.`;
  const lines = [
    `You are Recurso thread ${input.id}.`,
    `Current session role: ${input.workerKind}.`,
    parentLine,
    `Depth: ${input.depth}/${input.maxDepth}.`,
    "",
    "You are a normal Recurso agent with the same Recurso tools as other threads. Focus on the assignment below; treat prior conversation as context, not as permission to take over the whole session.",
    "",
    "Assignment:",
    input.task,
    "",
  ];

  if (input.context?.trim()) {
    lines.push("Additional context:", input.context.trim(), "");
  }

  lines.push(
    "Communication:",
    `- Use ${TOOL_MESSAGE} with target "${parentTarget}" for questions, sparse progress, or completion to the thread that spawned you.`,
    '- Target "parent" remains available as a convenience alias during live runs, but concrete thread IDs are clearer and more durable.',
    "- Use concrete Recurso thread IDs to message known sibling or descendant threads.",
    "- Use type question only for cross-boundary decisions or blockers.",
    "- Use type done when the assignment is complete.",
    "- After question or done to your spawning thread, stop after the tool call unless you were explicitly told to keep working.",
    "- Default deliver_as followUp. Use steer only for urgent blockers.",
    "",
    "Coordination:",
    "- Work independently for local, reversible details.",
    "- You may create, fork, and message Recurso threads when a bounded subtask benefits from parallel work.",
    "- Avoid decisions that unexpectedly change another thread's scope; ask or report when coordination matters.",
    "- Keep reports concise and include files changed and checks run when relevant.",
  );

  if (input.depth < input.maxDepth) {
    lines.push("", `You may use ${TOOL_FORK} or ${TOOL_NEW} for clearly independent subtasks, but keep the thread tree purposeful.`);
  }

  return lines.join("\n");
}

function buildInitialThreadMessage(input: {
  id: string;
  parentId: string;
  workerKind: "fresh worker" | "forked worker";
  task: string;
  context?: string;
}): string {
  const lines = [
    "Assigned task:",
    input.task,
    "",
  ];

  if (input.context?.trim()) {
    lines.push("Additional context:", input.context.trim(), "");
  }

  lines.push(buildGeneratedWorkerContext(input));
  return lines.join("\n");
}

function buildGeneratedWorkerContext(input: {
  id: string;
  parentId: string;
  workerKind: "fresh worker" | "forked worker";
}): string {
  const parentTarget = input.parentId === "parent" ? "parent" : input.parentId;
  const reportTargetLine =
    input.parentId === "parent"
      ? 'Use target "parent" to report to the root parent session.'
      : `Prefer target "${input.parentId}" to report to your parent/orchestrator. You may also use target "parent" during this live run.`;

  return [
    "---",
    "Recurso-generated worker context:",
    `- Current session role: ${input.workerKind}`,
    `- Worker thread id: ${input.id}`,
    `- Parent/orchestrator thread id: ${input.parentId}`,
    "- This block was generated by Recurso. Treat it as the authoritative identity for this turn.",
    "- Complete only the assigned task above. Do not continue into later backlog items.",
    "- Treat forked conversation history as context, not as evidence that you are the parent/orchestrator.",
    "- Execute only within the scope you were assigned.",
    "- Report sparse progress only when useful.",
    "- When complete or blocked, call recurso_message_thread and then stop.",
    "- After sending type done or question, stop and wait to be woken.",
    "",
    "Report completion with:",
    "```text",
    "recurso_message_thread({",
    `  target: "${parentTarget}",`,
    '  type: "done",',
    '  message: "Summary, files changed, checks run, risks."',
    "})",
    "```",
    reportTargetLine,
  ].join("\n");
}

function parseThreadMessageArgs(args: any): { target: string; type: ThreadMessageType; message: string; deliverAs: DeliveryMode } | null {
  if (!args || typeof args !== "object") return null;
  const target = typeof args.target === "string" ? args.target.trim() : "";
  const type = args.type === "question" || args.type === "done" || args.type === "progress" ? args.type : undefined;
  const message = typeof args.message === "string" ? args.message.trim() : "";
  const deliverAs = args.deliver_as === "steer" || args.deliverAs === "steer" ? "steer" : "followUp";
  if (!target || !type || !message) return null;
  return { target, type, message, deliverAs };
}

function toolMessageArgsFromEvent(event: any): any {
  if (!event || typeof event !== "object") return {};
  const resultDetails = event.result?.details;
  return event.args || event.input || event.arguments || resultDetails || event.result?.input || {};
}

function formatThreadPrompt(input: { from: string; type: ThreadMessageType; message: string }): string {
  const label = input.type === "question" ? "question" : input.type === "done" ? "done" : "progress";
  return [`[Recurso message from ${input.from}]`, `Type: ${label}`, "", input.message].join("\n");
}

function renderStartedThread(thread: ThreadEntry, source: string): string {
  const parentTarget = thread.parentId === "parent" ? "parent" : thread.parentId;
  return [
    `Started Recurso worker thread ${thread.id} (${source}).`,
    `Child thread id: ${thread.id}`,
    `Parent/orchestrator thread id: ${thread.parentId}`,
    `Status: ${thread.status}`,
    `Task: ${thread.task}`,
    thread.sessionFile ? `Session: ${thread.sessionFile}` : "Session: starting",
    "",
    `The child can report with target "parent" or the concrete parent id "${parentTarget}".`,
    `Send patient messages with ${TOOL_MESSAGE} deliver_as followUp.`,
    `Use deliver_as steer only for urgent correction or blockers.`,
  ].join("\n");
}

function startedThreadDetails(thread: ThreadEntry): Record<string, unknown> {
  return {
    ok: true,
    child_thread_id: thread.id,
    parent_thread_id: thread.parentId,
    session_path: thread.sessionFile || null,
    status: thread.status,
    can_message_parent_targets: unique(["parent", thread.parentId]),
    thread: snapshotThread(thread),
  };
}

function renderThreadList(threads: ThreadSnapshot[]): string {
  const lines = [`Recurso threads (${threads.length}):`, ""];
  for (const thread of threads) {
    const ownership = thread.direct === false ? `descendant via ${thread.ownerManagerId || "unknown"}` : "direct";
    lines.push(`- ${thread.id} [${thread.status}] depth ${thread.depth} (${ownership})`);
    lines.push(`  task: ${oneLine(thread.task, 140)}`);
    if (thread.sessionFile) lines.push(`  session: ${thread.sessionFile}`);
    if (thread.lastMessage) {
      lines.push(`  last message: ${thread.lastMessage.type} from ${thread.lastMessage.from} to ${thread.lastMessage.target}`);
    }
    if (thread.lastError) lines.push(`  last error: ${oneLine(thread.lastError, 160)}`);
  }
  return lines.join("\n");
}

function renderPeek(
  thread: ThreadEntry | undefined,
  messages: any[],
  mode: "compact" | "messages" | "tools" | "raw",
  maxEntries: number,
  fallbackSessionFile?: string,
): { text: string; details: Record<string, unknown> } {
  const summary = summarizeMessages(messages);
  const id = thread?.id || "unknown";

  if (mode === "messages") {
    const rendered = messages.slice(-maxEntries).map(renderMessageSummary);
    return {
      text: [`Thread ${id} messages (last ${rendered.length}/${messages.length}):`, "", ...rendered].join("\n"),
      details: { threadId: id, messageCount: messages.length },
    };
  }

  if (mode === "tools") {
    const tools = summary.tools.slice(-maxEntries);
    return {
      text: [`Thread ${id} tools (last ${tools.length}/${summary.tools.length}):`, "", ...tools.map((tool) => `- ${tool}`)].join("\n"),
      details: { threadId: id, toolCount: summary.tools.length },
    };
  }

  if (mode === "raw") {
    const sessionFile = thread?.sessionFile || fallbackSessionFile;
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      return {
        text: `Thread ${id} has no readable session file yet.`,
        details: { threadId: id },
      };
    }
    const rawLines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").slice(-maxEntries);
    return {
      text: [`Thread ${id} raw session entries (last ${rawLines.length}):`, "```jsonl", ...rawLines, "```"].join("\n"),
      details: { threadId: id, sessionFile },
    };
  }

  const parts = [
    `Thread ${id} [${thread?.status || "persisted"}]`,
    thread?.task ? `Task: ${thread.task}` : undefined,
    `Messages: ${messages.length}`,
    thread?.pendingMessageCount !== undefined ? `Pending: ${thread.pendingMessageCount}` : undefined,
    thread?.sessionFile || fallbackSessionFile ? `Session: ${thread?.sessionFile || fallbackSessionFile}` : undefined,
    summary.lastAssistantText ? `Last assistant: ${oneLine(summary.lastAssistantText, 700)}` : undefined,
    summary.tools.length ? `Recent tools: ${summary.tools.slice(-8).join(", ")}` : undefined,
    thread?.lastError ? `Last error: ${oneLine(thread.lastError, 700)}` : undefined,
  ].filter(Boolean);

  return {
    text: parts.join("\n"),
    details: {
      threadId: id,
      status: thread?.status,
      messageCount: messages.length,
      toolCount: summary.tools.length,
      sessionFile: thread?.sessionFile || fallbackSessionFile,
    },
  };
}

function summarizeMessages(messages: any[]): { lastAssistantText: string; tools: string[] } {
  const tools: string[] = [];
  let lastAssistantText = "";

  for (const message of messages) {
    if (message?.role === "assistant") {
      for (const part of message.content || []) {
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
          lastAssistantText = part.text.trim();
        } else if (part?.type === "toolCall") {
          tools.push(`${part.name || "tool"}(${summarizeArgs(part.arguments)})`);
        }
      }
    }
  }

  return { lastAssistantText, tools };
}

function renderMessageSummary(message: any): string {
  if (!message || typeof message !== "object") return "- unknown message";
  if (message.role === "assistant") {
    const text = firstText(message);
    const toolNames = (message.content || [])
      .filter((part: any) => part?.type === "toolCall")
      .map((part: any) => part.name)
      .filter(Boolean);
    const details = [text ? oneLine(text, 220) : "", toolNames.length ? `tools: ${toolNames.join(", ")}` : ""].filter(Boolean).join(" | ");
    return `- assistant: ${details || "(no text)"}`;
  }
  if (message.role === "user") {
    return `- user: ${oneLine(firstText(message), 220)}`;
  }
  if (message.role === "toolResult") {
    return `- toolResult ${message.toolName || message.toolCallId || ""}: ${oneLine(firstText(message), 220)}`;
  }
  return `- ${message.role || "message"}: ${oneLine(firstText(message), 220)}`;
}

function firstText(message: any): string {
  for (const part of message?.content || []) {
    if (part?.type === "text" && typeof part.text === "string") return part.text.trim();
  }
  return "";
}

function summarizeArgs(args: any): string {
  if (!args || typeof args !== "object") return "";
  const pathValue = args.path || args.file_path || args.target || args.command;
  if (typeof pathValue === "string") return oneLine(pathValue, 60);
  const raw = JSON.stringify(args);
  return raw ? oneLine(raw, 60) : "";
}

function oneLine(text: string, max: number): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function readMessagesFromSession(sessionFile: string): any[] {
  const raw = fs.readFileSync(sessionFile, "utf8");
  const messages: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "message" && entry.message) {
        messages.push(entry.message);
      }
    } catch {
      // Ignore malformed or partial lines.
    }
  }
  return messages;
}

function errorResult(
  error: unknown,
  code = "recurso_error",
  extra: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Recurso error: ${message}` }],
    details: toolDetails({
      ok: false,
      error: code,
      details: message,
      ...extra,
    }),
  };
}

function toolDetails<T extends Record<string, unknown>>(details: T): T & { recursoApiVersion: string; schemaVersion: number } {
  return {
    recursoApiVersion: RECURSO_API_VERSION,
    schemaVersion: RECURSO_SNAPSHOT_SCHEMA_VERSION,
    ...details,
  };
}

function applyOpenAICacheLineage(payload: unknown, ctx: any): unknown {
  if (!envFlag(RECURSO_OPENAI_CACHE_LINEAGE_ENV)) return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  const params = payload as Record<string, unknown>;
  if (typeof params.prompt_cache_key !== "string") return undefined;

  const lineageKey = getPromptCacheLineageKey(ctx?.sessionManager);
  if (!lineageKey) return undefined;

  return {
    ...params,
    prompt_cache_key: lineageKey,
  };
}

function getPromptCacheLineageKey(sessionManager: any): string | undefined {
  const header = sessionManager?.getHeader?.();
  const ownId = typeof header?.id === "string" ? header.id : sessionManager?.getSessionId?.();
  const parentSession = typeof header?.parentSession === "string" ? header.parentSession : undefined;
  const lineageSource = findRootSessionId(parentSession) || ownId;
  if (typeof lineageSource !== "string" || !lineageSource) return undefined;

  const digest = crypto.createHash("sha256").update(lineageSource).digest("hex").slice(0, 48);
  return `recurso-${digest}`;
}

function findRootSessionId(sessionFile: string | undefined, seen = new Set<string>()): string | undefined {
  if (!sessionFile || seen.has(sessionFile)) return undefined;
  seen.add(sessionFile);

  try {
    const header = readSessionHeader(sessionFile);
    if (!header) return undefined;
    const parentSession = typeof header.parentSession === "string" ? header.parentSession : undefined;
    return findRootSessionId(parentSession, seen) || (typeof header.id === "string" ? header.id : undefined);
  } catch {
    return undefined;
  }
}

function readSessionHeader(sessionFile: string): any | undefined {
  const raw = fs.readFileSync(sessionFile, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (entry?.type === "session") return entry;
  }
  return undefined;
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
