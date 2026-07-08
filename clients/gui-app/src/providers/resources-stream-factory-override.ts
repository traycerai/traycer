import type { ResourcesStreamClientFactory } from "@/stores/resources/resources-store";

/**
 * Test / production seam for `ResourcesStreamMount`. Production leaves this
 * `null` and the mount builds a real `ResourcesStreamClient`; tests install a
 * stub factory so the mount can run in jsdom without a live host socket.
 */
let streamClientFactoryOverride: ResourcesStreamClientFactory | null = null;

export function __setResourcesStreamClientFactoryForTests(
  factory: ResourcesStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getResourcesStreamClientFactoryOverride(): ResourcesStreamClientFactory | null {
  return streamClientFactoryOverride;
}
