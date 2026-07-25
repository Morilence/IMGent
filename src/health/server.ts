import { createServer, type Server, type ServerResponse } from "node:http";
import { resolveLocale } from "../i18n/index.js";
import { renderReadiness, type ReadinessReport } from "../service/application.js";
import type { ServiceState } from "../control/protocol.js";
import type { IMGentConfig } from "@imgent/contracts";

export interface HealthProjection {
  readonly config: IMGentConfig;
  state(): ServiceState;
  readiness(): Promise<ReadinessReport>;
}

export class HealthServer {
  private server: Server | undefined;

  constructor(private readonly projection: HealthProjection) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (request.method === "GET" && path === "/healthz") {
          sendJson(response, 200, {
            status: "ok",
            started: true,
            state: this.projection.state(),
          });
          return;
        }
        if (request.method === "GET" && path === "/readyz") {
          const readiness = await this.projection.readiness();
          const locale = resolveLocale(
            [
              typeof request.headers["accept-language"] === "string"
                ? request.headers["accept-language"]
                : undefined,
              this.projection.config.defaultLocale,
            ],
            this.projection.config.defaultLocale,
          );
          sendJson(response, readiness.ready ? 200 : 503, renderReadiness(readiness, locale));
          return;
        }
        sendJson(response, 404, { status: "not_found" });
      })().catch(() => sendJson(response, 503, { status: "unavailable" }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.projection.config.server, () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.server = server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}
