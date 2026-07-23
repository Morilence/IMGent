import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { IdentityService } from "../identity/service.js";
import { CredentialStore } from "../security/credential-store.js";
import { PigeonStore } from "../storage/store.js";

export async function openAdminContext(configPath: string): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  credentials: CredentialStore;
  store: PigeonStore;
  identity: IdentityService;
}> {
  const config = await loadConfig(configPath);
  const credentials = new CredentialStore(config.dataDir);
  const store = await PigeonStore.open(
    join(config.dataDir, "agent-pigeon.sqlite"),
    await credentials.secretBox(),
  );
  return {
    config,
    credentials,
    store,
    identity: new IdentityService(store),
  };
}
