/**
 * The app's side of a save made in a host's settings: it remembers what the
 * save will propose, and applies authn's hold of it once the host has
 * proposed it. No host commits a setting; the app that made the edit applies
 * its own hold (`settings-proposals.ts` in the protocol).
 *
 * Nothing here logs, reports or throws what it remembers: no value, no
 * digest, no item key, no environment or host id. A failure is a record kept
 * for the next try or a record forgotten, never an error a person reads.
 */
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  applyHeldChange,
  readHeldChangesForMatch,
  settingValueDigest,
  type HeldChangeForMatch,
} from "@traycer-clients/shared/environment/environment-review";
import type {
  EnvironmentProposalsResponse,
  SettingsProposalReceipt,
  SettingsSaveAnswer,
} from "@traycer/protocol/host/environment/settings-proposals";
import type { SettingsSaveMapping } from "@traycer/protocol/host/environment/settings-save-mapping";
import {
  SETTINGS_SAVE_MEMORY_TTL_MS,
  settingsSaveMemoryRecord,
  useSettingsSaveMemoryStore,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";

/** An apply that went unanswered is tried once more at the same hold revision. */
const TRIES_PER_HOLD_REVISION = 2;

/**
 * How long a save the host does not list is kept. Another window may still
 * have it out: that window's answer comes within this time and reconciles it
 * there.
 */
const UNLISTED_GRACE_MS = 60_000;

/** Where a save is made, and what the person saw when they made it. */
export interface SettingsSaveContext {
  readonly environmentId: string;
  readonly hostId: string;
  /** The host's sharing generation when the save is made. */
  readonly sharingGeneration: number;
  /** The live item's revision read from authn when the person made the edit; null when there is none. */
  readonly expectedLiveRevision: number | null;
}

/** What the coordinator reaches outside itself. */
export interface SettingsSaveCoordinatorPorts {
  /** The signed-in account; null when nobody is. A change mid-run stops the run. */
  readonly accountId: () => string | null;
  /** One authn operation on the current sign-in; null with no session service. */
  readonly cloud: () => EnvironmentCloud | null;
  /**
   * `environment.proposals` on `hostId`, over a connection this window
   * already holds open for its own reasons, or null when it holds none. It
   * never opens or dials one: a remote host only through a borrowed ready
   * session (`tryAcquireReadyRemoteSession`), this machine's host through its
   * own requester.
   */
  readonly readProposals: (
    hostId: string,
  ) => Promise<EnvironmentProposalsResponse | null>;
  readonly now: () => number;
}

export interface SettingsSaveCoordinator {
  /**
   * Called before the save is sent: remembers a save that maps to a proposal
   * and marks it sent. Answers the ticket {@link settle} takes, or null when
   * the save proposes nothing to remember.
   */
  readonly begin: (
    mapping: SettingsSaveMapping,
    context: SettingsSaveContext,
  ) => Promise<string | null>;
  /**
   * The save's answer, or null when it failed or nothing answered. A save
   * that proposes nothing, is refused, or answers for another generation or
   * item is forgotten; otherwise its host is reconciled.
   */
  readonly settle: (
    ticket: string,
    answer: SettingsSaveAnswer | null,
  ) => Promise<void>;
  /**
   * Applies what `hostId` has proposed of this account's remembered saves.
   * Runs one at a time per host; a call while one runs waits for it.
   */
  readonly reconcile: (hostId: string) => Promise<void>;
}

function receiptMatches(
  record: SettingsSaveMemoryRecord,
  receipt: SettingsProposalReceipt,
): boolean {
  return (
    receipt.environmentId === record.environmentId &&
    receipt.hostId === record.hostId &&
    receipt.sharingGeneration === record.sharingGeneration &&
    receipt.kind === record.kind &&
    receipt.key === record.key &&
    receipt.os === record.os &&
    receipt.operation === record.operation
  );
}

function holdMatches(
  record: SettingsSaveMemoryRecord,
  hold: HeldChangeForMatch,
): boolean {
  return (
    hold.hostId === record.hostId &&
    hold.sharingGeneration === record.sharingGeneration &&
    hold.kind === record.kind &&
    hold.key === record.key &&
    hold.os === record.os &&
    hold.op === record.operation &&
    hold.valueDigest === record.valueDigest
  );
}

/** Whether this window has sent `id`'s save and not yet seen it answered. */
function inFlight(id: string): boolean {
  return Object.hasOwn(useSettingsSaveMemoryStore.getState().inFlight, id);
}

interface RememberedSave {
  readonly id: string;
  readonly record: SettingsSaveMemoryRecord;
}

/**
 * The host's own records sorted by what its proposals list says of each:
 * those to forget (refused, or not listed while no save of theirs is out in
 * this window and older than {@link UNLISTED_GRACE_MS}), and those authn
 * holds, by environment. A queued one is in neither.
 */
function sortByReceipt(
  mine: ReadonlyArray<readonly [string, SettingsSaveMemoryRecord]>,
  proposals: EnvironmentProposalsResponse,
  now: number,
): {
  readonly forget: readonly string[];
  readonly proposed: ReadonlyMap<string, readonly RememberedSave[]>;
} {
  const forget: string[] = [];
  const proposed = new Map<string, RememberedSave[]>();
  for (const [id, record] of mine) {
    const receipt = proposals.proposals.find((row) =>
      receiptMatches(record, row.proposal),
    )?.proposal;
    if (receipt === undefined) {
      // A save still out, here or in another window, may not have reached
      // the host's list yet.
      if (!inFlight(id) && now - record.writtenAt > UNLISTED_GRACE_MS) {
        forget.push(id);
      }
    } else if (receipt.state === "refused") {
      forget.push(id);
    } else if (receipt.state === "proposed") {
      const list = proposed.get(record.environmentId) ?? [];
      list.push({ id, record });
      proposed.set(record.environmentId, list);
    }
  }
  return { forget, proposed };
}

export function createSettingsSaveCoordinator(
  ports: SettingsSaveCoordinatorPorts,
): SettingsSaveCoordinator {
  const running = new Map<string, Promise<void>>();
  const store = () => useSettingsSaveMemoryStore.getState();

  const forgetExpired = (): void => {
    const now = ports.now();
    for (const [id, record] of Object.entries(store().records)) {
      if (now - record.writtenAt > SETTINGS_SAVE_MEMORY_TTL_MS) {
        store().forget(id);
      }
    }
  };

  /** Applies `record`'s hold, if authn holds it; answers whether the record stays. */
  const applyHold = async (
    cloud: EnvironmentCloud,
    id: string,
    record: SettingsSaveMemoryRecord,
    holds: readonly HeldChangeForMatch[],
  ): Promise<boolean> => {
    const hold = holds.find((candidate) => holdMatches(record, candidate));
    // Proposed and not held: applied by another window, or decided.
    if (hold === undefined) return false;
    if (
      record.unanswered?.revision === hold.revision &&
      record.unanswered.tries >= TRIES_PER_HOLD_REVISION
    ) {
      return true;
    }
    try {
      await applyHeldChange(cloud, record.environmentId, {
        heldId: hold.heldId,
        revision: hold.revision,
        expectedLiveRevision: record.expectedLiveRevision,
      });
      // Applied, a conflict, gone or forbidden: either way this hold is
      // decided for this save.
      return false;
    } catch {
      store().noteUnanswered(id, hold.revision);
      return true;
    }
  };

  const reconcileOnce = async (hostId: string): Promise<void> => {
    const account = ports.accountId();
    if (account === null) return;
    const sameAccount = (): boolean => ports.accountId() === account;
    forgetExpired();
    const mine = Object.entries(store().records).filter(
      ([, record]) => record.hostId === hostId,
    );
    if (mine.length === 0) return;

    let proposals: EnvironmentProposalsResponse | null;
    try {
      proposals = await ports.readProposals(hostId);
    } catch {
      proposals = null;
    }
    // Not connected, or nothing answered: every record waits for the next
    // connection.
    if (proposals === null || !sameAccount()) return;

    const sorted = sortByReceipt(mine, proposals, ports.now());
    for (const id of sorted.forget) store().forget(id);
    if (sorted.proposed.size === 0) return;

    const cloud = ports.cloud();
    if (cloud === null) return;
    for (const [environmentId, saves] of sorted.proposed) {
      let holds: readonly HeldChangeForMatch[];
      try {
        holds = await readHeldChangesForMatch(cloud, environmentId);
      } catch {
        continue;
      }
      for (const { id, record } of saves) {
        if (!sameAccount()) return;
        const stays = await applyHold(cloud, id, record, holds);
        if (!sameAccount()) return;
        if (!stays) store().forget(id);
      }
    }
  };

  const reconcile = (hostId: string): Promise<void> => {
    const previous = running.get(hostId) ?? Promise.resolve();
    // A failed run reaches no error report: what it remembers stays private,
    // and the records it did not settle wait for the next run.
    const next = previous
      .then(() => reconcileOnce(hostId))
      .catch(() => undefined);
    running.set(hostId, next);
    void next.finally(() => {
      if (running.get(hostId) === next) running.delete(hostId);
    });
    return next;
  };

  const begin = async (
    mapping: SettingsSaveMapping,
    context: SettingsSaveContext,
  ): Promise<string | null> => {
    if (mapping.kind !== "proposal") return null;
    if (ports.accountId() === null) return null;
    const { edit } = mapping;
    const valueDigest =
      edit.operation === "put" ? await settingValueDigest(edit.value) : null;
    const id = store().remember({
      environmentId: context.environmentId,
      hostId: context.hostId,
      sharingGeneration: context.sharingGeneration,
      kind: edit.kind,
      key: edit.key,
      os: edit.os,
      operation: edit.operation,
      valueDigest,
      expectedLiveRevision: context.expectedLiveRevision,
      writtenAt: ports.now(),
      unanswered: null,
    });
    store().markSent(id);
    return id;
  };

  const settle = async (
    ticket: string,
    answer: SettingsSaveAnswer | null,
  ): Promise<void> => {
    store().markAnswered(ticket);
    const record = settingsSaveMemoryRecord(store().records, ticket);
    if (record === null || answer === null) return;
    const receipt = answer.proposal;
    if (
      receipt === null ||
      receipt.state === "refused" ||
      !receiptMatches(record, receipt)
    ) {
      store().forget(ticket);
      return;
    }
    await reconcile(record.hostId);
  };

  return { begin, settle, reconcile };
}
