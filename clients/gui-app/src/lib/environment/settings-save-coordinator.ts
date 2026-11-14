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
} from "@traycer/protocol/host/environment/settings-proposals";
import type { SettingsSaveMapping } from "@traycer/protocol/host/environment/settings-save-mapping";
import { settingsSaveMemoryKey } from "@/lib/persist";
import {
  SETTINGS_SAVE_MEMORY_TTL_MS,
  settingsSaveMemoryRecord,
  useSettingsSaveMemoryStore,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";

const NOTHING_TO_REMEMBER: SettingsSaveBeginning = {
  kind: "nothing_to_remember",
};
const ACCOUNT_CHANGED: SettingsSaveBeginning = { kind: "account_changed" };

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
  /**
   * The account the save's preparation began for
   * ({@link SettingsSaveCoordinator.account}, read before its first await).
   */
  readonly accountId: string;
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

/** One remembered edit: its record's id, which is the edit's own identity. */
export interface SettingsSaveTicket {
  readonly id: string;
}

/** What {@link SettingsSaveCoordinator.begin} did with a save. */
export type SettingsSaveBeginning =
  | { readonly kind: "remembered"; readonly ticket: SettingsSaveTicket }
  /** The save proposes nothing to remember; it is sent as it is. */
  | { readonly kind: "nothing_to_remember" }
  /**
   * The account changed since the save's preparation began: it is neither
   * remembered nor sent.
   */
  | { readonly kind: "account_changed" };

export interface SettingsSaveCoordinator {
  /**
   * The account a save's preparation begins for: the signed-in one, while
   * the memory is that account's. Null otherwise, and then nothing is
   * remembered. A preparation that reads a different answer after any await
   * is for an account that is no longer here.
   */
  readonly account: () => string | null;
  /**
   * Called before the save is sent: remembers a save that maps to a proposal
   * and marks it sent, answering the ticket {@link settle} takes.
   */
  readonly begin: (
    mapping: SettingsSaveMapping,
    context: SettingsSaveContext,
  ) => Promise<SettingsSaveBeginning>;
  /**
   * The save's send is over: `hostAnswered` when the host answered it, false
   * when it failed or nothing answered. An answered save's host is
   * reconciled, which finds its proposal in `environment.proposals`; no save
   * answer carries one.
   */
  readonly settle: (
    ticket: SettingsSaveTicket,
    hostAnswered: boolean,
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

/** Whether the edit `id` is still remembered. */
function isCurrent(id: string): boolean {
  return Object.hasOwn(useSettingsSaveMemoryStore.getState().records, id);
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
  readonly forget: readonly RememberedSave[];
  readonly proposed: ReadonlyMap<string, readonly RememberedSave[]>;
} {
  const forget: RememberedSave[] = [];
  const proposed = new Map<string, RememberedSave[]>();
  for (const [id, record] of mine) {
    const receipt = proposals.proposals.find((row) =>
      receiptMatches(record, row.proposal),
    )?.proposal;
    if (receipt === undefined) {
      // A save still out, here or in another window, may not have reached
      // the host's list yet.
      if (!inFlight(id) && now - record.writtenAt > UNLISTED_GRACE_MS) {
        forget.push({ id, record });
      }
    } else if (receipt.state === "refused") {
      forget.push({ id, record });
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

    // Every record below is the edit as it stood before the reads: a later
    // save of the same item may have replaced it since, and then neither its
    // apply nor its forgetting is this run's to do.
    const sorted = sortByReceipt(mine, proposals, ports.now());
    for (const { id } of sorted.forget) {
      store().forget(id);
    }
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
        if (!isCurrent(id)) continue;
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

  const account = (): string | null => {
    const signedIn = ports.accountId();
    return signedIn !== null &&
      useSettingsSaveMemoryStore.persist.getOptions().name ===
        settingsSaveMemoryKey(signedIn)
      ? signedIn
      : null;
  };

  const begin = async (
    mapping: SettingsSaveMapping,
    context: SettingsSaveContext,
  ): Promise<SettingsSaveBeginning> => {
    if (account() !== context.accountId) return ACCOUNT_CHANGED;
    if (mapping.kind !== "proposal") return NOTHING_TO_REMEMBER;
    const { edit } = mapping;
    const valueDigest =
      edit.operation === "put" ? await settingValueDigest(edit.value) : null;
    // The memory may be another account's by now: an edit is remembered only
    // in the memory of the account it was made for.
    if (account() !== context.accountId) return ACCOUNT_CHANGED;
    const id = store().remember({
      editId: crypto.randomUUID(),
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
    return { kind: "remembered", ticket: { id } };
  };

  const settle = async (
    ticket: SettingsSaveTicket,
    hostAnswered: boolean,
  ): Promise<void> => {
    store().markAnswered(ticket.id);
    const record = settingsSaveMemoryRecord(store().records, ticket.id);
    if (!hostAnswered || record === null) return;
    await reconcile(record.hostId);
  };

  return { account, begin, settle, reconcile };
}
