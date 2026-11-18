import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import {
  advanceLegendListTime,
  installLegendListTestClock,
} from "@/components/chat/__tests__/legend-list-test-environment";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentStatusResponseV13,
  SetupAttempt,
} from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { MoveProgressDialog } from "@/components/settings/move/move-progress-dialog";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMoveProgressDialogStore } from "@/stores/settings/move-progress-dialog-store";

const HOST_ID = "8f0c2a4e-5b1d-4c3e-9a7f-1e2d3c4b5a60";
const ENVIRONMENT_ID = "env-personal";
const ATTEMPT_ID = "a7b8c9d0-e1f2-4a3b-8c5d-6e7f8091a2b3";
const ACCEPTANCE_ID = "c3d4e5f6-0718-4a29-8b3c-4d5e6f708192";
const PERSONAL_DIRECTORY: EnvironmentDirectoryResult = {
  kind: "ok",
  list: {
    environments: [
      {
        environmentId: ENVIRONMENT_ID,
        ownerKind: "user",
        ownerId: "user-me",
        roomId: "room-personal",
        label: "Personal",
      },
    ],
  },
};

const fixtureMock = vi.hoisted(
  (): {
    client: HostClient<HostRpcRegistry> | null;
    binding: {
      auth: unknown;
      directory: { refresh: () => Promise<void> };
    } | null;
  } => ({
    client: null,
    binding: null,
  }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => fixtureMock.client,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => fixtureMock.binding };
});
// The Details drawer has its own suite; the dialog only needs its button and
// the subject Export diagnostics opens it for, or none: a build with no pool
// has no binding answer.
interface DetailsSubjectFixture {
  readonly environmentId: string;
  readonly kind: "host_settings";
  readonly key: string;
}
const BOUND_SUBJECT: DetailsSubjectFixture = {
  environmentId: "env-personal",
  kind: "host_settings",
  key: "details-subject",
};
const detailsMock = vi.hoisted(
  (): { subject: DetailsSubjectFixture | null } => ({ subject: null }),
);
vi.mock(
  "@/components/settings/details/use-host-settings-details-subject",
  () => ({ useHostSettingsDetailsSubject: () => detailsMock.subject }),
);
vi.mock("@/components/settings/details/settings-details-button", () => ({
  SettingsDetailsButton: () => <button type="button">Details</button>,
  SettingsDetailsDialog: (props: {
    readonly open: boolean;
    readonly initialTab: string;
  }) =>
    props.open ? (
      <div data-testid="details-dialog" data-tab={props.initialTab} />
    ) : null,
}));
// Whether this build reads host bindings from the pool: the no-binding export
// stands in only where it does not.
const poolMock = vi.hoisted((): { readsPool: boolean } => ({
  readsPool: false,
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/bots/use-host-environment-bindings-query")
    >()),
    readsHostBindingsFromPool: () => poolMock.readsPool,
  }),
);
// The file a no-binding export saves, observed where it leaves the app.
const saveMock = vi.hoisted(() => ({
  saveBlobToDisk:
    vi.fn<
      (blob: Blob, suggestedName: string, fileSave: unknown) => Promise<null>
    >(),
}));
vi.mock("@/lib/files/save-blob-to-disk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/files/save-blob-to-disk")>()),
  saveBlobToDisk: saveMock.saveBlobToDisk,
}));

const LOCAL_PLANES = {
  records: "local",
  broker: "local",
  room: "local",
} as const;
const MOVE_ATTEMPT = {
  attemptId: ATTEMPT_ID,
  acceptanceId: ACCEPTANCE_ID,
} as const;

/** The computer's status while its accepted move runs: `applied` of `total` items done. */
function movingStatus(
  applied: number,
  total: number,
): EnvironmentStatusResponseV13 {
  return environmentStatusFixture({
    planes: LOCAL_PLANES,
    setup: { stage: "moving_settings", state: "running" },
    move: { ...MOVE_ATTEMPT, state: "running" },
    items: Array.from({ length: total }, (_, index) =>
      itemStatusFixture({
        kind: "variable",
        key: `ITEM_${String(index)}`,
        status: index < applied ? "applied" : "pending",
      }),
    ),
  });
}

/** A move that stopped with one of three items applied. */
function stoppedStatus(
  state: "stalled" | "failed",
): EnvironmentStatusResponseV13 {
  return environmentStatusFixture({
    planes: LOCAL_PLANES,
    setup: { stage: "moving_settings", state },
    move: { ...MOVE_ATTEMPT, state: "retry", cause: "unavailable" },
    items: [
      itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
      itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
      itemStatusFixture({ kind: "variable", key: "C", status: "pending" }),
    ],
  });
}

/** The finished move on a connected computer: no Local row left, the accepted move on record, one reported item per entry of `itemStatuses`. */
function movedStatusOf(
  itemStatuses: readonly ("applied" | "pending")[],
): EnvironmentStatusResponseV13 {
  return environmentStatusFixture({
    consent: { acceptedAt: Date.UTC(2026, 9, 20, 12), planHash: "hash-1" },
    setup: { stage: "done", state: "done" },
    move: { ...MOVE_ATTEMPT, state: "done" },
    reachability: "connected",
    items: itemStatuses.map((status, index) =>
      itemStatusFixture({
        kind: "variable",
        key: `ITEM_${String(index)}`,
        status,
      }),
    ),
  });
}

/** `applied` of `total` item statuses, applied ones first. */
function itemStatusesOf(
  applied: number,
  total: number,
): readonly ("applied" | "pending")[] {
  return Array.from({ length: total }, (_, index) =>
    index < applied ? "applied" : "pending",
  );
}

/** The finished move with every reported item applied and one upload still pending. */
function movedStatusWithPendingUpload(): EnvironmentStatusResponseV13 {
  return {
    ...movedStatusOf(itemStatusesOf(3, 3)),
    pendingUploads: [
      pendingUploadFixture({ kind: "variable", key: "PENDING" }),
    ],
  };
}

/** The finished move with all three items applied. */
function movedStatus(): EnvironmentStatusResponseV13 {
  return movedStatusOf(["applied", "applied", "applied"]);
}

/** A computer at rest on its own settings, the status the Overview card reads as `local`. */
function localStatus(): EnvironmentStatusResponseV13 {
  return environmentStatusFixture({ planes: LOCAL_PLANES });
}

/** What the computer answers `environment.status` with; a test changes it to move the computer along. */
interface StatusFeed {
  answer: EnvironmentStatusResponseV13;
  attempts: readonly SetupAttempt[];
  /** While set, a status request waits on it before the computer answers. */
  hold: Promise<void> | null;
}

interface Harness {
  readonly feed: StatusFeed;
  readonly queryClient: QueryClient;
  /** How many times the dialog has asked the computer for its status. */
  readonly statusReads: () => number;
  /** The fake clock's time at each status request, in order. */
  readonly statusReadTimes: () => readonly number[];
  /** The params of every request the dialog sent for `method`. */
  readonly requests: (method: string) => readonly unknown[];
  /** Every method the dialog asked the computer, in order. */
  readonly methods: () => readonly string[];
}

/** The dialog over a computer that answers `answer`, closed until {@link openDialog}. */
function mount(answer: EnvironmentStatusResponseV13): Harness {
  return mountOn(
    answer,
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    }),
  );
}

function mountOn(
  answer: EnvironmentStatusResponseV13,
  queryClient: QueryClient,
): Harness {
  const feed: StatusFeed = { answer, attempts: [], hold: null };
  const statusReadTimes: number[] = [];
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () => {
        statusReadTimes.push(Date.now());
        return feed.hold === null
          ? feed.answer
          : feed.hold.then(() => feed.answer);
      },
      "environment.setup.retry": () => ({ attemptId: "retry-1" }),
      "environment.setup.attempts": () => ({ attempts: [...feed.attempts] }),
    },
  });
  const authn = fakeEnvironmentCloud((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`))
      return { status: 200, body: { hosts: [{ purgePending: false }] } };
    throw new Error(
      `Unexpected environment request: ${request.method} ${path}`,
    );
  });
  fixtureMock.client = client;
  fixtureMock.binding = {
    auth: {
      environmentCloud: () => authn.cloud,
      listEnvironments: () => Promise.resolve(PERSONAL_DIRECTORY),
    },
    directory: { refresh: () => Promise.resolve() },
  };
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-me", username: "user" },
    shareableTeams: [],
  });
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 3 },
    "environment.setup.retry": { major: 1, minor: 0 },
    "environment.setup.attempts": { major: 1, minor: 0 },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MoveProgressDialog />
    </QueryClientProvider>,
  );
  return {
    feed,
    queryClient,
    statusReads: () =>
      messenger.calls.filter((call) => call.method === "environment.status")
        .length,
    statusReadTimes: () => statusReadTimes,
    requests: (method) =>
      messenger.calls
        .filter((call) => call.method === method)
        .map((call) => call.params),
    methods: () => messenger.calls.map((call) => call.method),
  };
}

function openDialog(): void {
  act(() => {
    useMoveProgressDialogStore
      .getState()
      .openDialog({ hostId: HOST_ID, hostName: "Old laptop" });
  });
}

async function advance(ms: number): Promise<void> {
  await advanceLegendListTime(ms);
}

/** Advances in 100 ms steps, so each read settles before the next tick. */
async function advanceInSteps(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await advance(100);
  }
}

/**
 * The next status read: the move's poll lane asks again within 500 ms to 2 s,
 * and a settled read reaches the render through the query notifier's
 * zero-delay timer, which the fake clock runs a millisecond later.
 */
async function deliverNextStatusRead(): Promise<void> {
  await advance(2_000);
  await advance(1);
}

/** Lets the dialog's pending status read land and render. */
async function settle(): Promise<void> {
  await advance(50);
}

/** One retry attempt that stopped, as the computer serves it. */
const STOPPED_ATTEMPT: SetupAttempt = {
  attemptId: "retry-1",
  scriptHash: "hash-of-the-script",
  itemRevision: 1,
  trigger: "retry",
  startedAt: 1_000,
  endedAt: 2_000,
  exitStatus: 1,
  stageReached: "applying",
  result: "failed",
};

const ANY_EXPORT_TIME: unknown = expect.any(Number);

/** What the export holds for {@link stoppedStatus}("failed") and {@link STOPPED_ATTEMPT}. */
const EXPECTED_DIAGNOSTICS = {
  version: 1,
  exportedAt: ANY_EXPORT_TIME,
  setup: { stage: "moving_settings", state: "failed" },
  stopReason: "it couldn't finish",
  items: { applied: 1, total: 3 },
  pendingUploads: 0,
  attempts: [
    {
      attemptId: "retry-1",
      trigger: "retry",
      itemRevision: 1,
      startedAt: 1_000,
      endedAt: 2_000,
      exitStatus: 1,
      stageReached: "applying",
      result: "failed",
    },
  ],
};

/** The one file the export saved: its name and its text. */
async function savedDiagnostics(): Promise<{
  readonly name: string;
  readonly text: string;
}> {
  await waitFor(() => expect(saveMock.saveBlobToDisk).toHaveBeenCalledOnce());
  const call = saveMock.saveBlobToDisk.mock.calls.at(0);
  if (call === undefined) throw new Error("nothing was saved");
  return { name: call[1], text: await call[0].text() };
}

function closeDialog(): void {
  act(() => {
    useMoveProgressDialogStore.getState().closeDialog();
  });
}

function dialogIsGone(): boolean {
  return (
    screen.queryByTestId("move-progress-dialog") === null &&
    useMoveProgressDialogStore.getState().target === null
  );
}

beforeEach(() => {
  installLegendListTestClock();
  focusManager.setFocused(true);
  useMoveProgressDialogStore.setState({ target: null });
  detailsMock.subject = BOUND_SUBJECT;
  poolMock.readsPool = false;
  saveMock.saveBlobToDisk.mockReset();
  saveMock.saveBlobToDisk.mockResolvedValue(null);
});

afterEach(() => {
  focusManager.setFocused(undefined);
  cleanup();
  resetNegotiatedManifests();
  fixtureMock.client = null;
  fixtureMock.binding = null;
  useAuthStore.getState().setSignedOut();
});

describe("<MoveProgressDialog />", () => {
  it("shows the moving view without a count and with an unmeasured bar while the computer has no item to report", async () => {
    mount(movingStatus(0, 0));
    openDialog();

    // Before the computer's status arrives, the accept was taken.
    expect(screen.getByText("Moving Old laptop to Personal")).toBeTruthy();
    expect(
      screen.getByTestId("move-progress-dialog-progress").textContent,
    ).toBe("Moving this computer's settings to Personal");
    expect(screen.getByTestId("update-progress-indeterminate")).toBeTruthy();

    await settle();

    // Details renders only once a status is in: the read landed.
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(
      screen.getByTestId("move-progress-dialog-progress").textContent,
    ).toBe("Moving this computer's settings to Personal");
    expect(screen.getByTestId("update-progress-indeterminate")).toBeTruthy();
    expect(
      screen.getByText(
        "This computer keeps its own settings until the move finishes.",
      ),
    ).toBeTruthy();
  });

  it("shows an unmeasured bar and never counts the items in words, as the computer applies more", async () => {
    const harness = mount(movingStatus(1, 3));
    openDialog();
    await settle();

    expect(
      screen.getByTestId("move-progress-dialog-progress").textContent,
    ).toBe("Moving this computer's settings to Personal");
    expect(screen.queryByText(/items applied/)).toBeNull();
    expect(screen.getByTestId("update-progress-indeterminate")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

    harness.feed.answer = movingStatus(3, 3);
    await deliverNextStatusRead();

    expect(screen.queryByText(/items applied/)).toBeNull();
    expect(screen.getByTestId("update-progress-indeterminate")).toBeTruthy();
  });

  it("says nothing of items while the move runs, after the switch lists Personal's items", async () => {
    const harness = mount(movingStatus(1, 3));
    openDialog();
    await settle();

    harness.feed.answer = movingStatus(23, 45);
    await deliverNextStatusRead();

    expect(
      screen.getByTestId("move-progress-dialog-progress").textContent,
    ).toBe("Moving this computer's settings to Personal");
    expect(screen.queryByText(/items applied/)).toBeNull();
  });

  it("closes on Close while the move runs and asks the computer nothing about the move", async () => {
    const harness = mount(movingStatus(1, 3));
    openDialog();
    await settle();

    fireEvent.click(screen.getByTestId("move-progress-dialog-close"));
    await advance(10_000);

    expect(dialogIsGone()).toBe(true);
    expect(
      harness
        .methods()
        .filter((method) => /^environment\.(move|setup)\./.test(method)),
    ).toEqual([]);
  });

  it("closes once the computer, seen moving, reads as on its own settings again, without asking it anything about the move", async () => {
    const harness = mount(movingStatus(1, 3));
    openDialog();
    await settle();
    expect(screen.getByTestId("move-progress-dialog-progress")).toBeTruthy();

    harness.feed.answer = localStatus();
    await deliverNextStatusRead();

    expect(dialogIsGone()).toBe(true);
    expect(
      harness
        .methods()
        .filter((method) => /^environment\.(move|setup)\./.test(method)),
    ).toEqual([]);
  });

  it("keeps the moving view on a computer that reads as on its own settings before any move has been seen", async () => {
    mount(localStatus());
    openDialog();
    await settle();
    await advance(10_000);

    expect(screen.getByText("Moving Old laptop to Personal")).toBeTruthy();
    expect(
      screen.getByTestId("move-progress-dialog-progress").textContent,
    ).toBe("Moving this computer's settings to Personal");
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
  });

  describe("when the move finishes", () => {
    it("turns to the done view, with Done, and no count while Personal lists more items than are applied", async () => {
      const harness = mount(movingStatus(2, 3));
      openDialog();
      await settle();
      expect(screen.getByTestId("move-progress-dialog-progress")).toBeTruthy();

      harness.feed.answer = movedStatusOf(itemStatusesOf(23, 45));
      await deliverNextStatusRead();

      expect(screen.getByText("Old laptop is on Personal")).toBeTruthy();
      expect(screen.queryByTestId("move-progress-dialog-progress")).toBeNull();
      expect(screen.queryByText(/items applied/)).toBeNull();
      expect(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      ).toBe("100");
      expect(
        screen.getByText(
          "It uses Personal's settings from now. This closes by itself.",
        ),
      ).toBeTruthy();
      expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    });

    it("counts every item at once when all of them are applied at the first read", async () => {
      mount(movedStatusOf(itemStatusesOf(45, 45)));
      openDialog();
      await settle();

      expect(
        screen.getByTestId("move-progress-dialog-done-count").textContent,
      ).toBe("45 of 45 items applied");
    });

    it.each([
      ["a computer with no items", movedStatusOf([])],
      ["an upload still pending", movedStatusWithPendingUpload()],
    ] as const)("shows no count for %s", async (_name, status) => {
      mount(status);
      openDialog();
      await settle();

      expect(screen.getByText("Old laptop is on Personal")).toBeTruthy();
      expect(screen.queryByText(/items applied/)).toBeNull();
    });

    it("reads again at about half a second and shows the count once every item is applied, then reads no more", async () => {
      const harness = mount(movedStatusOf(itemStatusesOf(23, 45)));
      openDialog();
      await settle();
      expect(screen.queryByText(/items applied/)).toBeNull();

      harness.feed.answer = movedStatusOf(itemStatusesOf(45, 45));
      const before = harness.statusReads();
      await advance(400);
      expect(harness.statusReads()).toBe(before);
      expect(screen.queryByText(/items applied/)).toBeNull();

      await advance(200);
      expect(
        screen.getByTestId("move-progress-dialog-done-count").textContent,
      ).toBe("45 of 45 items applied");

      const shown = harness.statusReads();
      await advance(2_000);
      expect(harness.statusReads()).toBe(shown);
    });

    it("never has two status reads in flight: it waits for an unanswered one", async () => {
      const harness = mount(movedStatusOf(itemStatusesOf(23, 45)));
      openDialog();
      await settle();

      let release: () => void = () => undefined;
      harness.feed.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const before = harness.statusReads();
      await advance(600);
      expect(harness.statusReads()).toBe(before + 1);

      await advance(2_000);
      expect(harness.statusReads()).toBe(before + 1);

      harness.feed.hold = null;
      release();
      await advance(600);
      expect(harness.statusReads()).toBeGreaterThan(before + 1);
    });

    it("reads seven more times while the count stays short, the last at three and a half seconds, and none after it closes", async () => {
      const harness = mount(movedStatusOf(itemStatusesOf(23, 45)));
      openDialog();
      await settle();
      const before = harness.statusReads();

      await advanceInSteps(3_400);
      expect(dialogIsGone()).toBe(false);
      expect(harness.statusReads()).toBe(before + 6);

      await advanceInSteps(200);
      expect(dialogIsGone()).toBe(false);
      expect(harness.statusReads()).toBe(before + 7);

      await advanceInSteps(600);
      expect(dialogIsGone()).toBe(true);
      expect(harness.statusReads()).toBe(before + 7);

      await advance(10_000);
      expect(harness.statusReads()).toBe(before + 7);
    });

    it("starts no read later than three and a half seconds after the finish when the count line hides again", async () => {
      const harness = mount(movedStatusOf(itemStatusesOf(23, 45)));
      openDialog();
      await settle();

      // The line shows at 1.5 s, which stops the re-reads.
      await advanceInSteps(1_200);
      harness.feed.answer = movedStatusOf(itemStatusesOf(45, 45));
      await advanceInSteps(750);
      expect(
        screen.getByTestId("move-progress-dialog-done-count"),
      ).toBeTruthy();

      // A read of the computer's own at 3.25 s hides it, so the re-reads
      // start again at 3.75 s, off their grid and before the close.
      await advanceInSteps(1_250);
      harness.feed.answer = movedStatusOf(itemStatusesOf(23, 45));
      void harness.queryClient.invalidateQueries();
      await advanceInSteps(100);
      expect(screen.queryByText(/items applied/)).toBeNull();
      await advanceInSteps(500);

      expect(dialogIsGone()).toBe(false);
      const [finishedAt, ...later] = harness.statusReadTimes();
      expect(Math.max(...later) - finishedAt).toBeLessThanOrEqual(3_500);
    });

    it("reads no more once the view has closed itself", async () => {
      const harness = mount(movedStatusOf(itemStatusesOf(23, 45)));
      openDialog();
      await settle();
      expect(harness.statusReads()).toBeGreaterThan(0);

      await advance(4_200);
      expect(dialogIsGone()).toBe(true);
      const atClose = harness.statusReads();

      await advance(10_000);
      expect(harness.statusReads()).toBe(atClose);
    });

    it.each([
      ["with the count line", movedStatusOf(itemStatusesOf(45, 45))],
      ["without it", movedStatusOf(itemStatusesOf(23, 45))],
    ] as const)(
      "closes itself after four seconds %s",
      async (_name, status) => {
        mount(status);
        openDialog();
        await settle();
        expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();

        await advance(3_800);
        expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();

        await advance(400);
        expect(dialogIsGone()).toBe(true);
      },
    );

    it.each([
      [
        "Done",
        () => fireEvent.click(screen.getByTestId("move-progress-dialog-done")),
      ],
      [
        "Escape",
        () =>
          fireEvent.keyDown(screen.getByTestId("move-progress-dialog"), {
            key: "Escape",
          }),
      ],
    ] as const)(
      "closes at once on %s, and leaves nothing behind that closes a later dialog",
      async (_name, closeEarly) => {
        const harness = mount(movedStatus());
        openDialog();
        await settle();
        await advance(1_000);

        closeEarly();
        expect(dialogIsGone()).toBe(true);

        // The same computer's next move opens the dialog again, running.
        harness.feed.answer = movingStatus(0, 3);
        openDialog();
        await advance(5_000);

        expect(
          screen.getByTestId("move-progress-dialog-progress"),
        ).toBeTruthy();
      },
    );
  });

  describe("when the move stops", () => {
    it.each([
      ["stalled", "Moving stopped: it timed out. 2 items left."],
      ["failed", "Moving stopped: it couldn't finish. 2 items left."],
    ] as const)(
      "stays open with the stopped words, Retry and Export diagnostics when it %s",
      async (state, line) => {
        const harness = mount(movingStatus(1, 3));
        openDialog();
        await settle();

        harness.feed.answer = stoppedStatus(state);
        await deliverNextStatusRead();
        await advance(10_000);

        expect(screen.getByText("Moving Old laptop to Personal")).toBeTruthy();
        expect(
          screen.getByTestId("move-progress-dialog-stopped").textContent,
        ).toBe(line);
        expect(
          screen.getByText(
            "This computer is still on its own settings. Retry applies nothing twice.",
          ),
        ).toBeTruthy();
        const dialog = screen.getByTestId("move-progress-dialog");
        expect(
          within(dialog).getByRole("button", { name: "Export diagnostics" }),
        ).toBeTruthy();
        expect(
          within(dialog).getByRole("button", { name: "Close" }),
        ).toBeTruthy();
        expect(
          within(dialog)
            .getByRole("button", { name: "Retry" })
            .getAttribute("data-variant"),
        ).toBe("default");
        expect(
          within(dialog).queryByRole("button", { name: "Details" }),
        ).toBeNull();
        expect(
          screen.queryByTestId("move-progress-dialog-progress"),
        ).toBeNull();
      },
    );

    it("sends environment.setup.retry once from Retry and stays open", async () => {
      const harness = mount(stoppedStatus("stalled"));
      openDialog();
      await settle();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(harness.requests("environment.setup.retry")).toEqual([{}]),
      );
      await settle();

      expect(harness.requests("environment.setup.retry")).toEqual([{}]);
      expect(screen.getByTestId("move-progress-dialog-stopped")).toBeTruthy();
    });

    it("closes on Close without retrying", async () => {
      const harness = mount(stoppedStatus("failed"));
      openDialog();
      await settle();

      fireEvent.click(screen.getByTestId("move-progress-dialog-close"));
      await advance(10_000);

      expect(dialogIsGone()).toBe(true);
      expect(harness.requests("environment.setup.retry")).toEqual([]);
    });
  });

  describe("Export diagnostics on a computer with no binding", () => {
    beforeEach(() => {
      detailsMock.subject = null;
    });

    it("saves the move's own diagnostics file with exactly the allowed keys", async () => {
      const harness = mount(stoppedStatus("failed"));
      harness.feed.attempts = [STOPPED_ATTEMPT];
      openDialog();
      await settle();

      fireEvent.click(
        screen.getByRole("button", { name: "Export diagnostics" }),
      );
      const saved = await savedDiagnostics();

      expect(saved.name).toBe("traycer-move-diagnostics.json");
      expect(JSON.parse(saved.text)).toEqual(EXPECTED_DIAGNOSTICS);
      expect(screen.queryByTestId("details-dialog")).toBeNull();
      expect(screen.getByTestId("move-progress-dialog-stopped")).toBeTruthy();
    });

    it("leaves the attempts out as null on a computer that does not serve them", async () => {
      mount(stoppedStatus("failed"));
      recordNegotiatedHostManifest(HOST_ID, {
        "environment.status": { major: 1, minor: 3 },
        "environment.setup.retry": { major: 1, minor: 0 },
      });
      openDialog();
      await settle();

      fireEvent.click(
        screen.getByRole("button", { name: "Export diagnostics" }),
      );
      const saved = await savedDiagnostics();

      expect(JSON.parse(saved.text)).toEqual({
        ...EXPECTED_DIAGNOSTICS,
        attempts: null,
      });
    });

    it("says why when the file could not be saved, stays open, and clears the line on a save that works", async () => {
      saveMock.saveBlobToDisk.mockRejectedValueOnce(new Error("disk full"));
      mount(stoppedStatus("failed"));
      openDialog();
      await settle();

      fireEvent.click(
        screen.getByRole("button", { name: "Export diagnostics" }),
      );

      expect((await screen.findByRole("alert")).textContent).toBe("disk full");
      expect(screen.getByTestId("move-progress-dialog-stopped")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

      fireEvent.click(
        screen.getByRole("button", { name: "Export diagnostics" }),
      );
      await waitFor(() =>
        expect(saveMock.saveBlobToDisk).toHaveBeenCalledTimes(2),
      );

      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(screen.getByTestId("move-progress-dialog-stopped")).toBeTruthy();
    });

    it("carries nothing a served status or attempt holds beyond the allowed keys", async () => {
      const served = {
        ...stoppedStatus("failed"),
        token: "SECRET-STATUS-TOKEN",
        items: [
          {
            ...itemStatusFixture({
              kind: "variable",
              key: "OPENAI_API_KEY",
              status: "applied",
            }),
            apiKey: "SECRET-ITEM-KEY",
          },
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
          itemStatusFixture({ kind: "variable", key: "C", status: "pending" }),
        ],
      };
      const attempt = {
        ...STOPPED_ATTEMPT,
        apiKey: "SECRET-ATTEMPT-KEY",
        token: "SECRET-ATTEMPT-TOKEN",
      };
      const harness = mount(served);
      harness.feed.attempts = [attempt];
      openDialog();
      await settle();

      fireEvent.click(
        screen.getByRole("button", { name: "Export diagnostics" }),
      );
      const saved = await savedDiagnostics();

      expect(saved.text).not.toContain("SECRET");
      expect(saved.text).not.toContain("OPENAI_API_KEY");
      expect(saved.text).not.toContain("hash-of-the-script");
      expect(JSON.parse(saved.text)).toEqual(EXPECTED_DIAGNOSTICS);
    });
  });

  describe("reopened over the status an earlier opening cached", () => {
    /** The app's own cache, which keeps a closed dialog's status for minutes and calls it fresh for a minute. */
    function mountWithAppCache(cached: EnvironmentStatusResponseV13): Harness {
      return mountOn(cached, createAppQueryClient());
    }

    it("shows the moving view, not the stopped view or Retry, until a status answers after the reopen", async () => {
      const harness = mountWithAppCache(stoppedStatus("failed"));
      openDialog();
      await settle();
      expect(screen.getByTestId("move-progress-dialog-stopped")).toBeTruthy();
      closeDialog();
      await settle();

      let release = (): void => undefined;
      harness.feed.hold = new Promise((resolve) => {
        release = resolve;
      });
      openDialog();
      await advance(10_000);

      expect(screen.getByText("Moving Old laptop to Personal")).toBeTruthy();
      expect(screen.queryByTestId("move-progress-dialog-stopped")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

      release();
      await settle();

      expect(screen.getByTestId("move-progress-dialog-stopped")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("shows neither the done view nor closes itself until a status answers after the reopen", async () => {
      const harness = mountWithAppCache(movedStatus());
      openDialog();
      await settle();
      expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();
      closeDialog();
      await settle();

      let release = (): void => undefined;
      harness.feed.answer = movingStatus(1, 3);
      harness.feed.hold = new Promise((resolve) => {
        release = resolve;
      });
      openDialog();
      await advance(10_000);

      expect(screen.getByText("Moving Old laptop to Personal")).toBeTruthy();
      expect(screen.queryByTestId("move-progress-dialog-done")).toBeNull();
      expect(dialogIsGone()).toBe(false);

      release();
      await settle();

      expect(screen.getByTestId("move-progress-dialog-progress")).toBeTruthy();
      expect(screen.queryByTestId("move-progress-dialog-done")).toBeNull();
    });
  });

  it("shows no Export diagnostics on a pool build with no binding answer", async () => {
    detailsMock.subject = null;
    poolMock.readsPool = true;
    mount(stoppedStatus("failed"));
    openDialog();
    await settle();

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Export diagnostics" }),
    ).toBeNull();
    expect(saveMock.saveBlobToDisk).not.toHaveBeenCalled();
  });

  it("opens the Details drawer at Export, and saves no file, on a bound computer", async () => {
    mount(stoppedStatus("failed"));
    openDialog();
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    await settle();

    expect(screen.getByTestId("details-dialog").dataset.tab).toBe("export");
    expect(saveMock.saveBlobToDisk).not.toHaveBeenCalled();
  });
});
