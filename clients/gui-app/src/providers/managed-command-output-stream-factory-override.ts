import type { ManagedCommandOutputStreamClientFactory } from "@/stores/managed-commands/managed-command-output-store";

/**
 * Test / production seam for the output window's stream. Production leaves this
 * `null` and the window builds a real `ManagedCommandOutputStreamClient` over
 * its tab's bound host; tests install a stub factory so the tile runs in jsdom
 * without a live host socket.
 */
let streamClientFactoryOverride: ManagedCommandOutputStreamClientFactory | null =
  null;

export function __setManagedCommandOutputStreamClientFactoryForTests(
  factory: ManagedCommandOutputStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getManagedCommandOutputStreamClientFactoryOverride(): ManagedCommandOutputStreamClientFactory | null {
  return streamClientFactoryOverride;
}
