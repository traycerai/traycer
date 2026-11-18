import { negotiatedVersionMeetsRequirement } from "@traycer-clients/shared/host-transport/host-messenger";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/**
 * `environment.status@1.1` is the first answer that carries `planes`. A host
 * below that, or one whose handshake has not advertised the method, has no
 * cohort or dated line (E4 greys the picker row). `null` (no handshake yet)
 * is unknown, not "too old".
 *
 * Pattern: `personal-entry-mark.tsx` / `negotiatedVersionMeetsRequirement`.
 */
export const STATUS_PLANES_REQUIRED_HOST_VERSION = {
  method: "environment.status",
  version: { major: 1, minor: 1 },
} as const;

export function statusPlanesSupported(
  negotiated: NegotiatedMethodVersion,
): boolean {
  if (negotiated === null || negotiated === false) return false;
  return negotiatedVersionMeetsRequirement(
    negotiated,
    STATUS_PLANES_REQUIRED_HOST_VERSION,
  );
}
