import type { ServedMajorsByMethod } from "@traycer/protocol/framework/capability-manifest";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * The stream majors this client can actually serve, per method.
 * Both peers import the same `@traycer/protocol` registry, so without this a client advertises every major the registry installs - including majors whose client half has not been written.
 */
export const CLIENT_SERVED_STREAM_MAJORS: ServedMajorsByMethod = {
  /** `@1` only, permanently - this entry no longer holds anything back. */
  "epic.subscribe": [1],
} satisfies Partial<
  Readonly<Record<keyof HostStreamRpcRegistry, readonly number[]>>
>;
