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

/**
 * How well a directory entry's host is answering right now.
 *
 * Three values, not two, because the shell has always known the difference and
 * used to throw it away. A host that is demonstrably ALIVE (pid metadata names
 * a live process whose kernel start identity matches) but whose endpoint probe
 * timed out is `busy`: the process is there, the renderer's own RPCs keep
 * completing, and the only true statement is "it did not answer THAT probe in
 * time". Collapsing that into `unavailable` is how a single timed-out loopback
 * probe locked every chat on a healthy machine read-only for two hours
 * (2026-08-11 staging incident) - the shell's own log line read "busy, holding
 * the snapshot" while the renderer was told the host was gone.
 *
 *   available   - the endpoint answered.
 *   busy        - the process is alive; a probe did not answer in time. Still
 *                 REACHABLE: dial it, keep the session, degrade the badge only.
 *   unavailable - no live host answers for this id. The only value that may
 *                 lock a chat to its published copy or route a tile to the
 *                 clone CTA.
 *
 * `busy` is deliberately not a third "maybe" bucket for consumers to reinvent:
 * every site that branched on `status === "available"` has to decide whether it
 * meant "answering right now" or "reachable at all", and the incident's lesson
 * is that nearly all of them meant the latter.
 */
export type HostAvailability = "available" | "busy" | "unavailable";

/**
 * The subset a host that EXISTS can report. Absence is carried by the entry
 * being missing (or by `unavailable`), never by a live snapshot - so every
 * shell-published local-host snapshot is one of these two.
 */
export type LiveHostAvailability = Exclude<HostAvailability, "unavailable">;

/**
 * Can this host be dialed / kept bound right now?
 *
 * The one predicate every transport, routing, and lock decision should use.
 * `busy` is reachable: the process is alive, its `websocketUrl` is unchanged,
 * and the renderer's own per-request dials keep completing - the only thing a
 * failed probe proved is that one probe went unanswered.
 *
 * Kept as a named function rather than each call site writing
 * `status !== "unavailable"` because the check used to be `=== "available"` in
 * a dozen places, and the whole point of adding a third value is that those
 * places must not silently keep meaning "answering this instant". Narrow to
 * `=== "available"` only where the answer feeds a BADGE.
 */
export function isHostReachable(status: HostAvailability): boolean {
  return status !== "unavailable";
}

export interface HostDirectoryEntry {
  readonly hostId: string;
  readonly label: string;
  readonly kind: HostKind;
  readonly websocketUrl: string | null;
  readonly version: string | null;
  readonly status: HostAvailability;
}
