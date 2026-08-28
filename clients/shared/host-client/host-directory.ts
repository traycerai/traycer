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
 * How well the SHELL's own probe says a local host is answering right now.
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
 *
 * This is the SHELL's vocabulary — what the desktop lifecycle folds
 * (`foldHostAvailability` / `needsReprobe`) and what a local-host snapshot
 * publishes over IPC. It is NOT what a directory entry carries: an entry's
 * coarse field is {@link HostTransportDialability}, projected from this through
 * {@link isHostReachable}, so `busy` reaches the renderer as `dialable` and can
 * never be read as death.
 */
export type HostAvailability = "available" | "busy" | "unavailable";

/**
 * The subset a host that EXISTS can report. Absence is carried by the entry
 * being missing (or by `unavailable`), never by a live snapshot - so every
 * shell-published local-host snapshot is one of these two.
 */
export type LiveHostAvailability = Exclude<HostAvailability, "unavailable">;

/**
 * Does this shell-published availability mean the host can be dialed?
 *
 * `busy` is reachable: the process is alive, its `websocketUrl` is unchanged,
 * and the renderer's own per-request dials keep completing - the only thing a
 * failed probe proved is that one probe went unanswered.
 *
 * Kept as a named function rather than each call site writing
 * `status !== "unavailable"` because the check used to be `=== "available"` in
 * a dozen places, and the whole point of adding a third value is that those
 * places must not silently keep meaning "answering this instant".
 *
 * There is now exactly ONE such call site: the directory service's projection
 * of a local snapshot into a {@link HostDirectoryEntry}'s
 * {@link HostTransportDialability}. Renderer surfaces no longer see this type
 * at all — they read the projected field, or the REASON
 * ({@link hostUnavailability} in `remote-fetcher.ts`). That is deliberate: the
 * old fan-out of raw availability reads is what the rename below removed.
 */
export function isHostReachable(status: HostAvailability): boolean {
  return status !== "unavailable";
}

/**
 * Can the transport dial this entry right now — and NOTHING else.
 *
 * Deliberately renamed from `status: "available" | "unavailable"`, and the
 * rename is the point. That field was read by a dozen surfaces as if it meant
 * "is this host alive", which it never did: three different situations collapse
 * into not-dialable, and only one of them is the host being off. Rendering the
 * other two as "offline" put dead-tile banners over live sessions and re-homed
 * people off working machines.
 *
 * The old name invited that reading and the old grep-and-fix rounds kept
 * missing sites — six found, then four more. So the field is renamed rather
 * than re-documented: every read is now a compile error until someone decides,
 * at that site, whether a pure yes/no is genuinely what it wants (dialing,
 * endpoint construction) or whether it needs the REASON
 * ({@link hostUnavailability} in `remote-fetcher.ts`, or `useHostReachability`
 * for anything user-facing).
 *
 * If you are about to read this to decide what to SHOW someone, you want the
 * reason, not this.
 */
export type HostTransportDialability = "dialable" | "not-dialable";

export interface HostDirectoryEntry {
  readonly hostId: string;
  readonly label: string;
  readonly kind: HostKind;
  readonly websocketUrl: string | null;
  readonly version: string | null;
  readonly transportDialability: HostTransportDialability;
}
