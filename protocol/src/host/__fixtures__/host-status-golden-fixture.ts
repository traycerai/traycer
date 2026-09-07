import type { HostListItem } from "../host-status";

/** Single source of truth for the `GET /api/v3/hosts` contract shape (S5 / fix */
export const HOST_LIST_ITEM_GOLDEN_FIXTURE: HostListItem = {
  hostId: "golden-host-id",
  displayName: "Golden Host",
  platform: "darwin",
  kind: "personal",
  publicKey: "golden-public-key",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: {
    connectivity: "connectable",
    viewerReachability: "unknown",
    clientCloud: "ok",
    updateState: "current",
    appVersion: "1.2.3",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  },
  updatePolicy: "manual",
};
