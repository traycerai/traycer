import type {
  EnvironmentHostItemApply,
  EnvironmentHostRecordV12,
} from "@traycer/protocol/host/environment/contracts";
import {
  hostNameFromLabel,
  UNNAMED_HOST_LABEL,
} from "@/hooks/agent/use-host-reachability";

/**
 * One host running a configuration. Membership is the configuration's own
 * host list (the cloud's binding records), never presence.
 */
export interface RunningHost {
  readonly hostId: string;
  /** The host's own name, as it reported it. */
  readonly hostName: string;
  /**
   * The name to print: `hostName`, with ` (this computer)` on the window's
   * own computer while another host shares its name.
   */
  readonly name: string;
  readonly kind: "personal" | "sandbox";
  /** The computer this app runs on. */
  readonly isThisComputer: boolean;
  /** When the host last reported to the cloud; `null` before it ever did. */
  readonly lastReportedAt: number | null;
  /** The host's last reported apply state per item, from the cloud. */
  readonly applied: readonly EnvironmentHostItemApply[];
}

/** A name two or more running hosts share. */
export interface HostNameCollision {
  readonly hostName: string;
  readonly hostIds: readonly string[];
}

export interface HostsRunningConfiguration {
  readonly hosts: readonly RunningHost[];
  /**
   * `loading` before the list has ever answered; `failed` when it could not
   * be read and nothing earlier is known; `ready` once it answered, kept on
   * its last answer while a later read fails.
   */
  readonly state: "loading" | "ready" | "failed";
  readonly collisions: readonly HostNameCollision[];
  readonly retry: () => void;
  /** Refreshes without cancelling an answer already on its way. */
  readonly reread: () => void;
}

/** A host this window can see firsthand: the account's or the directory's row. */
export interface FirsthandHost {
  readonly hostId: string;
  readonly name: string;
  readonly isLocalMachine: boolean;
  readonly sandbox: boolean;
}

const THIS_COMPUTER_SUFFIX = " (this computer)";

/**
 * The hosts running a configuration:
 *
 * - every row of the configuration's host list, except, for Personal
 *   (`personal`), one with a Local row: its own settings are not in Personal
 *   yet, so it does not run Personal. That is known from the computer's own
 *   status (`localHostIds`), from the list (`hasLocalRow`, what the host last
 *   reported), or from a computer that has never reported to Personal: a
 *   computer reports only once its settings have moved. A Team's computer
 *   that has not reported yet is still applying it;
 * - plus every computer this window reads that runs Personal by its own
 *   status (`runningByStatus`) and the list does not name, which is what
 *   an older host's list leaves out, and a computer that moved moments ago;
 * - never a computer in `unreadHostIds` (this computer before its own status
 *   has answered): nothing is claimed about it until then.
 *
 * Names come from the list, else from the window's own row. A name two
 * hosts share marks this computer's copy ` (this computer)`.
 */
export function hostsRunningConfiguration(input: {
  readonly rows: readonly EnvironmentHostRecordV12[];
  /** The configuration is Personal. */
  readonly personal: boolean;
  readonly localHostIds: ReadonlySet<string>;
  readonly unreadHostIds: ReadonlySet<string>;
  readonly runningByStatus: readonly FirsthandHost[];
  readonly firsthand: readonly FirsthandHost[];
}): {
  readonly hosts: readonly RunningHost[];
  readonly collisions: readonly HostNameCollision[];
} {
  const firsthandById = new Map(
    input.firsthand.map((host) => [host.hostId, host]),
  );
  const unclaimed = (hostId: string): boolean =>
    input.localHostIds.has(hostId) || input.unreadHostIds.has(hostId);
  const keepsLocalRow = (row: EnvironmentHostRecordV12): boolean =>
    input.personal &&
    (row.hasLocalRow === true ||
      (row.kind === "personal" && row.lastReportedAt === null));
  const listed: Omit<RunningHost, "name">[] = input.rows
    .filter((row) => !unclaimed(row.hostId) && !keepsLocalRow(row))
    .map((row) => {
      const seen = firsthandById.get(row.hostId) ?? null;
      const reported = hostNameFromLabel(row.hostLabel, row.hostId);
      return {
        hostId: row.hostId,
        hostName:
          reported === UNNAMED_HOST_LABEL
            ? hostNameFromLabel(seen?.name ?? null, row.hostId)
            : reported,
        kind: row.kind,
        isThisComputer: seen?.isLocalMachine === true,
        lastReportedAt: row.lastReportedAt,
        applied: row.applied,
      };
    });
  const listedIds = new Set(listed.map((host) => host.hostId));
  const unlisted: Omit<RunningHost, "name">[] = input.runningByStatus
    .filter((host) => !listedIds.has(host.hostId) && !unclaimed(host.hostId))
    .map((host) => ({
      hostId: host.hostId,
      hostName: host.name,
      kind: host.sandbox ? "sandbox" : "personal",
      isThisComputer: host.isLocalMachine,
      lastReportedAt: null,
      applied: [],
    }));
  const all = [...listed, ...unlisted];
  const collisions = nameCollisions(all);
  const colliding = new Set(collisions.map((entry) => entry.hostName));
  return {
    hosts: all.map((host) => ({
      ...host,
      name:
        host.isThisComputer && colliding.has(host.hostName)
          ? `${host.hostName}${THIS_COMPUTER_SUFFIX}`
          : host.hostName,
    })),
    collisions,
  };
}

function nameCollisions(
  hosts: readonly Pick<RunningHost, "hostId" | "hostName">[],
): HostNameCollision[] {
  const byName = new Map<string, string[]>();
  for (const host of hosts) {
    const ids = byName.get(host.hostName) ?? [];
    ids.push(host.hostId);
    byName.set(host.hostName, ids);
  }
  return [...byName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([hostName, hostIds]) => ({ hostName, hostIds }));
}

const COUNT_WORDS = [
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];

/** `Two computers are named windows-test-machine`. */
export function collisionLine(collision: HostNameCollision): string {
  const count = collision.hostIds.length;
  const word = COUNT_WORDS[count - 2] ?? String(count);
  return `${word} computers are named ${collision.hostName}`;
}
