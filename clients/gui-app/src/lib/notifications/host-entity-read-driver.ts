import type { HostNotificationsEntityRef } from "@traycer/protocol/host/notifications/contracts";
import type { HostNotificationsFeedFrame } from "@/stores/notifications/host-notifications-store";
import {
  notificationEntityFromHostEntry,
  notificationEntityMatchesPresence,
} from "./notification-entity";

interface EntityRead {
  readonly entity: HostNotificationsEntityRef;
  generation: number;
  requested: number;
  accepted: number;
  pending: boolean;
}

/** Owned by one account/serving-host notification session, never a focused tile. */
export class HostEntityReadDriver {
  private readonly entries = new Map<string, EntityRead>();
  private epoch = 0;

  observe(frame: HostNotificationsFeedFrame): void {
    if (frame.kind === "snapshot" || frame.kind === "partitionSnapshot") {
      for (const entry of this.entries.values()) entry.generation += 1;
      return;
    }
    let entities: ReadonlyArray<HostNotificationsEntityRef | null> = [];
    if (frame.kind === "upserted") {
      entities = [notificationEntityFromHostEntry(frame.entry)];
    } else if (frame.kind === "readStateChanged" && frame.readAt === null) {
      entities = frame.entityRefs;
    }
    for (const entry of this.entries.values()) {
      if (
        entities.some(
          (entity) =>
            entity !== null &&
            notificationEntityMatchesPresence(entity, entry.entity),
        )
      )
        entry.generation += 1;
    }
  }

  request(
    entity: HostNotificationsEntityRef,
    markRead: (entity: HostNotificationsEntityRef) => Promise<unknown>,
  ): void {
    const key = JSON.stringify([entity.epicId, entity.chatId ?? null]);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = {
        entity,
        generation: 0,
        requested: -1,
        accepted: -1,
        pending: false,
      };
      this.entries.set(key, entry);
    }
    entry.requested = entry.generation;
    if (entry.pending || entry.accepted === entry.requested) return;
    this.send(entry, markRead);
  }

  reset(): void {
    this.epoch += 1;
    this.entries.clear();
  }

  private send(
    entry: EntityRead,
    markRead: (entity: HostNotificationsEntityRef) => Promise<unknown>,
  ): void {
    entry.pending = true;
    const epoch = this.epoch;
    const sent = entry.requested;
    void markRead(entry.entity)
      .then(
        () => {
          if (this.epoch === epoch) entry.accepted = sent;
        },
        () => {
          // The mutation reports the failure. The next visit can retry this generation.
        },
      )
      .finally(() => {
        if (this.epoch !== epoch) return;
        entry.pending = false;
        if (entry.requested > sent) this.send(entry, markRead);
      });
  }
}
