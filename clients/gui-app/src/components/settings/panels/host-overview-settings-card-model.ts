import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { isReportedItemKind } from "@/components/settings/environment/status-chip-page-kinds";

/**
 * Where this computer's settings stand against Personal, as the Overview's
 * settings card says it:
 *
 * - `awaiting`: nothing has moved; the computer runs on its own settings.
 * - `moving`: the person accepted the move and the upload has not finished.
 * - `moved`: the person accepted the move on this computer and it finished
 *   (`Moved to Personal on …`, from `status.consent`).
 * - `other`: none of these; the card carries only the other tickets' lines.
 */
export type HostSettingsCardState =
  | { readonly kind: "awaiting" }
  | {
      readonly kind: "moving";
      readonly applied: number;
      readonly total: number;
    }
  | { readonly kind: "moved"; readonly acceptedAt: number }
  | { readonly kind: "other" };

export function hostSettingsCardState(
  status: EnvironmentStatusResponseV11,
): HostSettingsCardState {
  const setup = status.setup;
  if (setup === null || setup.stage !== "moving_settings") {
    return status.consent === null
      ? { kind: "other" }
      : { kind: "moved", acceptedAt: status.consent.acceptedAt };
  }
  if (setup.state === "awaiting_consent") return { kind: "awaiting" };
  const items = status.items.filter((item) => isReportedItemKind(item.kind));
  return {
    kind: "moving",
    applied: items.filter((item) => item.status === "applied").length,
    total: items.length + status.pendingUploads.length,
  };
}
