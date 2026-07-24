import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type RpcId = string | number;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class JsonRpcProcess {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly onNotification: (notification: RpcNotification) => void,
    private readonly onServerRequest: (request: RpcRequest) => void,
    private readonly onDiagnostic: (message: string) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    const child = spawn(this.command, ["app-server", "--stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    this.process = child;
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      try {
        this.handle(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        this.onDiagnostic(
          `app-server stdout JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    const errors = createInterface({ input: child.stderr, crlfDelay: Infinity });
    errors.on("line", (line) => this.onDiagnostic(sanitizeDiagnostic(line)));
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      this.initialized = false;
      this.process = undefined;
      this.failAll(new Error(`Codex app-server 退出: code=${code} signal=${signal}`));
    });
    await this.request("initialize", {
      clientInfo: {
        name: "imgent",
        title: "IMGent",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
    this.initialized = true;
  }

  request<T>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.process) return Promise.reject(new Error("Codex app-server 未启动"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ method, ...(params ? { params } : {}) });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server stdin 不可写");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handle(message: Record<string, unknown>): void {
    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      const id = message.id as RpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        const error = message.error as { code?: number; message?: string };
        pending.reject(
          new Error(`Codex RPC ${error.code ?? ""}: ${error.message ?? "unknown error"}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    const envelope = {
      method: message.method,
      ...(message.params && typeof message.params === "object"
        ? { params: message.params as Record<string, unknown> }
        : {}),
    };
    if ("id" in message) {
      this.onServerRequest({ id: message.id as RpcId, ...envelope });
    } else {
      this.onNotification(envelope);
    }
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    const child = this.process;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replaceAll(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replaceAll(/"(?:token|secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 2_000);
}
