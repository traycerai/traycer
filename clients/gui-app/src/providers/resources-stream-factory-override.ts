import type { ResourcesStreamClientFactory } from "@/stores/resources/resources-store";

/**
 * Production null builds ResourcesStreamClient. Tests install a stub for jsdom.
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
