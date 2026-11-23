// No host commits a setting: the app that made the edit applies its own hold.
// Nothing here logs, reports or throws what it remembers.
import {
  isCloudFailure,
  type EnvironmentCloud,
} from "@traycer-clients/shared/environment/environment-cloud";
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
  type BoundSettingsSave,
  type SettingsSaveMemoryRecord,
} from "@/stores/settings/settings-save-memory-store";

const NOTHING_TO_REMEMBER: SettingsSaveBeginning = {
  kind: "nothing_to_remember",
};
const ACCOUNT_CHANGED: SettingsSaveBeginning = { kind: "account_changed" };

/**
 * An apply authn refused for a reason other than {@link passingFailure} is
 * tried once more at the same hold revision, then left.
 */
const TRIES_PER_HOLD_REVISION = 2;

/**
 * An apply authn could not take just now spends no try: a short outage would
 * otherwise use both within the first follow-ups, and the hold would wait out
 * its TTL unapplied. That is no answer at all, a redirect (the desktop's
 * opaque status 0 among them), a 5xx, 408, 429, or a 401 a sign-in mends.
 */
function passingFailure(status: number | null): boolean {
  if (status === null) return true;
  const answer = { status, body: null };
  return (
    isCloudFailure(answer) || status === 401 || status === 408 || status === 429
  );
}

/** Another window may still have the save out; its answer comes within this time. */
const UNLISTED_GRACE_MS = 60_000;

// The host answers a save before it proposes it, and nothing tells the app when
// the proposal is made, so a host with a remembered save is read again: soon at
// first, then no more often than the longest wait, until the memory forgets the
// save (applied, decided, refused or past its TTL).
const FOLLOW_UP_FIRST_MS = 2_000;
const FOLLOW_UP_LONGEST_MS = 5 * 60_000;
const FOLLOW_UP_LONGEST_STEP = Math.ceil(
  Math.log2(FOLLOW_UP_LONGEST_MS / FOLLOW_UP_FIRST_MS),
);

/** The `schedule` port on the window's own timers. */
export function scheduleFollowUp(run: () => void, delayMs: number): () => void {
  const timer = window.setTimeout(run, delayMs);
  return () => window.clearTimeout(timer);
}

export interface SettingsSaveContext {
  /** Read before the preparation's first await. */
  readonly accountId: string;
  readonly environmentId: string;
  readonly hostId: string;
  readonly sharingGeneration: number;
  readonly expectedLiveRevision: number | null;
}

export interface SettingsSaveCoordinatorPorts {
  readonly accountId: () => string | null;
  readonly cloud: () => EnvironmentCloud | null;
  /** Never opens or dials a connection: a remote host only through a borrowed ready session. */
  readonly readProposals: (
    hostId: string,
  ) => Promise<EnvironmentProposalsResponse | null>;
  readonly now: () => number;
  /** Runs `run` once after `delayMs`; the returned function cancels it. */
  readonly schedule: (run: () => void, delayMs: number) => () => void;
}

export interface SettingsSaveTicket {
  readonly id: string;
}

export type SettingsSaveBeginning =
  | { readonly kind: "remembered"; readonly ticket: SettingsSaveTicket }
  | { readonly kind: "nothing_to_remember" }
  | { readonly kind: "account_changed" };

export interface SettingsSaveCoordinator {
  /** A preparation that reads a different answer after any await is for an account no longer here. */
  readonly account: () => string | null;
  /** `applied` is called once, only if this window's apply of the save's own hold writes it. */
  readonly begin: (
    mapping: SettingsSaveMapping,
    context: SettingsSaveContext,
    applied: () => void,
  ) => Promise<SettingsSaveBeginning>;
  /** Remembers a save whose host is running locally, before it has a binding. */
  readonly beginLocal: (
    accountId: string,
    hostId: string,
  ) => SettingsSaveBeginning;
  /** A proposed save's host is reconciled through `environment.proposals`; no save answer carries it. */
  readonly settle: (
    ticket: SettingsSaveTicket,
    hostAnswered: boolean,
  ) => Promise<void>;
  /** One at a time per host; a call while one runs waits for it. */
  readonly reconcile: (hostId: string) => Promise<void>;
  /** Cancels every follow-up read, including one a run still out would arm; a later call arms them again. */
  readonly stop: () => void;
}

function receiptMatches(
  record: BoundSettingsSave,
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
  record: BoundSettingsSave,
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

function isCurrent(id: string): boolean {
  return Object.hasOwn(useSettingsSaveMemoryStore.getState().records, id);
}

function inFlight(id: string): boolean {
  return Object.hasOwn(useSettingsSaveMemoryStore.getState().inFlight, id);
}

interface RememberedSave {
  readonly id: string;
  readonly receipt: SettingsProposalReceipt;
  readonly promotedRevision: number | null;
}

function sortByReceipt(
  mine: ReadonlyArray<readonly [string, SettingsSaveMemoryRecord]>,
  proposals: EnvironmentProposalsResponse,
  now: number,
  outAtRead: ReadonlySet<string>,
): {
  readonly forget: readonly string[];
  readonly proposed: ReadonlyMap<string, readonly RememberedSave[]>;
} {
  const forget: string[] = [];
  const localSaveIds = new Set(proposals.localSaveIds);
  const proposed = new Map<string, RememberedSave[]>();
  for (const [id, record] of mine) {
    const promoted = proposals.proposals.find(
      (row) =>
        row.promotion?.saveId === id &&
        row.proposal.proposalId === id &&
        row.proposal.hostId === record.hostId,
    );
    const row =
      promoted ??
      (record.environmentId === null
        ? undefined
        : proposals.proposals.find(
            (candidate) =>
              candidate.promotion === undefined &&
              receiptMatches(record, candidate.proposal),
          ));
    if (row === undefined) {
      // A save out when the read began may be recorded after this snapshot.
      if (
        !localSaveIds.has(id) &&
        !outAtRead.has(id) &&
        now - record.writtenAt > UNLISTED_GRACE_MS
      ) {
        forget.push(id);
      }
    } else if (row.proposal.state === "refused") {
      forget.push(id);
    } else if (row.proposal.state === "proposed") {
      const environmentId = row.proposal.environmentId;
      const list = proposed.get(environmentId) ?? [];
      list.push({
        id,
        receipt: row.proposal,
        promotedRevision: promoted?.promotion?.heldRevision ?? null,
      });
      proposed.set(environmentId, list);
    }
  }
  return { forget, proposed };
}

export function createSettingsSaveCoordinator(
  ports: SettingsSaveCoordinatorPorts,
): SettingsSaveCoordinator {
  const running = new Map<string, Promise<void>>();
  const appliedListeners = new Map<string, () => void>();
  const store = () => useSettingsSaveMemoryStore.getState();

  const forget = (id: string): void => {
    store().forget(id);
    appliedListeners.delete(id);
  };

  const dropUnremembered = (): void => {
    for (const id of appliedListeners.keys()) {
      if (!isCurrent(id)) appliedListeners.delete(id);
    }
  };

  const expired = (record: SettingsSaveMemoryRecord): boolean =>
    ports.now() - record.writtenAt > SETTINGS_SAVE_MEMORY_TTL_MS;

  const forgetExpired = (): void => {
    for (const [id, record] of Object.entries(store().records)) {
      if (expired(record)) forget(id);
    }
  };

  const applyHold = async (
    cloud: EnvironmentCloud,
    save: RememberedSave,
    record: SettingsSaveMemoryRecord,
    holds: readonly HeldChangeForMatch[],
  ): Promise<"applied" | "stays" | "decided"> => {
    const { id, receipt, promotedRevision } = save;
    const hold =
      promotedRevision === null
        ? holds.find(
            (candidate) =>
              record.environmentId !== null && holdMatches(record, candidate),
          )
        : holds.find(
            (candidate) =>
              candidate.revision === promotedRevision &&
              candidate.hostId === receipt.hostId &&
              candidate.sharingGeneration === receipt.sharingGeneration &&
              candidate.kind === receipt.kind &&
              candidate.key === receipt.key &&
              candidate.os === receipt.os &&
              candidate.op === receipt.operation,
          );
    // A hold can have been decided while the review read was out.
    if (hold === undefined) return "decided";
    let expectedLiveRevision: number | null;
    if (promotedRevision === null) {
      if (record.environmentId === null) return "stays";
      expectedLiveRevision = record.expectedLiveRevision;
    } else {
      if (record.promotionBase?.heldRevision === promotedRevision) {
        expectedLiveRevision = record.promotionBase.liveRevision;
      } else {
        expectedLiveRevision = hold.liveRevision;
        store().notePromotionBase(id, promotedRevision, expectedLiveRevision);
      }
    }
    if (
      record.unanswered?.revision === hold.revision &&
      record.unanswered.tries >= TRIES_PER_HOLD_REVISION
    ) {
      return "stays";
    }
    const answered: { status: number | null } = { status: null };
    const watched: EnvironmentCloud = {
      ...cloud,
      transport: async (request) => {
        const answer = await cloud.transport(request);
        answered.status = answer.status;
        return answer;
      },
    };
    try {
      const { outcome } = await applyHeldChange(
        watched,
        receipt.environmentId,
        {
          heldId: hold.heldId,
          revision: hold.revision,
          expectedLiveRevision,
        },
      );
      // A conflict, gone or forbidden decides this hold for this save too.
      return outcome === "applied" ? "applied" : "decided";
    } catch {
      if (!passingFailure(answered.status)) {
        store().noteUnanswered(id, hold.revision);
      }
      return "stays";
    }
  };

  /** The signed-in account, while the memory installed is that account's. */
  const memoryAccount = (): string | null => {
    const signedIn = ports.accountId();
    return signedIn !== null &&
      useSettingsSaveMemoryStore.persist.getOptions().name ===
        settingsSaveMemoryKey(signedIn)
      ? signedIn
      : null;
  };

  const reconcileOnce = async (
    hostId: string,
    current: () => boolean,
  ): Promise<void> => {
    // Until the memory is the signed-in account's, its records are another
    // account's, and they wait for that account.
    const account = memoryAccount();
    if (account === null) return;
    // Once the run's sign-in ends, the run stops even where the account is the
    // same; a follow-up also stops once `stop()` has run since it was armed.
    const cloud = ports.cloud();
    const mayAct = (): boolean =>
      current() &&
      memoryAccount() === account &&
      (cloud === null || cloud.onOriginSignIn());
    forgetExpired();
    dropUnremembered();
    const mine = Object.entries(store().records).filter(
      ([, record]) => record.hostId === hostId,
    );
    if (mine.length === 0) return;

    const outAtRead = new Set(mine.map(([id]) => id).filter(inFlight));
    let proposals: EnvironmentProposalsResponse | null;
    try {
      proposals = await ports.readProposals(hostId);
    } catch {
      proposals = null;
    }
    // Not connected, or nothing answered: every record waits for the next
    // connection.
    if (proposals === null || !mayAct()) return;

    // A later save of the same item may have replaced a record since the reads; then
    // neither its apply nor its forgetting is this run's.
    const sorted = sortByReceipt(mine, proposals, ports.now(), outAtRead);
    for (const id of sorted.forget) {
      forget(id);
    }
    if (sorted.proposed.size === 0 || cloud === null) return;

    for (const [environmentId, saves] of sorted.proposed) {
      if (!(await applyProposed(cloud, environmentId, saves, mayAct))) {
        return;
      }
    }
  };

  const applyProposed = async (
    cloud: EnvironmentCloud,
    environmentId: string,
    saves: readonly RememberedSave[],
    mayAct: () => boolean,
  ): Promise<boolean> => {
    let holds: readonly HeldChangeForMatch[];
    try {
      holds = await readHeldChangesForMatch(cloud, environmentId);
    } catch {
      return true;
    }
    for (const save of saves) {
      const { id } = save;
      if (!mayAct()) return false;
      // Read after the waits: another coordinator may have spent a try since.
      const record = settingsSaveMemoryRecord(store().records, id);
      if (record === null) continue;
      // The reads may have outlasted the save's TTL.
      if (expired(record)) {
        forget(id);
        continue;
      }
      const result = await applyHold(cloud, save, record, holds);
      if (!mayAct()) return false;
      if (result === "applied") appliedListeners.get(id)?.();
      if (result !== "stays") forget(id);
    }
    return true;
  };

  const followUps = new Map<
    string,
    { readonly dueAt: number; readonly cancel: () => void }
  >();
  let generation = 0;
  /** A save begun before a stop arms nothing when it settles after it. */
  const begunIn = new Map<string, number>();

  const awaitsHold = (hostId: string): boolean =>
    Object.values(store().records).some((record) => record.hostId === hostId);

  // A later arm never pushes out a sooner one: a new save's short wait stands
  // against an older run's long one, whichever of them arms last.
  const armFollowUp = (hostId: string, step: number, armedIn: number): void => {
    // Another account's records wait for that account: its sign-in reconciles them.
    if (generation !== armedIn || memoryAccount() === null) return;
    const armed = followUps.get(hostId);
    if (!awaitsHold(hostId)) {
      armed?.cancel();
      followUps.delete(hostId);
      return;
    }
    const delay = Math.min(
      FOLLOW_UP_FIRST_MS * 2 ** step,
      FOLLOW_UP_LONGEST_MS,
    );
    const dueAt = ports.now() + delay;
    if (armed !== undefined && armed.dueAt <= dueAt) return;
    armed?.cancel();
    const cancel = ports.schedule(() => {
      followUps.delete(hostId);
      void run(
        hostId,
        Math.min(step + 1, FOLLOW_UP_LONGEST_STEP),
        armedIn,
        true,
      );
    }, delay);
    followUps.set(hostId, { dueAt, cancel });
  };

  const run = (
    hostId: string,
    nextStep: number,
    armedIn: number,
    followUp: boolean,
  ): Promise<void> => {
    const previous = running.get(hostId) ?? Promise.resolve();
    // A failed run reaches no error report: what it remembers stays private,
    // and the records it did not settle wait for the next run. A follow-up
    // that waited here past a stop, or reaches one while it runs, acts on nothing.
    const current = followUp ? () => generation === armedIn : () => true;
    const next = previous
      .then(() => (current() ? reconcileOnce(hostId, current) : undefined))
      .catch(() => undefined)
      .then(() => armFollowUp(hostId, nextStep, armedIn));
    running.set(hostId, next);
    void next.finally(() => {
      if (running.get(hostId) === next) running.delete(hostId);
    });
    return next;
  };

  const reconcile = (hostId: string): Promise<void> =>
    run(hostId, 0, generation, false);

  const stop = (): void => {
    generation += 1;
    for (const { cancel } of followUps.values()) cancel();
    followUps.clear();
  };

  const remember = (
    record: SettingsSaveMemoryRecord,
    begun: number,
  ): SettingsSaveBeginning => {
    const id = store().remember(record);
    store().markSent(id);
    dropUnremembered();
    begunIn.set(id, begun);
    return { kind: "remembered", ticket: { id } };
  };

  const beginLocal = (
    accountId: string,
    hostId: string,
  ): SettingsSaveBeginning => {
    if (memoryAccount() !== accountId) return ACCOUNT_CHANGED;
    return remember(
      {
        editId: crypto.randomUUID(),
        environmentId: null,
        hostId,
        writtenAt: ports.now(),
        unanswered: null,
      },
      generation,
    );
  };

  const begin = async (
    mapping: SettingsSaveMapping,
    context: SettingsSaveContext,
    applied: () => void,
  ): Promise<SettingsSaveBeginning> => {
    if (memoryAccount() !== context.accountId) return ACCOUNT_CHANGED;
    if (mapping.kind !== "proposal") return NOTHING_TO_REMEMBER;
    // A stop during the digest's await retires this save's follow-ups too.
    const begun = generation;
    const { edit } = mapping;
    const valueDigest =
      edit.operation === "put" ? await settingValueDigest(edit.value) : null;
    // The memory may be another account's by now: an edit is remembered only
    // in the memory of the account it was made for.
    if (memoryAccount() !== context.accountId) return ACCOUNT_CHANGED;
    const record: BoundSettingsSave = {
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
    };
    appliedListeners.set(record.editId, applied);
    return remember(record, begun);
  };

  const settle = async (
    ticket: SettingsSaveTicket,
    hostAnswered: boolean,
  ): Promise<void> => {
    store().markAnswered(ticket.id);
    const armedIn = begunIn.get(ticket.id) ?? null;
    begunIn.delete(ticket.id);
    const record = settingsSaveMemoryRecord(store().records, ticket.id);
    if (record === null || armedIn === null) return;
    // An unanswered save may still reach the host, so it is read for later
    // rather than now.
    if (!hostAnswered) {
      armFollowUp(record.hostId, 0, armedIn);
      return;
    }
    await run(record.hostId, 0, armedIn, false);
  };

  return { account: memoryAccount, begin, beginLocal, settle, reconcile, stop };
}
