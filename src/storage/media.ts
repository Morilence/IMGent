import type { IMGentStore } from "./store.js";
import type { InboundMessage } from "@imgent/contracts";

function localMediaPaths(message: InboundMessage | { expired: true }): string[] {
  if ("expired" in message) return [];
  return message.parts.flatMap((part) => {
    if (!("attachment" in part) || !part.attachment.localPath) return [];
    return [part.attachment.localPath];
  });
}

function retainedTaskEnvelope(message: InboundMessage): InboundMessage {
  return {
    ...(message.eventId ? { eventId: message.eventId } : {}),
    messageId: message.messageId,
    dedupeKey: message.dedupeKey,
    ...(message.sequence ? { sequence: message.sequence } : {}),
    platform: message.platform,
    botInstanceId: message.botInstanceId,
    conversation: message.conversation,
    actor: {
      platformUserId: message.actor.platformUserId,
      ...(message.actor.platformMemberId
        ? { platformMemberId: message.actor.platformMemberId }
        : {}),
      ...(message.actor.role ? { role: message.actor.role } : {}),
    },
    parts: [],
    mentions: [],
    ...(message.platformSentAt ? { platformSentAt: message.platformSentAt } : {}),
    receivedAt: message.receivedAt,
    ...(message.triggered === undefined ? {} : { triggered: message.triggered }),
  };
}

export function cleanupExpiredRawEvents(store: IMGentStore): number {
  return store.transaction(() => {
    const timestamp = new Date().toISOString();
    const expired = store.all<{ id: string; message_json: string }>(
      `SELECT id, message_json FROM inbound_events
       WHERE raw_expires_at IS NOT NULL AND raw_expires_at <= ?`,
      timestamp,
    );
    for (const event of expired) {
      const message = JSON.parse(event.message_json) as InboundMessage | { expired: true };
      if (!("expired" in message)) {
        store.run(
          `UPDATE tasks
           SET message_json = ?, reply_context_cipher = NULL
           WHERE inbound_event_id = ?`,
          JSON.stringify(retainedTaskEnvelope(message)),
          event.id,
        );
      }
      store.run(
        `UPDATE inbound_events
         SET message_json = '{"expired":true}', reply_context_cipher = NULL,
             raw_expires_at = NULL
         WHERE id = ?`,
        event.id,
      );
    }
    return expired.length;
  });
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
