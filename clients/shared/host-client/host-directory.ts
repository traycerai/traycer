
export type HostKind = "local" | "remote" | "mock";

export type HostAvailability = "available" | "busy" | "unavailable";

/**
 * The subset a host that exists can report.
 * Absence is carried by the entry being missing (or by `unavailable`), never by a live snapshot - so every shell-published local-host snapshot is one of these two.
 */
export type LiveHostAvailability = Exclude<HostAvailability, "unavailable">;

/**
 * Does this shell-published availability mean the host can be dialed?
 * `busy` is reachable: the process is alive, its `websocketUrl` is unchanged, and the renderer's own per-request dials keep completing - the only thing a failed probe proved is that one probe went unanswered.
 */
export function isHostReachable(status: HostAvailability): boolean {
  return status !== "unavailable";
}

/**
 * Can the transport dial this entry right now - and nothing else.
 * That field was read by a dozen surfaces as if it meant "is this host alive", which it never did: three different situations collapse into not-dialable, and only one of them is the host being off.
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
