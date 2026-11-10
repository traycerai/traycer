import type {
  ConfigAgentMemoriesResponse,
  ConfigAgentMemoriesSetResponse,
} from "@traycer/protocol/host/config/schemas";
import type {
  EnvironmentPendingUpload,
  EnvironmentUploadReceipt,
} from "@traycer/protocol/host/environment-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  memoryRowNeedsWrite,
  type OnboardingMemoryRow,
} from "@/components/onboarding/onboarding-agent-memories-model";

// The memory act's save apart from React and the host client, so any order of
// answers, rebinds and retries can be run against it without a host.

/**
 * What the act knows about its Traycer memories write in ONE configuration.
 * A host can be rebound from one configuration to another without changing
 * its id, and an answer about one says nothing about the other.
 */
export type TraycerWriteEvidence =
  /**
   * This computer holds the edit to send (`queued`), so it is in force
   * nowhere yet, and it is never sent again while held. `environment.status`
   * names it by `uploadId` once the configuration takes it or turns it away;
   * a `null` id cannot be recognised there and stays held.
   */
  | { readonly kind: "held"; readonly uploadId: string | null }
  /**
   * The configuration holds it as `revision`, and it is never sent again. In
   * force on this host once a read of that configuration reaches the
   * revision; a `null` revision is one no read can confirm.
   */
  | { readonly kind: "written"; readonly revision: number | null }
  /** The configuration turned the held edit away: a later save may send another. */
  | { readonly kind: "refused" }
  /** The write failed with no answer: a later save may send it again. */
  | { readonly kind: "failed" };

/**
 * Everything the act knows about its Traycer memories write, by
 * `environmentId`, so leaving a configuration and coming back finds it again.
 */
export type SaveEvidence = ReadonlyMap<string, TraycerWriteEvidence>;
export const NO_SAVE_EVIDENCE: SaveEvidence = new Map();

/** Where Traycer memories stand in the configuration a read is about. */
export type TraycerStanding =
  /** On, and no write of the act's there is still to arrive. */
  | "on"
  /** Off, and the act has not written it there. */
  | "off"
  | "held"
  /** Written, and this host has not read it back yet. */
  | "unconfirmed"
  /** Written, and a later revision this host has read turned it off. */
  | "overturned"
  | "refused"
  | "failed";

/**
 * Traycer memories in the configuration `read` is about, given the act's
 * write there. A read confirms a write only once it reaches the write's
 * revision: a lower one is an earlier revision's answer.
 */
export function traycerStanding(
  read: ConfigAgentMemoriesResponse,
  entry: TraycerWriteEvidence | undefined,
): TraycerStanding {
  // An "on" read never answers a held edit: it may be an earlier revision
  // that a later, undelivered one overturns.
  if (entry?.kind === "held") return "held";
  if (entry?.kind === "written") {
    if (
      entry.revision === null ||
      read.revision === null ||
      read.revision < entry.revision
    )
      return "unconfirmed";
    return read.enabled ? "on" : "overturned";
  }
  if (read.enabled) return "on";
  return entry?.kind ?? "off";
}

/** The part of `environment.status` that answers for a held write. */
export interface UploadStatus {
  readonly acceptedUploads: ReadonlyArray<EnvironmentUploadReceipt>;
  readonly pendingUploads: ReadonlyArray<EnvironmentPendingUpload>;
}

/** The requests one save makes, all to the host it started on. */
export interface MemorySaveIo {
  /**
   * The act still shows the host the save started on. Checked before every
   * request: a save whose host has changed sends nothing more.
   */
  readonly current: () => boolean;
  /** `config.agentMemories.get`, read again; `null` when it fails. */
  readonly read: () => Promise<ConfigAgentMemoriesResponse | null>;
  /** `environment.status`; `null` when it fails. */
  readonly lookUp: () => Promise<UploadStatus | null>;
  /** `config.agentMemories.set` turning it on; `null` when it fails. */
  readonly set: () => Promise<ConfigAgentMemoriesSetResponse | null>;
  /** `providers.setNativeMemory` for one row; whether it landed. */
  readonly writeProvider: (row: OnboardingMemoryRow) => Promise<boolean>;
  /** The evidence as last recorded, for the save's host. */
  readonly evidence: () => SaveEvidence;
  readonly record: (next: SaveEvidence) => void;
}

/**
 * - `done`: every write landed, and the read just before said Traycer
 *   memories are on in the configuration the host serves.
 * - `short`: the save stopped with something unsaved.
 * - `unreached`: a read failed, or the host serves no configuration.
 * - `moved`: the act's host changed, and the save sent nothing more.
 */
export type MemorySaveResult = "done" | "short" | "unreached" | "moved";

/** What one save has done so far. */
export interface MemorySaveProgress {
  /**
   * The read the next request rests on: `null` before the first and again
   * after every other request, so no write and no "done" rests on a read
   * older than the save's last request.
   */
  readonly read: ConfigAgentMemoriesResponse | "failed" | null;
  /** Configurations whose held edit this save has looked up. */
  readonly lookedUp: ReadonlySet<string>;
  /** This save has sent its one Traycer memories write. */
  readonly sent: boolean;
  /** Providers this save has written, whether the write landed or not. */
  readonly written: ReadonlySet<ProviderId>;
  readonly providerFailed: boolean;
}

const MEMORY_SAVE_START: MemorySaveProgress = {
  read: null,
  lookedUp: new Set(),
  sent: false,
  written: new Set(),
  providerFailed: false,
};

export type MemorySaveStep =
  | { readonly kind: "read" }
  | {
      readonly kind: "look-up";
      readonly environmentId: string;
      readonly uploadId: string;
    }
  /** Write Traycer memories on, to the configuration the last read named. */
  | { readonly kind: "set"; readonly environmentId: string }
  | { readonly kind: "provider"; readonly row: OnboardingMemoryRow }
  | { readonly kind: "done" }
  | {
      readonly kind: "stop";
      readonly result: Exclude<MemorySaveResult, "done">;
    };

const SHORT: MemorySaveStep = { kind: "stop", result: "short" };

/**
 * The save's next request. Every provider write and "done" follows a read
 * that finds Traycer memories on in the configuration the host serves. A
 * configuration with this act's write held or written there is never sent
 * another; a save whose host changed sends nothing.
 */
export function nextMemorySaveStep(input: {
  readonly current: boolean;
  readonly progress: MemorySaveProgress;
  readonly evidence: SaveEvidence;
  /** The provider switches that differ from what the host held as the save began. */
  readonly rows: ReadonlyArray<OnboardingMemoryRow>;
}): MemorySaveStep {
  const { progress } = input;
  if (!input.current) return { kind: "stop", result: "moved" };
  const { read } = progress;
  if (read === null) return { kind: "read" };
  if (read === "failed" || read.environmentId === null)
    return { kind: "stop", result: "unreached" };
  const environmentId = read.environmentId;
  const entry = input.evidence.get(environmentId);
  if (entry?.kind === "held")
    return entry.uploadId !== null && !progress.lookedUp.has(environmentId)
      ? { kind: "look-up", environmentId, uploadId: entry.uploadId }
      : SHORT;
  const standing = traycerStanding(read, entry);
  if (standing === "on") {
    const row = input.rows.find(
      (each) => !progress.written.has(each.providerId),
    );
    if (row !== undefined) return { kind: "provider", row };
    // Done on this read alone. If the host is moved to another configuration,
    // or the setting is turned off, between the read and its answer arriving,
    // the act finishes with the providers off and Traycer memories off where
    // the host now is, and onboarding does not correct it: closing that
    // needs the host to check and write in one step. Settings → Agent
    // memories reads for itself when opened: the act keeps its reads in its
    // own cache entry.
    return progress.providerFailed ? SHORT : { kind: "done" };
  }
  if (standing === "off" || standing === "refused" || standing === "failed")
    return progress.sent ? SHORT : { kind: "set", environmentId };
  // Written and not read back, or overturned since: nothing this save could
  // send would change that.
  return SHORT;
}

/**
 * Writes what is still unsaved: Traycer first, and a provider only once a
 * read just before it finds Traycer memories on, so a failure can leave a
 * provider's memories on beside Traycer's. Both end up off only when the
 * host moves or the setting changes after the read a write or "done"
 * rested on (see `nextMemorySaveStep`).
 */
export function runMemorySave(
  io: MemorySaveIo,
  rows: ReadonlyArray<OnboardingMemoryRow>,
): Promise<MemorySaveResult> {
  return continueSave(io, rows.filter(memoryRowNeedsWrite), MEMORY_SAVE_START);
}

async function continueSave(
  io: MemorySaveIo,
  rows: ReadonlyArray<OnboardingMemoryRow>,
  progress: MemorySaveProgress,
): Promise<MemorySaveResult> {
  const step = nextMemorySaveStep({
    current: io.current(),
    progress,
    evidence: io.evidence(),
    rows,
  });
  if (step.kind === "done") return "done";
  if (step.kind === "stop") return step.result;
  return continueSave(io, rows, await takeStep(io, step, progress));
}

async function takeStep(
  io: MemorySaveIo,
  step: Exclude<MemorySaveStep, { kind: "done" } | { kind: "stop" }>,
  progress: MemorySaveProgress,
): Promise<MemorySaveProgress> {
  if (step.kind === "read")
    return { ...progress, read: (await io.read()) ?? "failed" };
  if (step.kind === "look-up") {
    const status = await io.lookUp();
    if (status !== null) {
      const found = lookedUpEvidence(step.uploadId, step.environmentId, status);
      if (found !== null) file(io, step.environmentId, found);
    }
    return {
      ...progress,
      read: null,
      lookedUp: new Set(progress.lookedUp).add(step.environmentId),
    };
  }
  if (step.kind === "set") {
    const answer = await io.set();
    if (answer === null) file(io, step.environmentId, { kind: "failed" });
    // Filed against the configuration the write was addressed to, which the
    // host names: it may have been rebound since the read.
    else
      file(
        io,
        answer.environmentId,
        answer.state === "queued"
          ? { kind: "held", uploadId: answer.uploadId }
          : { kind: "written", revision: answer.revision },
      );
    return { ...progress, read: null, sent: true };
  }
  const landed = await io.writeProvider(step.row);
  return {
    ...progress,
    read: null,
    written: new Set(progress.written).add(step.row.providerId),
    providerFailed: progress.providerFailed || !landed,
  };
}

function file(
  io: MemorySaveIo,
  environmentId: string,
  entry: TraycerWriteEvidence,
): void {
  io.record(new Map(io.evidence()).set(environmentId, entry));
}

/**
 * What `environment.status` says of a held edit: taken, with the revision
 * the configuration has reached at least, or turned away. `null` when it
 * names the edit neither way, which is no evidence of anything.
 */
function lookedUpEvidence(
  uploadId: string,
  environmentId: string,
  status: UploadStatus,
): TraycerWriteEvidence | null {
  const receipt = status.acceptedUploads.find(
    (entry) =>
      entry.uploadId === uploadId &&
      entry.environmentId === environmentId &&
      entry.kind === "agent_memory" &&
      entry.key === "memory",
  );
  if (receipt !== undefined)
    return { kind: "written", revision: receipt.revision };
  const refused = status.pendingUploads.some(
    (entry) => entry.uploadId === uploadId && entry.receipt === "refused",
  );
  return refused ? { kind: "refused" } : null;
}
