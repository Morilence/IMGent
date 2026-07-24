import Fastify, { type FastifyInstance } from "fastify";
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
  private server: FastifyInstance | undefined;

  constructor(private readonly projection: HealthProjection) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = Fastify({ logger: false });
    server.get("/healthz", async () => ({
      status: "ok",
      started: true,
      state: this.projection.state(),
    }));
    server.get("/readyz", async (request, reply) => {
      const readiness = await this.projection.readiness();
      if (!readiness.ready) reply.code(503);
      const locale = resolveLocale(
        [
          typeof request.headers["accept-language"] === "string"
            ? request.headers["accept-language"]
            : undefined,
          this.projection.config.defaultLocale,
        ],
        this.projection.config.defaultLocale,
      );
      return renderReadiness(readiness, locale);
    });
    try {
      await server.listen(this.projection.config.server);
      this.server = server;
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
  }
}
