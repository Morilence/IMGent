import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { configHash } from "../config/hash.js";
import { loadConfig } from "../config/index.js";
import {
  CONTROL_APP_VERSION,
  CONTROL_PROTOCOL_VERSION,
  type ControlMeta,
  type ServiceState,
} from "../control/protocol.js";
import { ControlServer, type ControlProjection } from "../control/server.js";
import { HealthServer, type HealthProjection } from "../health/server.js";
import { Logger } from "../runtime/logger.js";
import { AdminService } from "./admin-service.js";
import { IMGentApplication, type ReadinessReport } from "./application.js";
import {
  removeInstanceMetadata,
  resolveInstanceEndpoint,
  writeInstanceMetadata,
  type InstanceEndpoint,
} from "./instance.js";
import type { IMGentConfig } from "@imgent/contracts";

export class IMGentService implements ControlProjection, HealthProjection {
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly configPath: string;
  readonly config: IMGentConfig;

  private readonly logger = new Logger("service");
  private readonly hash: string;
  private readonly endpoint: InstanceEndpoint;
  private readonly controlServer: ControlServer;
  private readonly healthServer: HealthServer;
  private lifecycleState: ServiceState = "starting";
  private applicationValue: IMGentApplication | undefined;
  private adminValue: AdminService | undefined;
  private controlOwned = false;
  private metadataOwned = false;
  private stopped = false;

  private constructor(configPath: string, config: IMGentConfig, endpoint: InstanceEndpoint) {
    this.configPath = resolve(configPath);
    this.config = config;
    this.hash = configHash(config);
    this.endpoint = endpoint;
    this.controlServer = new ControlServer(endpoint, this);
    this.healthServer = new HealthServer(this);
  }

  static async start(configPath: string): Promise<IMGentService> {
    const config = await loadConfig(resolve(configPath));
    const endpoint = await resolveInstanceEndpoint(config.dataDir, { createDataDir: true });
    const service = new IMGentService(configPath, config, endpoint);
    await service.startInternal();
    return service;
  }

  meta(): ControlMeta {
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      appVersion: CONTROL_APP_VERSION,
      instanceId: this.instanceId,
      instanceKey: this.endpoint.instanceKey,
      state: this.lifecycleState,
      startedAt: this.startedAt,
      configHash: this.hash,
    };
  }

  admin(): AdminService | undefined {
    return this.adminValue;
  }

  state(): ServiceState {
    return this.lifecycleState;
  }

  async readiness(): Promise<ReadinessReport> {
    const application = this.applicationValue;
    if (!application) {
      return {
        ready: false,
        checkedAt: new Date(0).toISOString(),
        depth: "runtime",
        issues: [],
        bots: {},
        profiles: {},
      };
    }
    const readiness = application.readiness();
    await this.transition(readiness.ready ? "ready" : "degraded");
    return readiness;
  }

  async diagnostics(): Promise<ReadinessReport> {
    const application = this.applicationValue;
    if (!application) return this.readiness();
    const readiness = await application.refreshReadiness("diagnostic");
    await this.transition(readiness.ready ? "ready" : "degraded");
    return readiness;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const failures: unknown[] = [];
    try {
      await this.transition("stopping");
    } catch (error) {
      this.lifecycleState = "stopping";
      failures.push(error);
    }
    try {
      await this.controlServer.beginStopping();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.healthServer.stop();
    } catch (error) {
      failures.push(error);
    }
    const application = this.applicationValue;
    this.applicationValue = undefined;
    this.adminValue = undefined;
    try {
      await application?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (this.metadataOwned) {
        await removeInstanceMetadata(this.endpoint);
      }
      this.metadataOwned = false;
    } catch (error) {
      failures.push(error);
    } finally {
      if (this.controlOwned) {
        try {
          await this.controlServer.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      this.controlOwned = false;
    }
    this.logger.info("service.stopped", { instanceId: this.instanceId });
    if (failures.length > 0) throw failures[0];
  }

  private async startInternal(): Promise<void> {
    try {
      await this.controlServer.start();
      this.controlOwned = true;
      await this.persistMetadata();
      const application = await IMGentApplication.create(this.configPath);
      this.applicationValue = application;
      this.adminValue = new AdminService(application);
      await application.start();
      await this.healthServer.start();
      const readiness = await application.refreshReadiness("runtime");
      await this.transition(readiness.ready ? "ready" : "degraded");
      this.logger.info("service.started", {
        instanceId: this.instanceId,
        state: this.lifecycleState,
        bots: application.adapters.size,
        profiles: application.drivers.size,
      });
    } catch (error) {
      await this.healthServer.stop().catch(() => undefined);
      const application = this.applicationValue;
      this.applicationValue = undefined;
      this.adminValue = undefined;
      await application?.stop().catch(() => undefined);
      if (this.metadataOwned) {
        await removeInstanceMetadata(this.endpoint).catch(() => undefined);
        this.metadataOwned = false;
      }
      if (this.controlOwned) {
        await this.controlServer.stop().catch(() => undefined);
        this.controlOwned = false;
      }
      throw error;
    }
  }

  private async transition(state: ServiceState): Promise<void> {
    if (this.lifecycleState === state) return;
    if (this.lifecycleState === "stopping") return;
    this.lifecycleState = state;
    await this.persistMetadata();
  }

  private async persistMetadata(): Promise<void> {
    const configReference = relative(this.endpoint.dataDir, this.configPath);
    await writeInstanceMetadata(this.endpoint, {
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt: this.startedAt,
      configPath: isAbsolute(configReference) ? basename(this.configPath) : configReference,
      configHash: this.hash,
      state: this.lifecycleState,
    });
    this.metadataOwned = true;
  }
}
