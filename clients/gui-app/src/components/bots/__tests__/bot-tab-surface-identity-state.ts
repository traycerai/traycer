/**
 * What the identity files' mocked boundaries read: the sessions the surface is
 * served, the host client, and what the surface's composer and probe record.
 * It imports no app module at run time, so a mock factory can reach it while
 * the app's modules are still loading. The harness resets it for every case.
 */
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export const channelHandles = {
  handles: new Map<string, unknown>(),
  client: null as HostRequester<HostRpcRegistry> | null,
  /** A stored image's read waits for the gate of its hash, while there is one. */
  imageGates: new Map<string, PromiseWithResolvers<void>>(),
  /** The drafts store's owner and whether its own drafts were read, at every commit of the surface's composer. */
  commits: [] as Array<{
    readonly owner: string | null;
    readonly read: boolean;
  }>,
  /** Every (viewer, A's markers) pair the probe under the surface's composer saw. */
  observed: [] as Array<{
    readonly at: "render" | "layout";
    readonly viewer: string | null;
    readonly markers: ReadonlyArray<string>;
  }>,
};
