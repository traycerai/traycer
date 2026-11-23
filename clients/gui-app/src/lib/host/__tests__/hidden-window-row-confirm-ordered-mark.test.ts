import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type {
  RemoteHostFetcher,
  RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { RegisteredHostsChange } from "@traycer-clients/shared/platform/runner-host";
import { ROW_CONFIRM_CEILING_MS } from "@traycer-clients/shared/host-transport/row-confirmation";
import { confirmRowWhenHidden } from "@/lib/host/hidden-window-row-confirm";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { __setBrowserDocumentHiddenForTests } from "@/lib/dom/document-visibility";

// A hidden window's stale state is an ordered mark: every skipped push moves
// it, and it ends only when a read that STARTED after the latest mark, in the
// current era, as the current read, has settled. The confirmation waits for
// that, within the one ceiling measured from its own start. Every registry
// read here is held by hand: nothing is settled by a clock or a turn count
// except the ceiling itself, on the fake clock.

const IDENTITY = "user-a";

/** A remote attach's confirmation, which lives no longer than the attach is current. */
function confirmWhileCurrent(
  directory: HostDirectoryService,
  current: () => boolean,
): { readonly resolved: () => boolean } {
  const confirmation: (attach: {
    readonly current: () => boolean;
  }) => Promise<void> = confirmRowWhenHidden(() => directory);
  let resolved = false;
  void confirmation({ current }).then(() => {
    resolved = true;
  });
  return { resolved: () => resolved };
}

/** Each `GET /api/v3/hosts` the directory issues, settled by the test. */
interface HeldReads {
  readonly fetcher: RemoteHostFetcher;
  /** Reads issued so far, in order, the first being the start's own, already answered. */
  readonly issued: () => number;
  readonly running: () => number;
  /** The most reads ever running at once. */
  readonly mostAtOnce: () => number;
  /** Settles the read at `index` with one row named `rowId`. */
  readonly answer: (index: number, rowId: string) => void;
}

function heldReads(): HeldReads {
  const settlers: Array<(outcome: RemoteHostFetchOutcome) => void> = [];
  let running = 0;
  let mostAtOnce = 0;
  const fetcher: RemoteHostFetcher = () =>
    new Promise<RemoteHostFetchOutcome>((resolve) => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      const index = settlers.length;
      const settle = (outcome: RemoteHostFetchOutcome): void => {
        running -= 1;
        resolve(outcome);
      };
      settlers.push(settle);
      if (index === 0) settle({ kind: "hosts", entries: [] });
    });
  return {
    fetcher,
    issued: () => settlers.length,
    running: () => running,
    mostAtOnce: () => mostAtOnce,
    answer: (index, rowId) => {
      const settle = settlers.at(index);
      if (settle === undefined)
        throw new Error(`the directory issued no read ${index} yet`);
      settle({ kind: "hosts", entries: [remoteEntry(rowId, null)] });
    },
  };
}

interface Rig {
  readonly directory: HostDirectoryService;
  readonly reads: HeldReads;
  /** A registry push the shell delivers; the window skips it while hidden. */
  readonly push: () => void;
  readonly rotateCredential: () => number;
  /** The signed-in person changes: the identity and the credential era move together. */
  readonly switchIdentity: (identity: string) => number;
  readonly currentCredential: () => number;
  /** The confirmation a remote attach starts, and whether it has resolved. */
  readonly confirm: () => { readonly resolved: () => boolean };
  /** The same, for an attach that is current only while `current` says so. */
  readonly confirmWhileCurrent: (current: () => boolean) => {
    readonly resolved: () => boolean;
  };
  readonly rowIds: () => Promise<string[]>;
}

const directories: HostDirectoryService[] = [];

async function startedWindow(
  hidden: boolean,
  shellPushes: boolean,
): Promise<Rig> {
  const host = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const handlers = new Set<(change: RegisteredHostsChange) => void>();
  // With no push subscription the directory polls, as a browser window does.
  if (shellPushes)
    host.onRegisteredHostsChange = (handler) => {
      handlers.add(handler);
      return { dispose: () => handlers.delete(handler) };
    };
  const reads = heldReads();
  let credential = 1;
  let identity = IDENTITY;
  const directory = new HostDirectoryService({
    onRegistryPollTick: null,
    runnerHost: host,
    authContextId: () => identity,
    credentialGeneration: () => credential,
    localHostIdSeeder: null,
    remoteFetcher: reads.fetcher,
  });
  directories.push(directory);
  await directory.start();
  if (hidden) __setBrowserDocumentHiddenForTests(true);
  return {
    directory,
    reads,
    push: () => {
      for (const handler of handlers)
        handler({ identityKey: IDENTITY, response: { hosts: [] } });
    },
    rotateCredential: () => {
      credential += 1;
      return credential;
    },
    switchIdentity: (next) => {
      identity = next;
      credential += 1;
      return credential;
    },
    currentCredential: () => credential,
    confirm: () => confirmWhileCurrent(directory, () => true),
    confirmWhileCurrent: (current) => confirmWhileCurrent(directory, current),
    rowIds: async () => (await directory.list()).map((entry) => entry.hostId),
  };
}

function startedHiddenWindow(): Promise<Rig> {
  return startedWindow(true, true);
}

/**
 * The monotonic clock passes the confirmation's ceiling while no timer runs.
 * The wall clock does not decide the ceiling, so it is left where it is.
 */
function passTheCeilingOnTheMonotonicClock(): void {
  const passed = performance.now() + ROW_CONFIRM_CEILING_MS + 1;
  vi.spyOn(performance, "now").mockReturnValue(passed);
}

/** Lets what a settled read or an elapsed ceiling resolves run; no timer is due at 0. */
async function drain(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) directory.dispose();
  __setBrowserDocumentHiddenForTests(false);
  vi.useRealTimers();
});

describe("a hidden window's row confirmation waits for a read that started after the latest skip", () => {
  it("(a) still waits for the current-era read when the superseded pre-rotation read settles first", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    // A read starts under era 1; a rotation moves to era 2, whose read is held.
    const eraOneRead = rig.directory.refreshForEra({
      identity: IDENTITY,
      credentialGeneration: rig.currentCredential(),
    });
    const era = rig.rotateCredential();
    rig.directory.invalidateInFlightRefresh();
    const eraTwoRead = rig.directory.refreshForEra({
      identity: IDENTITY,
      credentialGeneration: era,
    });
    // The window is shown; its catch-up joins the era-2 read.
    __setBrowserDocumentHiddenForTests(false);
    expect(rig.reads.issued()).toBe(3);

    rig.reads.answer(1, "era-one-row");
    await eraOneRead;
    const confirmation = rig.confirm();
    await drain();

    expect(confirmation.resolved()).toBe(false);
    expect(rig.reads.issued()).toBe(3);

    rig.reads.answer(2, "era-two-row");
    await eraTwoRead;
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["era-two-row"]);
    expect(rig.reads.mostAtOnce()).toBeLessThanOrEqual(2);
  });

  it("(b) does not resolve when a read settles that a skip landed during, and resolves only after the read that follows it", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const confirmation = rig.confirm();
    await drain();
    // The first read; a skip lands during it, so it settles nothing.
    expect(rig.reads.issued()).toBe(2);
    rig.push();
    rig.reads.answer(1, "row-1");
    await drain();
    // The second read; a skip lands during it as well.
    expect(rig.reads.issued()).toBe(3);
    rig.push();
    rig.reads.answer(2, "row-2");
    await drain();

    expect(confirmation.resolved()).toBe(false);
    // A further read follows, with no second GET beside a running one.
    expect(rig.reads.issued()).toBe(4);
    expect(rig.reads.running()).toBe(1);

    rig.reads.answer(3, "row-3");
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["row-3"]);
    expect(rig.reads.mostAtOnce()).toBe(1);
  });

  it("(c) keeps waiting through every read a skip lands during, and resolves with the last row at the one ceiling from its start", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const confirmation = rig.confirm();
    await drain();
    // Three reads, each settling a second after the last, a skip landing
    // during each: no read of them started after the latest skip.
    for (let read = 1; read <= 3; read += 1) {
      expect(rig.reads.issued()).toBe(read + 1);
      rig.push();
      await vi.advanceTimersByTimeAsync(1_000);
      rig.reads.answer(read, `row-${read}`);
      await drain();
      expect(confirmation.resolved()).toBe(false);
    }
    expect(rig.reads.issued()).toBe(5);
    expect(rig.reads.running()).toBe(1);

    // The ceiling runs from the confirmation's start, not from each read's.
    await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS - 3_000 - 1);
    expect(confirmation.resolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["row-3"]);
    expect(rig.reads.mostAtOnce()).toBe(1);
  });
});

// A confirmation is satisfied only by a read, of the current era and current as
// a read, that started at or after the later of the latest mark and, when the
// document is hidden at the confirmation's start, the confirmation's own start.
describe("a hidden window reads for every sign-in attach, and a confirmation waits on the condition, not on one read", () => {
  it("(F2 a) starts a new read for a later attach in the same hidden span, though the earlier attach's read left no mark, and gets the row the computer moved to", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const first = rig.confirm();
    await drain();
    expect(rig.reads.issued()).toBe(2);
    rig.reads.answer(1, "personal-row");
    await drain();
    expect(first.resolved()).toBe(true);

    // The window stays hidden; the computer moves to a team before the next push.
    const second = rig.confirm();
    await drain();

    expect(second.resolved()).toBe(false);
    expect(rig.reads.issued()).toBe(3);
    rig.reads.answer(2, "team-row");
    await drain();

    expect(second.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["team-row"]);
    expect(rig.reads.mostAtOnce()).toBe(1);
  });

  it("(F2 b) shares a read between two overlapping hidden attaches only when it started after each began, and follows with another read for the one that began later", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const first = rig.confirm();
    await drain();
    // The first attach's read starts after it began. The second attach begins
    // while that read is running, so that read started before it.
    expect(rig.reads.issued()).toBe(2);
    const second = rig.confirm();
    await drain();
    expect(rig.reads.issued()).toBe(2);

    rig.reads.answer(1, "row-1");
    await drain();

    expect(first.resolved()).toBe(true);
    expect(second.resolved()).toBe(false);
    expect(rig.reads.issued()).toBe(3);
    expect(rig.reads.running()).toBe(1);

    rig.reads.answer(2, "row-2");
    await drain();

    expect(second.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["row-2"]);
    expect(rig.reads.mostAtOnce()).toBe(1);
  });

  // A guard: a shown window that skipped nothing has a current row.
  it("(F2 guard) returns at once, reading nothing, in a visible window with no mark outstanding", async () => {
    const rig = await startedWindow(false, true);

    const confirmation = rig.confirm();
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(rig.reads.issued()).toBe(1);
  });

  it("(F4) resolves when the current read of the current era settles, not at the ceiling, though the read it first joined was retired by an era change and never settles", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    // The confirmation joins the era-1 read.
    const confirmation = rig.confirm();
    await drain();
    expect(rig.reads.issued()).toBe(2);
    // A rotation retires it; the era-2 read is the current one.
    const era = rig.rotateCredential();
    rig.directory.invalidateInFlightRefresh();
    const eraTwoRead = rig.directory.refreshForEra({
      identity: IDENTITY,
      credentialGeneration: era,
    });
    expect(rig.reads.issued()).toBe(3);

    rig.reads.answer(2, "era-two-row");
    await eraTwoRead;
    await vi.advanceTimersByTimeAsync(100);

    expect(100).toBeLessThan(ROW_CONFIRM_CEILING_MS);
    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["era-two-row"]);
  });

  // An era change is a mark: a read that started before a rotation never
  // satisfies a confirmation after it, however the wake and the rotation order.
  it("(era mark) keeps waiting for the current-era read when the credentials rotate between the earlier read's settlement and the confirmation's wake", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const confirmation = rig.confirm();
    await drain();
    // The confirmation is pending on era-1 read A.
    expect(rig.reads.issued()).toBe(2);
    let rotated = false;
    // A listener of the directory's refresh state runs inside A's settlement,
    // after A is recorded as settled and before the confirmation's wake: the
    // credentials rotate there, and the app starts the era-2 read.
    const stop = rig.directory.onRefreshStateChange(() => {
      if (rotated) return;
      rotated = true;
      const era = rig.rotateCredential();
      rig.directory.invalidateInFlightRefresh();
      void rig.directory.refreshForEra({
        identity: IDENTITY,
        credentialGeneration: era,
      });
    });

    rig.reads.answer(1, "personal-row");
    await drain();
    stop.dispose();

    // The wake has run; the era-2 read is still pending.
    expect(rig.reads.issued()).toBe(3);
    expect(rig.reads.running()).toBe(1);
    expect(confirmation.resolved()).toBe(false);

    rig.reads.answer(2, "team-row");
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["team-row"]);
    expect(rig.reads.issued()).toBe(3);
  });

  // The entry the app uses when the signed-in person changes is
  // `refreshForEra` with the incoming identity (`HostRuntime`'s context
  // change), with nothing else dropped first.
  it("(identity mark) keeps waiting for the incoming person's read when the signed-in person changes between the earlier read's settlement and the confirmation's wake", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const confirmation = rig.confirm();
    await drain();
    // The confirmation is pending on the first person's read A.
    expect(rig.reads.issued()).toBe(2);
    let switched = false;
    const stop = rig.directory.onRefreshStateChange(() => {
      if (switched) return;
      switched = true;
      const era = rig.switchIdentity("user-b");
      void rig.directory.refreshForEra({
        identity: "user-b",
        credentialGeneration: era,
      });
    });

    rig.reads.answer(1, "first-person-row");
    await drain();
    stop.dispose();

    expect(rig.reads.issued()).toBe(3);
    expect(rig.reads.running()).toBe(1);
    expect(confirmation.resolved()).toBe(false);

    rig.reads.answer(2, "second-person-row");
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["second-person-row"]);
    expect(rig.reads.issued()).toBe(3);
  });

  // A confirmation's loop lives no longer than the attach: once the attach is
  // no longer current, no read is started or joined for it, whatever account
  // is current by then.
  it("(attach ended, rotation) starts no read and resolves when the attach is no longer current, though a rotation follows while its read is held", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    let live = true;
    const confirmation = rig.confirmWhileCurrent(() => live);
    await drain();
    // Read A is held.
    expect(rig.reads.issued()).toBe(2);

    live = false;
    rig.rotateCredential();
    rig.directory.invalidateInFlightRefresh();
    await drain();

    expect(rig.reads.issued()).toBe(2);
    expect(confirmation.resolved()).toBe(true);

    rig.reads.answer(1, "row-a");
    await drain();

    expect(rig.reads.issued()).toBe(2);
    expect(rig.reads.running()).toBe(0);
  });

  it("(attach ended, identity change) resolves without waiting for the incoming person's read when the attach is no longer current, and starts no read of its own", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    let live = true;
    const confirmation = rig.confirmWhileCurrent(() => live);
    await drain();
    expect(rig.reads.issued()).toBe(2);

    live = false;
    const era = rig.switchIdentity("user-b");
    // The app's own read for the incoming person, as HostRuntime starts it.
    void rig.directory.refreshForEra({
      identity: "user-b",
      credentialGeneration: era,
    });
    expect(rig.reads.issued()).toBe(3);
    rig.reads.answer(1, "first-person-row");
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(rig.reads.issued()).toBe(3);
    expect(rig.reads.running()).toBe(1);
  });

  // The ceiling is a monotonic time: a confirmation whose clock has passed it
  // starts no read, though its timer's callback has not run yet. The monotonic
  // clock is moved without running a timer; a wall clock jump decides nothing.
  it("(past the ceiling, identity change) starts no read once the clock is past the ceiling though its timer has not run, and resolves when it runs", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const confirmation = rig.confirm();
    await drain();
    // Read A is held; a change of the signed-in person makes it insufficient.
    expect(rig.reads.issued()).toBe(2);
    rig.switchIdentity("user-b");
    passTheCeilingOnTheMonotonicClock();

    rig.reads.answer(1, "row-a");
    await drain();

    expect(rig.reads.issued()).toBe(2);
    await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
    expect(confirmation.resolved()).toBe(true);
    expect(rig.reads.issued()).toBe(2);
  });

  it("(past the ceiling, rotation) starts no read at the rotation's wake once the clock is past the ceiling though its timer has not run, and resolves when it runs", async () => {
    const rig = await startedHiddenWindow();
    rig.push();
    const confirmation = rig.confirm();
    await drain();
    expect(rig.reads.issued()).toBe(2);
    passTheCeilingOnTheMonotonicClock();

    rig.rotateCredential();
    rig.directory.invalidateInFlightRefresh();
    rig.reads.answer(1, "row-a");
    await drain();

    expect(rig.reads.issued()).toBe(2);
    await vi.advanceTimersByTimeAsync(ROW_CONFIRM_CEILING_MS);
    expect(confirmation.resolved()).toBe(true);
    expect(rig.reads.issued()).toBe(2);
  });

  // In poll mode a skipped tick is a time. A tick that came due during the
  // hidden span marks the directory even though no timer ran for it: the clock
  // passes it, and the show clears the interval before a late callback can.
  it("(poll tick) reads for a confirmation in a shown window when a poll tick came due while hidden, though no timer ran for it and an earlier read followed the hide", async () => {
    const rig = await startedWindow(false, false);
    const hiddenAt = Date.now();
    __setBrowserDocumentHiddenForTests(true);
    // A read starts while hidden, after the hide's mark, and settles.
    vi.setSystemTime(hiddenAt + 10_000);
    void rig.directory.refresh();
    expect(rig.reads.issued()).toBe(2);
    rig.reads.answer(1, "row-r");
    await drain();
    // The poll's tick comes due; the clock passes it and no timer runs.
    vi.setSystemTime(hiddenAt + 60_000 + 1);
    // The show reads once, as the poll does on a show.
    __setBrowserDocumentHiddenForTests(false);
    expect(rig.reads.issued()).toBe(3);

    const confirmation = rig.confirm();
    await drain();

    expect(confirmation.resolved()).toBe(false);
    expect(rig.reads.issued()).toBe(3);

    rig.reads.answer(2, "row-after-tick");
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["row-after-tick"]);
    expect(rig.reads.mostAtOnce()).toBe(1);
  });

  // The wall clock can move back while a window is hidden. Vitest's fake timers
  // fake `performance.now()` too, and `setSystemTime` moves only the wall
  // clock, so a tick that came due on the monotonic clock is erased from the
  // wall clock alone.
  it("(poll tick, wall clock set back) still waits for the show's read when the wall clock was set back after a poll interval had passed hidden", async () => {
    const rig = await startedWindow(false, false);
    const hiddenAt = Date.now();
    __setBrowserDocumentHiddenForTests(true);
    // A read starts while hidden, after the hide, and settles with the personal row.
    await vi.advanceTimersByTimeAsync(10_000);
    void rig.directory.refresh();
    expect(rig.reads.issued()).toBe(2);
    rig.reads.answer(1, "personal-row");
    await drain();
    // The window stays hidden past a poll interval; then the wall clock is set
    // back, before the show.
    await vi.advanceTimersByTimeAsync(51_000);
    vi.setSystemTime(hiddenAt - 3_600_000);
    // The computer moved to a team meanwhile. The show reads once, as the poll
    // does on a show, and that read is the one that carries the team row.
    __setBrowserDocumentHiddenForTests(false);
    expect(rig.reads.issued()).toBe(3);

    const confirmation = rig.confirm();
    await drain();

    expect(confirmation.resolved()).toBe(false);
    expect(rig.reads.issued()).toBe(3);

    rig.reads.answer(2, "team-row");
    await drain();

    expect(confirmation.resolved()).toBe(true);
    expect(await rig.rowIds()).toEqual(["team-row"]);
    expect(rig.reads.mostAtOnce()).toBe(1);
  });
});
