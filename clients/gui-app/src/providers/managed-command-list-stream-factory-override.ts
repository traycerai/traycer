import type { ManagedCommandListStreamClientFactory } from "@/stores/managed-commands/managed-command-list-store";

/**
 * Test / production seam for `ManagedCommandListStreamMount`. Production leaves
 * this `null` and the mount builds a real `ManagedCommandListStreamClient`;
 * tests install a stub factory so the mount runs in jsdom without a live host
 * socket.
 */
let streamClientFactoryOverride: ManagedCommandListStreamClientFactory | null =
  null;

export function __setManagedCommandListStreamClientFactoryForTests(
  factory: ManagedCommandListStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getManagedCommandListStreamClientFactoryOverride(): ManagedCommandListStreamClientFactory | null {
  return streamClientFactoryOverride;
}
