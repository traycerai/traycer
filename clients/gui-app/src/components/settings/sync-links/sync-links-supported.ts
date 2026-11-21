import { negotiatedVersionMeetsRequirement } from "@traycer-clients/shared/host-transport/host-messenger";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/**
 * `providers.syncLinks.list@1.0` is the first answer that names the computers
 * a 1.5.4 "Sync profiles" linked. A host below it (1.5.4 itself), or one whose
 * handshake has not answered yet (`null`), never shows the ask.
 */
export const SYNC_LINKS_REQUIRED_HOST_VERSION = {
  method: "providers.syncLinks.list",
  version: { major: 1, minor: 0 },
} as const;

export function syncLinksSupported(
  negotiated: NegotiatedMethodVersion,
): boolean {
  if (negotiated === null || negotiated === false) return false;
  return negotiatedVersionMeetsRequirement(
    negotiated,
    SYNC_LINKS_REQUIRED_HOST_VERSION,
  );
}
