import { request as httpRequest } from "node:http";
import {
  IMGentError,
  isErrorDescriptor,
  normalizeError,
  type ErrorDescriptor,
  type IMGentConfig,
} from "@imgent/contracts";
import { configHash } from "../config/hash.js";
import {
  CONTROL_BODY_LIMIT,
  CONTROL_DIAGNOSTIC_TIMEOUT_MS,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_REQUEST_TIMEOUT_MS,
  type ControlMeta,
} from "../control/protocol.js";
import {
  endpointEntryKind,
  resolveInstanceEndpoint,
  type InstanceEndpoint,
} from "../service/instance.js";

export type ControlDiscovery =
  | { state: "stopped"; endpoint: InstanceEndpoint }
  | {
      state: "running";
      endpoint: InstanceEndpoint;
      client: ControlClient;
      meta: ControlMeta;
      configDrift: boolean;
    };

export class ControlClient {
  private constructor(
    readonly endpoint: InstanceEndpoint,
    readonly meta: ControlMeta,
    readonly expectedConfigHash: string,
  ) {}

  static async discover(config: IMGentConfig): Promise<ControlDiscovery> {
    const endpoint = await resolveInstanceEndpoint(config.dataDir);
    const kind = await endpointEntryKind(endpoint);
    if (kind === "unsafe") throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
    if (process.platform !== "win32" && kind === "absent") {
      return { state: "stopped", endpoint };
    }
    const expectedHash = configHash(config);
    let meta: ControlMeta;
    try {
      meta = await rawRequest<ControlMeta>(endpoint, "GET", "/v2/meta");
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (process.platform === "win32" && ["ENOENT", "ECONNREFUSED"].includes(code)) {
        return { state: "stopped", endpoint };
      }
      if (error instanceof IMGentError) throw error;
      throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE", { cause: error });
    }
    if (!isControlMeta(meta)) {
      throw new IMGentError("RUNTIME_CONTROL_PROTOCOL_UNSUPPORTED");
    }
    if (meta.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
      throw new IMGentError("RUNTIME_CONTROL_PROTOCOL_UNSUPPORTED");
    }
    if (meta.instanceKey !== endpoint.instanceKey) {
      throw new IMGentError("RUNTIME_INSTANCE_MISMATCH");
    }
    return {
      state: "running",
      endpoint,
      client: new ControlClient(endpoint, meta, expectedHash),
      meta,
      configDrift: meta.configHash !== expectedHash,
    };
  }

  async get<T>(path: string): Promise<T> {
    return rawRequest<T>(this.endpoint, "GET", path);
  }

  async post<T>(
    path: string,
    body: Record<string, unknown> = {},
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return rawRequest<T>(this.endpoint, "POST", path, body, timeoutMs);
  }

  diagnostics<T>(): Promise<T> {
    return this.post<T>("/v2/diagnostics", {}, CONTROL_DIAGNOSTIC_TIMEOUT_MS);
  }
}

async function rawRequest<T>(
  endpoint: InstanceEndpoint,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const serialized = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (serialized && serialized.byteLength > CONTROL_BODY_LIMIT) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
  return new Promise<T>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: endpoint.endpoint,
        path,
        method,
        headers: serialized
          ? {
              "content-type": "application/json",
              "content-length": String(serialized.byteLength),
            }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > CONTROL_BODY_LIMIT) {
            request.destroy(new IMGentError("RUNTIME_CONTROL_UNREACHABLE"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
              throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE");
            }
            if (parsed.ok === false && "error" in parsed && isErrorDescriptor(parsed.error)) {
              reject(remoteError(parsed.error));
              return;
            }
            if (parsed.ok !== true || !("data" in parsed)) {
              throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE");
            }
            resolve(parsed.data as T);
          } catch (error) {
            reject(new IMGentError("RUNTIME_CONTROL_UNREACHABLE", { cause: error }));
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new IMGentError("RUNTIME_CONTROL_UNREACHABLE"));
    });
    request.on("error", reject);
    if (serialized) request.write(serialized);
    request.end();
  });
}

function remoteError(descriptor: ErrorDescriptor): IMGentError {
  return normalizeError(descriptor);
}

function isControlMeta(value: unknown): value is ControlMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<ControlMeta>;
  return (
    typeof meta.protocolVersion === "number" &&
    typeof meta.appVersion === "string" &&
    typeof meta.instanceId === "string" &&
    typeof meta.instanceKey === "string" &&
    typeof meta.startedAt === "string" &&
    typeof meta.configHash === "string" &&
    ["starting", "ready", "degraded", "stopping"].includes(meta.state ?? "")
  );
}
