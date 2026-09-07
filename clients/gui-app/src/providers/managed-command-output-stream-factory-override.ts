import type { ManagedCommandOutputStreamClientFactory } from "@/stores/managed-commands/managed-command-output-store";

/** Production null builds a real client. Tests install a stub so the tile runs in jsdom without a live socket. */
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
