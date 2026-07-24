import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { IMGentError } from "@imgent/contracts";
import type { InstanceEndpoint } from "./instance.js";

export class OfflineLease {
  private constructor(
    readonly endpoint: InstanceEndpoint,
    private readonly server: Server,
  ) {}

  static async acquire(endpoint: InstanceEndpoint): Promise<OfflineLease> {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (process.platform !== "win32") await chmod(endpoint.endpoint, 0o600);
      return new OfflineLease(endpoint, server);
    } catch (error) {
      await closeIfListening(server);
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new IMGentError("RUNTIME_SERVICE_MUST_STOP", { cause: error });
      }
      throw new IMGentError("RUNTIME_CONTROL_UNREACHABLE", { cause: error });
    }
  }

  async release(): Promise<void> {
    await closeIfListening(this.server);
  }
}

async function closeIfListening(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
