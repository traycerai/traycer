import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";

type Listener = () => void;
const waiting = new Map<string, Set<Listener>>();

function keyFor(
  epicId: string,
  hostId: string,
  chatId: string,
  instanceId: string,
): string {
  return sessionKeyOf([epicId, hostId, chatId, instanceId]);
}

/** The hosted chat body lives outside EpicShell's React provider tree. */
export function subscribeChatTileSessionAcquired(
  identity: {
    readonly epicId: string;
    readonly hostId: string;
    readonly chatId: string;
    readonly instanceId: string;
  },
  listener: Listener,
): () => void {
  const key = keyFor(
    identity.epicId,
    identity.hostId,
    identity.chatId,
    identity.instanceId,
  );
  let listeners = waiting.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    waiting.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) waiting.delete(key);
  };
}

/** Called only after the tile's own session hook has acquired its lease. */
export function notifyChatTileSessionAcquired(
  epicId: string,
  hostId: string,
  chatId: string,
  instanceId: string,
): void {
  const listeners = waiting.get(keyFor(epicId, hostId, chatId, instanceId));
  if (listeners === undefined) return;
  for (const listener of listeners) listener();
}
