import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { IMGentError, normalizeError } from "@imgent/contracts";
import { Logger } from "../runtime/logger.js";
import { parseCreateScheduleInput, parseUpdateScheduleInput } from "../schedule/service.js";
import {
  endpointEntryKind,
  removeStaleEndpoint,
  type InstanceEndpoint,
} from "../service/instance.js";
import {
  CONTROL_BODY_LIMIT,
  CONTROL_REQUEST_TIMEOUT_MS,
  type ControlFailure,
  type ControlMeta,
  type ControlSuccess,
} from "./protocol.js";
import type { AdminService } from "../service/admin-service.js";
import type { ReadinessReport } from "../service/application.js";

export interface ControlProjection {
  meta(): ControlMeta;
  admin(): AdminService | undefined;
  readiness(): Promise<ReadinessReport>;
  diagnostics(): Promise<ReadinessReport>;
}

export class ControlServer {
  private readonly logger = new Logger("control");
  private server: Server | undefined;
  private acceptingAdminRequests = true;
  private activeAdminRequests = 0;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    private readonly endpoint: InstanceEndpoint,
    private readonly projection: ControlProjection,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const kind = await endpointEntryKind(this.endpoint);
    if (kind === "unsafe") throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
    if (kind === "socket") {
      if (await endpointAcceptsConnections(this.endpoint.endpoint)) {
        throw new IMGentError("RUNTIME_INSTANCE_CONFLICT");
      }
      await removeStaleEndpoint(this.endpoint);
    }
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = CONTROL_REQUEST_TIMEOUT_MS;
    server.headersTimeout = CONTROL_REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = 1_000;
    try {
      await listen(server, this.endpoint.endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new IMGentError("RUNTIME_INSTANCE_CONFLICT", { cause: error });
      }
      throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE", { cause: error });
    }
    if (process.platform !== "win32") await chmod(this.endpoint.endpoint, 0o600);
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async beginStopping(): Promise<void> {
    this.acceptingAdminRequests = false;
    if (this.activeAdminRequests === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId =
      typeof request.headers["x-request-id"] === "string"
        ? request.headers["x-request-id"].slice(0, 128)
        : `req_${randomUUID()}`;
    let route = "/";
    let trackedAdminRequest = false;
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      route = url.pathname;
      const method = request.method ?? "GET";
      const metaRequest = method === "GET" && url.pathname === "/v3/meta";
      if (!metaRequest) {
        if (!this.acceptingAdminRequests) {
          throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE");
        }
        this.activeAdminRequests += 1;
        trackedAdminRequest = true;
      }
      const admin = this.projection.admin();
      let data: unknown;
      if (metaRequest) {
        data = this.projection.meta();
      } else if (!admin) {
        throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE");
      } else if (method === "GET" && url.pathname === "/v3/status") {
        const readiness = await this.projection.readiness();
        data = {
          service: this.projection.meta(),
          ...(await admin.status(readiness)),
        };
      } else if (method === "GET" && url.pathname === "/v3/readiness") {
        data = await this.projection.readiness();
      } else if (method === "POST" && url.pathname === "/v3/diagnostics") {
        assertEmptyObject(await readBody(request));
        data = await this.projection.diagnostics();
      } else if (method === "GET" && url.pathname === "/v3/identities") {
        data = admin.identities();
      } else if (method === "GET" && url.pathname === "/v3/groups") {
        data = admin.groups();
      } else if (method === "GET" && url.pathname === "/v3/conversations") {
        data = admin.conversations();
      } else if (method === "GET" && url.pathname === "/v3/schedules") {
        data = admin.schedules();
      } else if (method === "POST" && url.pathname === "/v3/schedules") {
        data = admin.createSchedule(parseCreateScheduleInput(await readBody(request)));
      } else if (method === "GET" && url.pathname === "/v3/skills") {
        data = admin.skills();
      } else if (method === "POST" && url.pathname === "/v3/skills/validate") {
        assertEmptyObject(await readBody(request));
        data = await admin.validateSkills();
      } else if (method === "POST" && url.pathname === "/v3/backups") {
        assertEmptyObject(await readBody(request));
        data = await admin.createControlledBackup();
      } else {
        const pairing = url.pathname.match(/^\/v3\/pairings\/([^/]+)\/confirm$/u);
        const group = url.pathname.match(/^\/v3\/groups\/([^/]+)\/authorize$/u);
        const scheduleHistory = url.pathname.match(/^\/v3\/schedules\/([^/]+)\/history$/u);
        const scheduleAction = url.pathname.match(
          /^\/v3\/schedules\/([^/]+)\/(update|pause|resume|remove|run|reset-context)$/u,
        );
        if (method === "POST" && pairing) {
          assertEmptyObject(await readBody(request));
          data = admin.confirmPairing(decodePathSegment(pairing[1]!));
        } else if (method === "POST" && group) {
          const body = await readBody(request);
          if (
            Object.keys(body).length !== 1 ||
            typeof body.principalId !== "string" ||
            body.principalId.length === 0
          ) {
            throw new IMGentError("CLI_USAGE_INVALID");
          }
          data = admin.authorizeGroup(decodePathSegment(group[1]!), body.principalId);
        } else if (method === "GET" && scheduleHistory) {
          data = admin.scheduleHistory(decodePathSegment(scheduleHistory[1]!));
        } else if (method === "POST" && scheduleAction) {
          const id = decodePathSegment(scheduleAction[1]!);
          const action = scheduleAction[2]!;
          const body = await readBody(request);
          if (action === "update") {
            data = admin.updateSchedule(id, parseUpdateScheduleInput(body));
          } else {
            assertEmptyObject(body);
            if (action === "pause") data = admin.pauseSchedule(id);
            else if (action === "resume") data = admin.resumeSchedule(id);
            else if (action === "remove") data = admin.removeSchedule(id);
            else if (action === "run") data = admin.runSchedule(id);
            else data = admin.resetScheduleContext(id);
          }
        } else {
          throw new IMGentError("CLI_USAGE_INVALID");
        }
      }
      this.logger.info("control.request", {
        requestId,
        method,
        route: routeLabel(url.pathname),
        result: "ok",
      });
      sendJson(response, 200, {
        ok: true,
        data,
        requestId,
      } satisfies ControlSuccess<unknown>);
    } catch (error) {
      const normalized = normalizeError(error);
      this.logger.errorFrom("control.request-failed", normalized, {
        requestId,
        method: request.method,
        route: routeLabel(route),
        result: "error",
      });
      sendJson(response, httpStatus(normalized.descriptor.kind), {
        ok: false,
        error: normalized.descriptor,
        requestId,
      } satisfies ControlFailure);
    } finally {
      if (trackedAdminRequest) this.finishAdminRequest();
    }
  }

  private finishAdminRequest(): void {
    this.activeAdminRequests -= 1;
    if (this.activeAdminRequests !== 0 || this.acceptingAdminRequests) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

async function endpointAcceptsConnections(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = request.headers["content-type"];
  if (typeof type !== "string" || !type.toLowerCase().startsWith("application/json")) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > CONTROL_BODY_LIMIT) throw new IMGentError("CLI_USAGE_INVALID");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new IMGentError("CLI_USAGE_INVALID", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IMGentError("CLI_USAGE_INVALID");
  }
  return value as Record<string, unknown>;
}

function assertEmptyObject(value: Record<string, unknown>): void {
  if (Object.keys(value).length !== 0) throw new IMGentError("CLI_USAGE_INVALID");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new IMGentError("CLI_USAGE_INVALID", { cause: error });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function httpStatus(kind: ReturnType<typeof normalizeError>["descriptor"]["kind"]): number {
  if (kind === "not_found") return 404;
  if (kind === "conflict") return 409;
  if (kind === "validation") return 400;
  if (kind === "authentication") return 401;
  if (kind === "authorization") return 403;
  if (kind === "compatibility") return 426;
  if (kind === "transient" || kind === "timeout" || kind === "rate_limit") return 503;
  return 500;
}

function routeLabel(path: string): string {
  if (/^\/v3\/pairings\/[^/]+\/confirm$/u.test(path)) return "/v3/pairings/:code/confirm";
  if (/^\/v3\/groups\/[^/]+\/authorize$/u.test(path)) return "/v3/groups/:id/authorize";
  if (/^\/v3\/schedules\/[^/]+\/history$/u.test(path)) return "/v3/schedules/:id/history";
  if (/^\/v3\/schedules\/[^/]+\/[^/]+$/u.test(path)) return "/v3/schedules/:id/:action";
  return path.slice(0, 128);
}
