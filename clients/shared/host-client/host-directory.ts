/**
 * Shared host-directory types consumed by `gui-app`.
 *
 * The directory drives picker UI and endpoint binding. Connection details are
 * inline so per-request WebSocket dials can target the selected host
 * directly.
 *
 * `HostDirectoryEntry` is intentionally a plain data shape - building the
 * directory itself (e.g. from the runner host's `onLocalHostChange`
 * snapshots plus the stubbed remote fetcher in `remote-fetcher.ts`) belongs
 * in `gui-app/HostDirectoryService`, not in shared.
 *
 * Local vs remote kinds
 *   `kind: "local"` is a 127.0.0.1 host reached directly; `kind: "remote"`
 *   is a host reached through a future relay / tunnel (D3, non-MVP-gating).
 *   Both kinds speak the same shared versioned RPC contract over their
 *   `websocketUrl` - no separate wire protocol is introduced for remote. See
 *   `remote-path.ts` for the committed invariants.
 */

export type HostKind = "local" | "remote" | "mock";

export type HostAvailability = "available" | "unavailable";

export interface HostDirectoryEntry {
  readonly hostId: string;
  readonly label: string;
  readonly kind: HostKind;
  readonly websocketUrl: string | null;
  readonly version: string | null;
  readonly status: HostAvailability;
}
