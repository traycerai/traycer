// The one authored reason on `host available`'s legacy wire contract that
// a client may act on: "this asset is unavailable because the CLI executing
// on the host is below the release's floor", which upgrading that CLI can
// repair. The CLI authors it (`commands/host-available.ts`), the GUI's
// Overview recognises it (`host-overview-updates-state.ts`) and renders the
// remedy. Both endpoints are OSS clients, which is why this lives in
// `clients/shared`: no host code authors `unavailableReason` today. The day
// one does, this prefix is wire contract and belongs in `@traycer/protocol`.

import type { HostAvailableManifest } from "@traycer/protocol/host/maintenance/schemas";

/**
 * The released CLI's projected refusal is the executing CLI's verdict. A
 * stored version can be newer after a best-effort copy into the host's tools
 * failed, and a withdrawn platform build can retain its hash. Neither is a
 * substitute for this authored reason on the legacy wire contract. An
 * UNREADABLE floor (registry text that is not a version) is deliberately
 * authored WITHOUT this prefix (`registry/client-floor.ts`): no upgrade
 * repairs it, and a reader keyed on the prefix would otherwise keep asking
 * for one.
 */
export const HOST_CLIENT_FLOOR_REASON_PREFIX = "Needs Traycer CLI ";

/** The wire asset's availability fields - what the predicate reads. */
export type HostClientFloorAsset = Pick<
  HostAvailableManifest["versions"][number]["platforms"][string],
  "available" | "unavailableReason"
>;

export function isHostClientFloorRefusedAsset(
  asset: HostClientFloorAsset | null,
): boolean {
  return (
    asset !== null &&
    !asset.available &&
    asset.unavailableReason?.startsWith(HOST_CLIENT_FLOOR_REASON_PREFIX) ===
      true
  );
}
