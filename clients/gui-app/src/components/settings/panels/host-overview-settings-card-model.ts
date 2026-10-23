import type { EnvironmentStatusResponse } from "@traycer/protocol/host/environment-schemas";

/**
 * Where this computer's settings stand against Personal, as the Overview's
 * settings card says it:
 *
 * - `awaiting`: nothing has moved; the computer runs on its own settings.
 * - `moving`: the person accepted the move and the upload has not finished.
 * - `other`: neither; the card carries only its dated lines.
 */
export type HostSettingsCardState =
  | { readonly kind: "awaiting" }
  | {
      readonly kind: "moving";
      readonly applied: number;
      readonly total: number;
    }
  | { readonly kind: "other" };

export function hostSettingsCardState(
  status: EnvironmentStatusResponse,
): HostSettingsCardState {
  const setup = status.setup;
  if (setup === null || setup.stage !== "moving_settings") {
    return { kind: "other" };
  }
  if (setup.state === "awaiting_consent") return { kind: "awaiting" };
  return {
    kind: "moving",
    applied: status.items.filter((item) => item.status === "applied").length,
    total: status.items.length + status.pendingUploads.length,
  };
}
