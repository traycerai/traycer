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
import {
  readAcceptedPersonalMoveRevision,
  readSettingsItemRows,
  readSettingsSaveHost,
  readSettingsSavePersonal,
} from "@traycer-clients/shared/environment/settings-save-target";
import type { HostOs } from "@traycer/protocol/host/environment/host-os";
import type {
  EnvironmentProposalsResponse,
  PendingProfileName,
  SettingsProposalReceipt,
} from "@traycer/protocol/host/environment/settings-proposals";
import type {
  SettingsItemEdit,
  SettingsSaveMapping,
} from "@traycer/protocol/host/environment/settings-save-mapping";
import { settingsSaveMemoryKey } from "@/lib/persist";
import {
  SETTINGS_SAVE_MEMORY_TTL_MS,
  settingsSaveMemoryRecord,
  useSettingsSaveMemoryStore,
  type BoundSettingsSave,
  type RememberedPersonalSave,
  type RememberedSettingsItem,
  type UnansweredMoveSave,
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

export type PrebindSettingsSaveTarget =
  | {
      readonly environmentId: string;
      readonly item: {
        readonly edit: SettingsItemEdit;
        readonly expectedLiveRevision: number | null;
      } | null;
    }
  | {
      readonly environmentId: string | null;
      readonly acceptanceId: string;
      readonly resolveHostOs: boolean;
      readonly edit: SettingsItemEdit;
    };

interface PrebindSettingsSaveContext {
  readonly accountId: string;
  readonly hostId: string;
  readonly onOriginSignIn: () => boolean;
}

export interface SettingsSaveCoordinatorPorts {
  readonly accountId: () => string | null;
  readonly cloud: () => EnvironmentCloud | null;
  /** Never opens or dials a connection: a remote host only through a borrowed ready session. */
  readonly readProposals: (
    hostId: string,
    profileNameSaveIds: readonly string[],
  ) => Promise<EnvironmentProposalsResponse | null>;
  readonly profileNames?: {
    readonly read: (receipt: PendingProfileName) => Promise<string | null>;
    readonly write: (receipt: PendingProfileName) => Promise<boolean>;
  };
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
    context: PrebindSettingsSaveContext,
    readPersonal: () => Promise<PrebindSettingsSaveTarget | null>,
  ) => Promise<SettingsSaveBeginning>;
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
    receiptMatchesItem(record, receipt, false)
  );
}

function receiptMatchesItem(
  item: RememberedSettingsItem,
  receipt: SettingsProposalReceipt,
  resolveHostOs: boolean,
): boolean {
  return (
    receipt.kind === item.kind &&
    receipt.key === item.key &&
    (resolveHostOs || receipt.os === item.os) &&
    receipt.operation === item.operation
  );
}

function holdMatches(
  item: RememberedSettingsItem,
  receipt: SettingsProposalReceipt,
  hold: HeldChangeForMatch,
): boolean {
  return (
    hold.hostId === receipt.hostId &&
    hold.sharingGeneration === receipt.sharingGeneration &&
    hold.kind === item.kind &&
    hold.key === item.key &&
    hold.os === receipt.os &&
    hold.op === item.operation &&
    hold.valueDigest === item.valueDigest
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
  readonly prebind: boolean;
  readonly heldRevision: number | null;
  readonly moveWrittenRevision: number | null;
}

function findReceiptForSave(
  proposals: EnvironmentProposalsResponse["proposals"],
  id: string,
  record: SettingsSaveMemoryRecord,
): EnvironmentProposalsResponse["proposals"][number] | undefined {
  const promoted = proposals.find(({ proposal, promotion }) => {
    if (
      promotion?.saveId !== id ||
      proposal.proposalId !== id ||
      proposal.hostId !== record.hostId
    ) {
      return false;
    }
    if (record.environmentId !== null) {
      return receiptMatches(record, proposal);
    }
    const personal = record.personal ?? null;
    if (personal === null) return false;
    if ("acceptanceId" in personal) {
      return (
        promotion.moveAcceptanceId === personal.acceptanceId &&
        typeof promotion.moveWrittenRevision === "number" &&
        (personal.environmentId === null ||
          personal.environmentId === proposal.environmentId) &&
        receiptMatchesItem(personal.moveItem, proposal, personal.resolveHostOs)
      );
    }
    return (
      personal.item !== null &&
      promotion.moveWrittenRevision !== undefined &&
      proposal.environmentId === personal.environmentId &&
      receiptMatchesItem(personal.item, proposal, false)
    );
  });
  if (promoted !== undefined || record.environmentId === null) return promoted;
  return proposals.find(
    ({ proposal, promotion }) =>
      promotion === undefined && receiptMatches(record, proposal),
  );
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
    const row = findReceiptForSave(proposals.proposals, id, record);
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
      const { proposal: receipt, promotion } = row;
      if (promotion?.heldRevision === null) continue;
      const { environmentId } = receipt;
      const list = proposed.get(environmentId) ?? [];
      list.push({
        id,
        receipt,
        prebind: record.environmentId === null,
        heldRevision: promotion?.heldRevision ?? null,
        moveWrittenRevision: promotion?.moveWrittenRevision ?? null,
      });
      proposed.set(environmentId, list);
    }
  }
  return { forget, proposed };
}

type HoldAttemptResult = "applied" | "stays" | "decided";

interface ApplyHoldOptions {
  readonly cloud: EnvironmentCloud;
  readonly save: RememberedSave;
  readonly record: SettingsSaveMemoryRecord;
  readonly holds: readonly HeldChangeForMatch[];
  readonly hostOs: HostOs | null;
  readonly mayApply: () => boolean;
}

interface ApplyProposedOptions {
  readonly cloud: EnvironmentCloud;
  readonly hostId: string;
  readonly environmentId: string;
  readonly saves: readonly RememberedSave[];
  readonly mayAct: () => boolean;
  readonly mayAdoptLocal: () => boolean;
}

async function verifiesUnansweredMove(
  cloud: EnvironmentCloud,
  receipt: SettingsProposalReceipt,
  witness: UnansweredMoveSave,
  {
    moveRevision,
    hostOs,
  }: {
    readonly moveRevision: number;
    readonly hostOs: HostOs | null;
  },
): Promise<boolean> {
  if (witness.resolveHostOs && hostOs === null) return false;
  const { environmentId, hostId, kind, key, os } = receipt;
  const [personal, acceptedRevision, rows] = await Promise.all([
    readSettingsSavePersonal(cloud),
    readAcceptedPersonalMoveRevision(cloud, hostId, witness.acceptanceId),
    witness.resolveHostOs
      ? readSettingsItemRows(cloud, environmentId, kind)
      : [],
  ]);
  if (personal !== environmentId || acceptedRevision !== moveRevision)
    return false;
  if (!witness.resolveHostOs) return true;
  const effectiveOs = rows.some((row) => row.key === key && row.os === hostOs)
    ? hostOs
    : "any";
  return os === effectiveOs;
}

async function checkMoveBase(
  cloud: EnvironmentCloud,
  unansweredMove: UnansweredMoveSave,
  hold: HeldChangeForMatch,
  {
    receipt,
    moveWrittenRevision,
    hostOs,
    mayApply,
  }: {
    readonly receipt: SettingsProposalReceipt;
    readonly moveWrittenRevision: number | null;
    readonly hostOs: HostOs | null;
    readonly mayApply: () => boolean;
  },
): Promise<"ready" | "decided" | "stays"> {
  // Any new revision, including a rewrite of equal bytes, stays in Review.
  if (moveWrittenRevision === null || hold.liveRevision !== moveWrittenRevision)
    return "decided";
  let verified: boolean;
  try {
    verified = await verifiesUnansweredMove(cloud, receipt, unansweredMove, {
      moveRevision: moveWrittenRevision,
      hostOs,
    });
  } catch {
    return "stays";
  }
  if (!verified) return "decided";
  if (!mayApply()) return "stays";
  return "ready";
}

function rememberedHoldItem(record: SettingsSaveMemoryRecord): {
  readonly item: RememberedSettingsItem | null;
  readonly unansweredMove: UnansweredMoveSave | null;
} {
  if (record.environmentId !== null)
    return { item: record, unansweredMove: null };
  const personal = record.personal;
  if (
    personal !== null &&
    personal !== undefined &&
    "acceptanceId" in personal
  ) {
    return { item: personal.moveItem, unansweredMove: personal };
  }
  return { item: personal?.item ?? null, unansweredMove: null };
}

function exhaustedHoldAttempts(
  record: SettingsSaveMemoryRecord,
  revision: number,
): boolean {
  return (
    record.unanswered?.revision === revision &&
    record.unanswered.tries >= TRIES_PER_HOLD_REVISION
  );
}

function rememberPersonalTarget(
  personal: PrebindSettingsSaveTarget | null,
  item: RememberedSettingsItem | null,
): RememberedPersonalSave | null {
  if (personal === null) return null;
  if (!("acceptanceId" in personal))
    return { environmentId: personal.environmentId, item };
  if (item === null) return null;
  return {
    environmentId: personal.environmentId,
    acceptanceId: personal.acceptanceId,
    resolveHostOs: personal.resolveHostOs,
    item: null,
    moveItem: item,
  };
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
    record.environmentId !== null &&
    ports.now() - record.writtenAt > SETTINGS_SAVE_MEMORY_TTL_MS;

  const forgetExpired = (): void => {
    for (const [id, record] of Object.entries(store().records)) {
      if (expired(record)) forget(id);
    }
  };

  const applyHold = async ({
    cloud,
    save,
    record,
    holds,
    hostOs,
    mayApply,
  }: ApplyHoldOptions): Promise<HoldAttemptResult> => {
    const { id, receipt, heldRevision, moveWrittenRevision } = save;
    const { item, unansweredMove } = rememberedHoldItem(record);
    if (item === null) return "decided";
    const hold = holds.find(
      (candidate) =>
        (heldRevision === null || candidate.revision === heldRevision) &&
        holdMatches(item, receipt, candidate),
    );
    // A hold can have been decided while the review read was out.
    if (hold === undefined) return "decided";
    if (unansweredMove !== null) {
      const decision = await checkMoveBase(cloud, unansweredMove, hold, {
        receipt,
        moveWrittenRevision,
        hostOs,
        mayApply,
      });
      if (decision !== "ready") return decision;
    }
    // An answered absence can also use the durable revision of this Move's write.
    const expectedLiveRevision =
      item.expectedLiveRevision ?? (save.prebind ? moveWrittenRevision : null);
    const latest = settingsSaveMemoryRecord(store().records, id);
    if (latest === null) return "stays";
    if (exhaustedHoldAttempts(latest, hold.revision)) return "stays";
    const answered: { status: number | null } = { status: null };
    const watched: EnvironmentCloud = {
      ...cloud,
      transport: async (request) => {
        const answer = await cloud.transport(request);
        answered.status = answer.status;
        return answer;
      },
    };
    if (unansweredMove !== null && !mayApply()) return "stays";
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
      if (mayApply() && !passingFailure(answered.status)) {
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

  const applyProfileNames = async (
    receipts: readonly PendingProfileName[],
    localIds: readonly string[],
    mayAct: () => boolean,
  ): Promise<void> => {
    const names = ports.profileNames;
    if (names === undefined || receipts.length === 0) return;
    const requested = new Set(localIds);
    for (const receipt of receipts) {
      if (!mayAct()) return;
      const { saveId, name, baseName } = receipt;
      if (!requested.has(saveId) || !isCurrent(saveId)) continue;
      try {
        const currentName = await names.read(receipt);
        if (!mayAct()) return;
        if (currentName === null || !isCurrent(saveId)) continue;

        // A lost reply or a newer independent rename may have settled this save.
        const settled = currentName === name || currentName !== baseName;
        if (!settled && !(await names.write(receipt))) continue;
        if (!mayAct()) return;
        forget(saveId);
      } catch {
        // A lost reply leaves the save for another authenticated read.
      }
    }
  };

  const reconcileOnce = async (
    hostId: string,
    current: () => boolean,
    notStopped: () => boolean,
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
    const mayAdoptLocal = (): boolean => notStopped() && mayAct();
    forgetExpired();
    dropUnremembered();
    const mine = Object.entries(store().records).filter(
      ([, record]) => record.hostId === hostId,
    );
    if (mine.length === 0) return;

    const localIds = mine.flatMap(([id, save]) =>
      save.environmentId === null ? [id] : [],
    );
    const outAtRead = new Set(mine.map(([id]) => id).filter(inFlight));
    let proposals: EnvironmentProposalsResponse | null;
    try {
      proposals = await ports.readProposals(
        hostId,
        ports.profileNames === undefined ? [] : localIds,
      );
    } catch {
      proposals = null;
    }
    // Not connected, or nothing answered: every record waits for the next
    // connection.
    if (proposals === null || !mayAct()) return;

    // A later save of the same item may have replaced a record since the reads; then
    // neither its apply nor its forgetting is this run's.
    const activeRecords = mayAdoptLocal()
      ? mine
      : mine.filter(([, record]) => record.environmentId !== null);
    const sorted = sortByReceipt(
      activeRecords,
      proposals,
      ports.now(),
      outAtRead,
    );
    for (const id of sorted.forget) {
      forget(id);
    }
    if (cloud === null) return;
    for (const [environmentId, saves] of sorted.proposed) {
      if (
        !(await applyProposed({
          cloud,
          hostId,
          environmentId,
          saves,
          mayAct,
          mayAdoptLocal,
        }))
      ) {
        return;
      }
    }
    await applyProfileNames(
      proposals.pendingProfileNames ?? [],
      localIds,
      mayAdoptLocal,
    );
  };

  const finishHoldAttempt = (id: string, result: HoldAttemptResult): void => {
    if (result === "applied") appliedListeners.get(id)?.();
    if (result !== "stays") forget(id);
  };

  const applyProposed = async ({
    cloud,
    hostId,
    environmentId,
    saves,
    mayAct,
    mayAdoptLocal,
  }: ApplyProposedOptions): Promise<boolean> => {
    const host =
      mayAdoptLocal() && saves.some((save) => save.prebind)
        ? await readSettingsSaveHost(cloud, environmentId, hostId).catch(
            () => null,
          )
        : null;
    if (!mayAct()) return false;
    const ready = saves.filter(
      (save) =>
        !save.prebind ||
        (mayAdoptLocal() &&
          host?.sharingGeneration === save.receipt.sharingGeneration),
    );
    if (ready.length === 0) return true;

    let holds: readonly HeldChangeForMatch[];
    try {
      holds = await readHeldChangesForMatch(cloud, environmentId);
    } catch {
      return true;
    }
    for (const save of ready) {
      const { id } = save;
      if (!mayAct()) return false;
      const mayApply = save.prebind ? mayAdoptLocal : mayAct;
      if (!mayApply()) continue;
      // Read after the waits: another coordinator may have spent a try since.
      const record = settingsSaveMemoryRecord(store().records, id);
      if (record === null) continue;
      // The reads may have outlasted the save's TTL.
      if (expired(record)) {
        forget(id);
        continue;
      }
      const result = await applyHold({
        cloud,
        save,
        record,
        holds,
        hostOs: host?.hostOs ?? null,
        mayApply,
      });
      if (!mayAct()) return false;
      if (!mayApply()) continue;
      finishHoldAttempt(id, result);
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
    const notStopped = (): boolean => generation === armedIn;
    const current = followUp ? notStopped : () => true;
    const next = previous
      .then(() =>
        current() ? reconcileOnce(hostId, current, notStopped) : undefined,
      )
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

  const beginLocal = async (
    context: PrebindSettingsSaveContext,
    readPersonal: () => Promise<PrebindSettingsSaveTarget | null>,
  ): Promise<SettingsSaveBeginning> => {
    const { accountId, hostId, onOriginSignIn } = context;
    const onOrigin = (): boolean =>
      memoryAccount() === accountId && onOriginSignIn();
    if (!onOrigin()) return ACCOUNT_CHANGED;
    const begun = generation;
    const writtenAt = ports.now();
    const personal = await readPersonal();
    if (!onOrigin()) return ACCOUNT_CHANGED;
    if (generation !== begun) return NOTHING_TO_REMEMBER;
    const item =
      personal !== null && "acceptanceId" in personal
        ? { edit: personal.edit, expectedLiveRevision: null }
        : (personal?.item ?? null);
    let rememberedItem: RememberedSettingsItem | null = null;
    if (item !== null) {
      const { edit, expectedLiveRevision } = item;
      const valueDigest =
        edit.operation === "put"
          ? await settingValueDigest(edit.value).catch(() => null)
          : null;
      if (edit.operation === "delete" || valueDigest !== null) {
        rememberedItem = {
          kind: edit.kind,
          key: edit.key,
          os: edit.os,
          operation: edit.operation,
          valueDigest,
          expectedLiveRevision,
        };
      }
    }
    if (!onOrigin()) return ACCOUNT_CHANGED;
    if (generation !== begun) return NOTHING_TO_REMEMBER;
    const target = rememberPersonalTarget(personal, rememberedItem);
    return remember(
      {
        editId: crypto.randomUUID(),
        environmentId: null,
        hostId,
        personal: target,
        writtenAt,
        unanswered: null,
      },
      begun,
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
