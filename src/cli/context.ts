import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { IdentityService } from "../identity/service.js";
import { CredentialStore } from "../security/credential-store.js";
import { IMGentStore } from "../storage/store.js";

export async function openAdminContext(configPath: string): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  credentials: CredentialStore;
  store: IMGentStore;
  identity: IdentityService;
}> {
  const config = await loadConfig(configPath);
  const credentials = new CredentialStore(config.dataDir);
  const store = await IMGentStore.open(
    join(config.dataDir, "imgent.sqlite"),
    await credentials.secretBox(),
  );
  return {
    config,
    credentials,
    store,
    identity: new IdentityService(store),
  };
}
