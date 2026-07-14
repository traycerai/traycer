import { classifyHostRequestFailure } from "@traycer-clients/shared/host-transport/host-messenger";

export type LandingTerminalAvailability =
  "supported" | "unsupported" | "unknown" | "no-active-host";

export function resolveLandingTerminalAvailability(
  activeHostId: string | null,
  data: { readonly sessions: ReadonlyArray<unknown> } | undefined,
  error: unknown,
): LandingTerminalAvailability {
  if (activeHostId === null) return "no-active-host";
  if (classifyHostRequestFailure(error).kind === "downgrade-unsupported") {
    return "unsupported";
  }
  return data === undefined ? "unknown" : "supported";
}
