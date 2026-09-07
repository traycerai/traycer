import { useSyncExternalStore } from "react";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
  subscribeNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SchemaVersion } from "@traycer/protocol/framework/index";

/** Fails closed: false means missing or not yet handshaken. Gate optional RPCs before offering the action. */
export function useHostSupportsMethod(
  hostId: string | null,
  method: string,
): boolean {
  return useHostMethodSupport(hostId, method) === true;
}

/** null is unknown, false is known-absent. Do not collapse those when hiding would strand data. */
export function useHostMethodSupport(
  hostId: string | null,
  method: string,
): boolean | null {
  return useSyncExternalStore(subscribeNegotiatedManifests, () => {
    if (hostId === null) return null;
    const methods = getNegotiatedHostMethods(hostId);
    if (methods === null) return null;
    return methods.has(method);
  });
}

/** Canonical schema version advertised in the host's last handshake. */
export function useHostMethodSchemaVersion(
  hostId: string | null,
  method: string,
): SchemaVersion | null {
  return useSyncExternalStore(subscribeNegotiatedManifests, () => {
    if (hostId === null) return null;
    return getNegotiatedHostMethodVersion(hostId, method);
  });
}
