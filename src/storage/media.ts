import type { IMGentStore } from "./store.js";
import type { InboundMessage } from "@imgent/contracts";

function localMediaPaths(message: InboundMessage | { expired: true }): string[] {
  if ("expired" in message) return [];
  return message.parts.flatMap((part) => {
    if (!("attachment" in part) || !part.attachment.localPath) return [];
    return [part.attachment.localPath];
  });
}

export function cleanupExpiredRawEvents(store: IMGentStore): number {
  return Number(
    store.database
      .prepare(
        `UPDATE inbound_events
         SET message_json = '{"expired":true}', reply_context_cipher = NULL
         WHERE raw_expires_at IS NOT NULL AND raw_expires_at <= ?`,
      )
      .run(new Date().toISOString()).changes,
  );
}

export function releasableMediaEvents(
  store: IMGentStore,
): Array<{ eventId: string; paths: string[] }> {
  return store
    .all<{ id: string; message_json: string }>(
      `SELECT e.id, e.message_json
       FROM inbound_events e
       WHERE e.message_json LIKE '%"localPath"%'
         AND NOT EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.inbound_event_id = e.id
             AND t.status IN ('queued', 'active', 'retry_wait', 'waiting_approval')
         )`,
    )
    .flatMap((row) => {
      const paths = localMediaPaths(
        JSON.parse(row.message_json) as InboundMessage | { expired: true },
      );
      return paths.length ? [{ eventId: row.id, paths }] : [];
    });
}

export function referencedMediaPaths(store: IMGentStore): string[] {
  return store
    .all<{ message_json: string }>(
      `SELECT message_json FROM inbound_events
       WHERE message_json LIKE '%"localPath"%'`,
    )
    .flatMap((row) =>
      localMediaPaths(JSON.parse(row.message_json) as InboundMessage | { expired: true }),
    );
}

export function clearLocalMediaPaths(store: IMGentStore, eventId: string): void {
  const row = store.get<{ message_json: string }>(
    "SELECT message_json FROM inbound_events WHERE id = ?",
    eventId,
  );
  if (!row) return;
  const message = JSON.parse(row.message_json) as InboundMessage | { expired: true };
  if ("expired" in message) return;
  for (const part of message.parts) {
    if ("attachment" in part) delete part.attachment.localPath;
  }
  store.run(
    "UPDATE inbound_events SET message_json = ? WHERE id = ?",
    JSON.stringify(message),
    eventId,
  );
}
