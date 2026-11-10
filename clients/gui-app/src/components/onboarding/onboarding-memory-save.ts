import type {
  ConfigAgentMemoriesResponse,
  ConfigAgentMemoriesSetResponse,
} from "@traycer/protocol/host/config/schemas";
import type {
  EnvironmentPendingUpload,
  EnvironmentUploadReceipt,
} from "@traycer/protocol/host/environment-schemas";
import {
  memoryRowNeedsWrite,
  type OnboardingMemoryRow,
  type TraycerMemoryOutcome,
} from "@/components/onboarding/onboarding-agent-memories-model";

// The memory act's save apart from React and the host client, so any order of
// answers, rebinds and retries can be run against it without a host.

/** What a save knows about its Traycer memories write, kept between saves. */
export type SaveEvidence = TraycerMemoryOutcome | null;
export const NO_SAVE_EVIDENCE: SaveEvidence = null;

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
  readonly evidence: () => SaveEvidence;
  readonly record: (next: SaveEvidence) => void;
}

export type MemorySaveResult = "done" | "short";

/**
 * Writes what is still unsaved: Traycer first, and the providers only once it
 * is saved, so a failure can leave a provider's memories on beside Traycer's,
 * never both off.
 */
export async function runMemorySave(
  io: MemorySaveIo,
  rows: ReadonlyArray<OnboardingMemoryRow>,
): Promise<MemorySaveResult> {
  if (!(await ensureTraycer(io))) return "short";
  const results = await Promise.all(
    rows
      .filter(memoryRowNeedsWrite)
      .map((row) =>
        io.current() ? io.writeProvider(row) : Promise.resolve(false),
      ),
  );
  // Done only while the act still shows the host it was for: a save that
  // finished after the picker moved does not move the tour on.
  return results.every(Boolean) && io.current() ? "done" : "short";
}

async function ensureTraycer(io: MemorySaveIo): Promise<boolean> {
  const outcome = io.evidence();
  if (outcome?.kind === "saved") return true;
  if (!io.current()) return false;
  const read = await io.read();
  if (outcome?.kind === "queued") {
    // A held edit is answered by `environment.status` alone, and only while
    // this host still serves the configuration it was made in. A read that
    // says on cannot answer it: it may be an earlier revision that a later,
    // undelivered one overturns. Nor can a receipt once the host has been
    // rebound: the edit landing in the old configuration leaves this one
    // as it was, so its providers must not be turned off on the strength
    // of it.
    if (read === null) return false;
    if (read.environmentId === outcome.environmentId) {
      const held = await heldEditOutcome(io, outcome);
      io.record(held);
      return held.kind === "saved";
    }
    // Rebound: the held edit is the old configuration's business, and the
    // one this host serves now starts over below.
  }
  // Read before writing: a configuration that has it on already needs no
  // write.
  if (read?.enabled === true) {
    io.record({ kind: "saved" });
    return true;
  }
  if (!io.current()) return false;
  const answer = await io.set();
  if (answer === null) {
    io.record({ kind: "failed", refused: false });
    return false;
  }
  const next: TraycerMemoryOutcome =
    answer.state === "queued"
      ? {
          kind: "queued",
          uploadId: answer.uploadId,
          environmentId: answer.environmentId,
        }
      : { kind: "saved" };
  io.record(next);
  return next.kind === "saved";
}

/**
 * A held edit is never sent twice. `environment.status` names it once the
 * configuration took it (saved) or turned it away (failed, so the next
 * retry may send a fresh one); no word either way leaves it held.
 */
async function heldEditOutcome(
  io: MemorySaveIo,
  held: Extract<TraycerMemoryOutcome, { kind: "queued" }>,
): Promise<TraycerMemoryOutcome> {
  if (held.uploadId === null || !io.current()) return held;
  const status = await io.lookUp();
  if (status === null) return held;
  const accepted = status.acceptedUploads.some(
    (entry) =>
      entry.uploadId === held.uploadId &&
      entry.environmentId === held.environmentId &&
      entry.kind === "agent_memory" &&
      entry.key === "memory",
  );
  if (accepted) return { kind: "saved" };
  const refused = status.pendingUploads.some(
    (entry) => entry.uploadId === held.uploadId && entry.receipt === "refused",
  );
  return refused ? { kind: "failed", refused: true } : held;
}
