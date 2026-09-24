import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readRegularFileNoFollow } from "@traycer-clients/shared/host-update";
import { renameWithWindowsRetry } from "@traycer/protocol/config/credentials-fs";
import {
  desktopPresencePath,
  parseDesktopPresenceText,
  serializeDesktopPresence,
  type DesktopPresence,
  type DesktopPresenceOnExit,
} from "@traycer/protocol/config/desktop-presence";
import {
  effectiveHostLifecycleMode,
  hostLifecyclePolicyPath,
  parseHostLifecyclePolicyText,
  serializeHostLifecyclePolicy,
  type HostLifecycleMode,
  type HostLifecyclePolicy,
} from "@traycer/protocol/config/host-lifecycle-policy";
import {
  parseSupervisorRecordText,
  SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
  supervisorRecordHasCapability,
  supervisorRecordPath,
} from "@traycer/protocol/config/supervisor-record";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { HostLifecycleSupervisorState } from "../../ipc-contracts/host-lifecycle-types";
import { log } from "../app/logger";
import { readPidMetadataState } from "./host-lifecycle";

// Desktop main's reads and writes of the host-lifecycle records in the host
// home: the lifecycle policy (co-written with `traycer host lifecycle set`),
// this desktop's presence record, and the supervisor record (read only).
//
// Nothing here caches a record. The CLI is a co-writer of the policy, so every
// decision re-reads the file it decides on (R12, "never hydrate once"); the
// only memoized value is this process's own start identity, which cannot
// change. Reads never throw: a torn, malformed or unreadable file reads as
// absent, which for the policy means Background - the mode every install had
// before this record existed.

/** One read of the policy file, as every decision in this module sees it. */
export interface HostLifecyclePolicyRead {
  /** The record, or `null` for an absent, unreadable or malformed file. */
  readonly policy: HostLifecyclePolicy | null;
  /** The mode in force: the record's, or Background without one. */
  readonly mode: HostLifecycleMode;
  /**
   * The record's `rev`. For a malformed file that still carries a readable
   * `rev` that value is kept, so a write over it is still newer than whatever
   * a reader stamped from it; otherwise `0`.
   */
  readonly rev: number;
}

/**
 * - `written` - the record names this process with `onExit`.
 * - `identity-unavailable` - this process's start identity could not be read,
 *   so no record was written: a presence without one is malformed by
 *   contract, and the supervisor would read it as absent anyway.
 */
export type DesktopPresenceWriteOutcome = "written" | "identity-unavailable";

export interface HostLifecyclePolicyStoreOptions {
  /** The host runtime home (`HostFsLayout.rootDir`). */
  readonly hostHomeDir: string;
  /** The host's `pid.json`, read to tell an old supervisor from no host. */
  readonly pidMetadataFile: string;
  readonly ownPid: number;
  /** This process's start identity, or `null` when the probe failed. */
  readonly readOwnStartIdentity: () => Promise<ProcessStartIdentity | null>;
  readonly now: () => Date;
}

const salvagedRevSchema = z.object({ rev: z.number().int().nonnegative() });

export class HostLifecyclePolicyStore {
  readonly policyPath: string;
  readonly presencePath: string;
  readonly supervisorPath: string;
  private readonly pidMetadataFile: string;
  private readonly ownPid: number;
  private readonly readOwnStartIdentity: () => Promise<ProcessStartIdentity | null>;
  private readonly now: () => Date;

  constructor(options: HostLifecyclePolicyStoreOptions) {
    this.policyPath = hostLifecyclePolicyPath(options.hostHomeDir);
    this.presencePath = desktopPresencePath(options.hostHomeDir);
    this.supervisorPath = supervisorRecordPath(options.hostHomeDir);
    this.pidMetadataFile = options.pidMetadataFile;
    this.ownPid = options.ownPid;
    this.readOwnStartIdentity = options.readOwnStartIdentity;
    this.now = options.now;
  }

  async readPolicy(): Promise<HostLifecyclePolicyRead> {
    const text = await readTextOrNull(this.policyPath);
    if (text === null) {
      return { policy: null, mode: effectiveHostLifecycleMode(null), rev: 0 };
    }
    const policy = parseHostLifecyclePolicyText(text);
    return {
      policy,
      mode: effectiveHostLifecycleMode(policy),
      rev: policy === null ? salvageRev(text) : policy.rev,
    };
  }

  /**
   * Write `mode` with `updatedBy: "desktop"`, one `rev` past whatever is on
   * disk at the moment of writing, atomically (temp file + rename, so a
   * reader sees the old record or the new one and never a torn one).
   *
   * Not serialized against a concurrent CLI write, for the reason
   * `writeHostLifecyclePolicyFromCli` gives: both writers are a person
   * changing a setting, the file is replaced whole, and the loser of such a
   * race is simply the older choice, which `rev` lets every reader recognise.
   * Throws when the write fails; the caller reports it and commits nothing
   * else.
   */
  async writePolicy(mode: HostLifecycleMode): Promise<HostLifecyclePolicy> {
    const previous = await this.readPolicy();
    const policy: HostLifecyclePolicy = {
      v: 1,
      rev: previous.rev + 1,
      mode,
      updatedAt: this.now().toISOString(),
      updatedBy: "desktop",
    };
    await writeTextAtomically(
      this.policyPath,
      serializeHostLifecyclePolicy(policy),
    );
    log.info("[host-lifecycle] policy written", {
      mode: policy.mode,
      rev: policy.rev,
    });
    return policy;
  }

  /**
   * Whether the running supervisor enforces the policy. `supervisor.json`
   * exists only while a capable supervisor runs; without it, a host that is
   * nonetheless running (`pid.json` present) is under an older supervisor.
   */
  async readSupervisorState(): Promise<HostLifecycleSupervisorState> {
    const text = await readTextOrNull(this.supervisorPath);
    const record = text === null ? null : parseSupervisorRecordText(text);
    if (
      supervisorRecordHasCapability(
        record,
        SUPERVISOR_CAPABILITY_LIFECYCLE_POLICY_V1,
      )
    ) {
      return "enforcing";
    }
    const pid = await readPidMetadataState(this.pidMetadataFile);
    return pid.kind === "absent" ? "not-running" : "not-enforcing";
  }

  async readPresence(): Promise<DesktopPresence | null> {
    const text = await readTextOrNull(this.presencePath);
    return text === null ? null : parseDesktopPresenceText(text);
  }

  /**
   * Publish this process's presence with `onExit`, stamped with the policy
   * `rev` the verdict was derived from. A new desktop always overwrites
   * whatever record is there, so a record a crashed instance left behind is
   * replaced rather than reasoned about.
   */
  async writePresence(
    onExit: DesktopPresenceOnExit,
    policyRev: number,
  ): Promise<DesktopPresenceWriteOutcome> {
    const identity = await this.readOwnStartIdentity();
    if (identity === null) {
      log.warn("[host-lifecycle] presence not written", {
        reason: "identity-unavailable",
        onExit,
        rev: policyRev,
      });
      return "identity-unavailable";
    }
    const presence: DesktopPresence = {
      v: 1,
      pid: this.ownPid,
      processStartIdentity: identity,
      onExit,
      policyRev,
      writtenAt: this.now().toISOString(),
    };
    await writeTextAtomically(
      this.presencePath,
      serializeDesktopPresence(presence),
    );
    log.info("[host-lifecycle] presence written", { onExit, rev: policyRev });
    return "written";
  }

  /**
   * Remove the presence record, only while it still names THIS process.
   * A record another desktop instance wrote is its own and is left alone.
   *
   * The one-winner claim `removeSupervisorRecords` uses: rename to a private
   * name, check the owner, and put back a record that is not ours only while
   * the canonical name is still vacant, so a record written in between is
   * never overwritten. Best-effort: a failure leaves our record, which the
   * supervisor reads by pid + identity once this process is gone.
   */
  async removeOwnPresence(): Promise<void> {
    const identity = await this.readOwnStartIdentity();
    const claimed = `${this.presencePath}.${this.ownPid}.${randomUUID()}.release`;
    try {
      await rename(this.presencePath, claimed);
    } catch {
      return;
    }
    const text = await readTextOrNull(claimed);
    const presence = text === null ? null : parseDesktopPresenceText(text);
    if (
      presence !== null &&
      presence.pid === this.ownPid &&
      identity !== null &&
      presence.processStartIdentity === identity
    ) {
      await rm(claimed, { force: true }).catch(() => undefined);
      log.info("[host-lifecycle] presence removed", {
        rev: presence.policyRev,
      });
      return;
    }
    try {
      await link(claimed, this.presencePath);
    } catch {
      // The canonical name was taken in between: that newer record wins.
    }
    await rm(claimed, { force: true }).catch(() => undefined);
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    const read = await readRegularFileNoFollow(path);
    return read.kind === "text" ? read.text : null;
  } catch {
    return null;
  }
}

function salvageRev(text: string): number {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 0;
  }
  const salvaged = salvagedRevSchema.safeParse(value);
  return salvaged.success ? salvaged.data.rev : 0;
}

async function writeTextAtomically(
  destination: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    // Retried on win32: a watcher re-reading this file on its last change
    // holds a handle on it for the length of that read, and `MoveFileExW`
    // will not replace a file with an open handle. Without the retry, that
    // collision fails the write, and a policy or presence change is lost.
    await renameWithWindowsRetry(temporary, destination, 0);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
