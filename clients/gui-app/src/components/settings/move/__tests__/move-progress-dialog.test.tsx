import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { MoveProgressDialog } from "@/components/settings/move/move-progress-dialog";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
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
// a subject for Export diagnostics.
vi.mock(
  "@/components/settings/details/use-host-settings-details-subject",
  () => ({
    useHostSettingsDetailsSubject: () => ({
      environmentId: "env-personal",
      kind: "host_settings",
      key: "details-subject",
    }),
  }),
);
vi.mock("@/components/settings/details/settings-details-button", () => ({
  SettingsDetailsButton: () => <button type="button">Details</button>,
  SettingsDetailsDialog: () => null,
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
}

interface Harness {
  readonly feed: StatusFeed;
  /** The params of every request the dialog sent for `method`. */
  readonly requests: (method: string) => readonly unknown[];
  /** Every method the dialog asked the computer, in order. */
  readonly methods: () => readonly string[];
}

/** The dialog over a computer that answers `answer`, closed until {@link openDialog}. */
function mount(answer: EnvironmentStatusResponseV13): Harness {
  const feed: StatusFeed = { answer };
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () => feed.answer,
      "environment.setup.retry": () => ({ attemptId: "retry-1" }),
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
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, gcTime: 0 },
            mutations: { retry: false },
          },
        })
      }
    >
      <MoveProgressDialog />
    </QueryClientProvider>,
  );
  return {
    feed,
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

  it("shows the items applied and a bar at their share, and follows the computer as it applies more", async () => {
    const harness = mount(movingStatus(1, 3));
    openDialog();
    await settle();

    expect(
      screen
        .getByTestId("move-progress-dialog-progress")
        .textContent.replace(/\s+/g, " "),
    ).toBe(
      "Moving this computer's settings to Personal · 1 of 3 items applied",
    );
    expect(
      Number(screen.getByRole("progressbar").getAttribute("aria-valuenow")),
    ).toBeCloseTo(33.3, 1);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();

    harness.feed.answer = movingStatus(3, 3);
    await deliverNextStatusRead();

    expect(
      screen
        .getByTestId("move-progress-dialog-progress")
        .textContent.replace(/\s+/g, " "),
    ).toBe(
      "Moving this computer's settings to Personal · 3 of 3 items applied",
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "100",
    );
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
    it("turns to the done view, with Done, once the computer reads as moved", async () => {
      const harness = mount(movingStatus(2, 3));
      openDialog();
      await settle();
      expect(screen.getByTestId("move-progress-dialog-progress")).toBeTruthy();

      harness.feed.answer = movedStatus();
      await deliverNextStatusRead();

      expect(screen.getByText("Old laptop is on Personal")).toBeTruthy();
      expect(screen.queryByTestId("move-progress-dialog-progress")).toBeNull();
      expect(
        screen.getByTestId("move-progress-dialog-done-count").textContent,
      ).toBe("3 of 3 items applied");
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

    it("counts the items the computer reports applied, not every item it reports", async () => {
      mount(movedStatusOf(["applied", "applied", "pending"]));
      openDialog();
      await settle();

      expect(
        screen.getByTestId("move-progress-dialog-done-count").textContent,
      ).toBe("2 of 3 items applied");
    });

    it.each([
      ["not connected yet", { ...movedStatus(), reachability: "reconnecting" }],
      ["not connected", { ...movedStatus(), reachability: "offline" }],
      ["connected with nothing to move", movedStatusOf([])],
    ] as const)(
      "shows the done view without a count when the computer is %s",
      async (_name, status) => {
        mount(status);
        openDialog();
        await settle();

        expect(screen.getByText("Old laptop is on Personal")).toBeTruthy();
        expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();
        expect(
          screen.queryByTestId("move-progress-dialog-done-count"),
        ).toBeNull();
      },
    );

    it("closes itself after four seconds", async () => {
      mount(movedStatus());
      openDialog();
      await settle();
      expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();

      await advance(3_900);
      expect(screen.getByTestId("move-progress-dialog-done")).toBeTruthy();

      await advance(200);
      expect(dialogIsGone()).toBe(true);
    });

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
});
