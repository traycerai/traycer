/**
 * The seams a bot's memory reads the account through, scripted: the request
 * context's user (a client announces its swap through `onChange`) and the
 * host stream client binding (held until the test rebuilds it, as the real
 * hook's effect does, so the render after an account change still sees the
 * previous account's). A leaf module on purpose: a `vi.mock` factory of
 * `@/lib/host` awaits it, so it imports nothing that imports `@/lib/host`.
 */
import { useSyncExternalStore } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { MockWsStreamClient } from "@/components/epic-canvas/pr/__tests__/pr-stream-test-fixtures";
import type { HostStreamClientBinding } from "@/hooks/host/use-host-stream-client-for";
import { remoteAwareOwnerIdentityKey } from "@/lib/host/transport-key";

export const MEMORY_TARGET: HostDirectoryEntry = {
  hostId: "host-tab",
  label: "Host",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:1",
  version: null,
  transportDialability: "dialable",
};

/** The request context's user, announced the way a host client announces a swap. */
class ScriptedRequestContext {
  private userId: string | null = null;
  private readonly listeners = new Set<() => void>();

  getRequestContextUserId(): string | null {
    return this.userId;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(userId: string | null): void {
    this.userId = userId;
    for (const listener of [...this.listeners]) listener();
  }
}

export const scriptedRequestContext = new ScriptedRequestContext();

let held: HostStreamClientBinding | null = null;
const heldListeners = new Set<() => void>();

/** The binding the hook is handed from now on; `null` is no client yet. */
export function holdBinding(
  client: MockWsStreamClient<StreamFrameEnvelope> | null,
  userId: string | null,
): void {
  const transportKey = remoteAwareOwnerIdentityKey(MEMORY_TARGET, userId);
  held =
    client === null || transportKey === null
      ? null
      : { client, transportKey, pin: () => undefined, unpin: () => undefined };
  for (const listener of [...heldListeners]) listener();
}

function subscribeToHeld(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => {
    heldListeners.delete(listener);
  };
}

/** The mock of `use-host-stream-client-for`: the binding, and its client. */
export const streamClientBindingModule = {
  useHostStreamClientBindingFor: (): HostStreamClientBinding | null =>
    useSyncExternalStore(subscribeToHeld, () => held),
  useHostStreamClientFor: (): HostStreamClientBinding["client"] | null =>
    useSyncExternalStore(subscribeToHeld, () => held)?.client ?? null,
};
