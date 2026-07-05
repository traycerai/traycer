import type { HostListItem } from "../host-status";

/**
 * Single source of truth for the `GET /api/v3/hosts` contract shape (S5 / fix
 * #5, mechanism 2). This file is the ONLY copy — a hand-synced duplicate
 * would reintroduce the exact drift this fixture exists to catch.
 *
 * Consumers, both reading this same physical file:
 *  - `traycer/protocol/src/host/__tests__/host-status.test.ts` (this
 *    package): imports it by relative path.
 *  - `authn-v3/src/utils/hosts/__tests__/host-status-dto.test.ts` (the outer
 *    repo, across the submodule boundary): imports it via the package
 *    specifier `@traycer/protocol/host/__fixtures__/host-status-golden-fixture`,
 *    which authn-v3's `tsconfig.json` (`paths["@traycer/protocol/*"]`) and the
 *    workspace's hoisted `node_modules/@traycer/protocol` symlink both resolve
 *    straight back to this file under `traycer/protocol/src/...` — no build
 *    step, no copy.
 *
 * authn-v3's test asserts its real serializer output (`toHostListItem`) is a
 * superset of these keys (the server must never DROP a promised field); this
 * package's test asserts `hostListItemSchema` parses it and rejects an
 * unexpected extra field (the client must never SILENTLY STRIP an added one).
 */
export const HOST_LIST_ITEM_GOLDEN_FIXTURE: HostListItem = {
  hostId: "golden-host-id",
  displayName: "Golden Host",
  platform: "darwin",
  kind: "personal",
  publicKey: "golden-public-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: {
    presenceLease: "fresh",
    hostRelayAttached: true,
    viewerReachability: "unknown",
    clientCloud: "ok",
    busy: false,
    busySessionCount: 0,
    updateState: "current",
    appVersion: "1.2.3",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  },
  updatePolicy: "manual",
};
