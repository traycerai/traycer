import {
  QueryClient,
  QueryClientProvider,
  focusManager,
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
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type {
  EnvironmentMovePlanResponseV20,
  EnvironmentMoveStageResponse,
  EnvironmentMoveStartRequest,
} from "@traycer/protocol/host/environment/move-contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import { MoveSheet } from "@/components/settings/move-sheet";
import { MOVE_DISCLOSURE_VERSION } from "@/components/settings/move-sheet-model";
import { TeamGiveDialog } from "@/components/settings/panels/team-give-dialog";
import {
  GIVE_PLAN,
  GIVE_TEAM_ID,
} from "@/components/settings/panels/__tests__/team-give-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useMoveProgressDialogStore } from "@/stores/settings/move-progress-dialog-store";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const HOST_ID = "8f0c2a4e-5b1d-4c3e-9a7f-1e2d3c4b5a60";
const ENVIRONMENT_ID = "env-personal";
const ATTEMPT_ID = "a7b8c9d0-e1f2-4a3b-8c5d-6e7f8091a2b3";
const ACCEPTANCE_ID = "c3d4e5f6-0718-4a29-8b3c-4d5e6f708192";
const MANIFEST_HASH = "c".repeat(64);
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
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: (): HostsRunningConfiguration => ({
      hosts: [],
      state: "ready",
      thisComputerUnread: false,
      collisions: [],
      retry: () => undefined,
      reread: () => undefined,
    }),
  }),
);

function planOf(
  planHash: string,
  moves: readonly string[],
): EnvironmentMovePlanResponseV20 {
  return {
    planHash,
    planRevision: 1,
    hostVersion: "1.5.0",
    disclosureVersion: MOVE_DISCLOSURE_VERSION,
    rows: {
      moves: moves.map((key) => ({
        kind: "variable",
        key,
        os: null,
        label: key,
        detail: null,
      })),
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
    },
    guideDiffers: false,
    personalHoldsSecrets: false,
  };
}

const STALE_PLAN = planOf("hash-stale", ["STALE_ONE", "STALE_TWO"]);
const FRESH_PLAN = planOf("hash-fresh", [
  "FRESH_ONE",
  "FRESH_TWO",
  "FRESH_THREE",
]);

function planRefusal(code: string, message: string): HostRpcError {
  return new HostRpcError({
    code,
    message,
    requestId: "plan-refused",
    method: "environment.move.plan",
    fatalDetails: null,
  });
}

const NOT_AWAITING = planRefusal(
  "E_MOVE_NOT_AWAITING",
  "No move is waiting for you to accept it.",
);

function stoppedStatus(): EnvironmentStatusResponseV13 {
  return environmentStatusFixture({
    setup: { stage: "moving_settings", state: "failed" },
    move: {
      state: "retry",
      cause: "unavailable",
      attemptId: ATTEMPT_ID,
      acceptanceId: ACCEPTANCE_ID,
    },
  });
}

function awaitingConsentStatus(): EnvironmentStatusResponseV13 {
  return environmentStatusFixture({
    setup: { stage: "moving_settings", state: "awaiting_consent" },
  });
}

/** What the computer answers; a test moves it along between reads. */
interface Computer {
  plan: EnvironmentMovePlanResponseV20;
  /** While set, every plan read is refused with it. */
  planFailure: Error | null;
  status: EnvironmentStatusResponseV13;
}

interface Harness {
  readonly computer: Computer;
  readonly queryClient: QueryClient;
  readonly planReads: () => number;
  readonly retries: () => number;
  readonly starts: EnvironmentMoveStartRequest[];
  readonly client: HostClient<HostRpcRegistry>;
}

function mountComputer(computer: Computer): Harness {
  const starts: EnvironmentMoveStartRequest[] = [];
  let retries = 0;
  let answered: EnvironmentMovePlanResponseV20 | null = null;
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.move.plan": () => {
        if (computer.planFailure !== null) throw computer.planFailure;
        answered = computer.plan;
        return computer.plan;
      },
      "environment.status": () => computer.status,
      "environment.setup.retry": () => {
        retries += 1;
        return { attemptId: "retry-attempt" };
      },
      "environment.move.stage": (request) => {
        if (answered === null)
          throw new Error("The plan must be read before staging.");
        return {
          evidence: {
            attemptId: ATTEMPT_ID,
            planHash: answered.planHash,
            planRevision: answered.planRevision,
            hostVersion: answered.hostVersion,
            itemCount: answered.rows.moves.length,
            keyChoices: request.keyChoices,
            sourceHostId: HOST_ID,
            sharingGeneration: 1,
            targetKind: "personal",
            environmentId: ENVIRONMENT_ID,
            disclosureVersion: answered.disclosureVersion,
          },
          authorization: { manifestHash: MANIFEST_HASH },
        } satisfies EnvironmentMoveStageResponse;
      },
      "environment.move.start": (request) => {
        starts.push(request);
        return {
          state: "running",
          attemptId: ATTEMPT_ID,
          acceptanceId: ACCEPTANCE_ID,
        };
      },
    },
  });
  const authn = fakeEnvironmentCloud((request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`))
      return { status: 200, body: { hosts: [{ purgePending: false }] } };
    if (path.endsWith("/move-acceptances"))
      return { status: 201, body: { acceptanceId: ACCEPTANCE_ID } };
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
    "environment.move.plan": { major: 2, minor: 0 },
    "environment.move.stage": { major: 1, minor: 0 },
    "environment.move.start": { major: 1, minor: 0 },
    "environment.status": { major: 1, minor: 3 },
    "environment.setup.retry": { major: 1, minor: 0 },
  });
  return {
    computer,
    client,
    queryClient: new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    }),
    planReads: () =>
      messenger.calls.filter((call) => call.method === "environment.move.plan")
        .length,
    retries: () => retries,
    starts,
  };
}

function mountSheet(computer: Computer): Harness {
  const harness = mountComputer(computer);
  render(
    <QueryClientProvider client={harness.queryClient}>
      <MoveSheet />
    </QueryClientProvider>,
  );
  act(() => {
    useMoveSheetStore
      .getState()
      .openSheet({ hostId: HOST_ID, hostName: "Old laptop" });
  });
  return harness;
}

const TEAM: EnvironmentDescriptorV11 = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: GIVE_TEAM_ID,
  roomId: "room-team",
  label: "Acme",
  effectiveRole: "admin",
  kind: "team",
  hostCount: 1,
  providerHandle: "handle-a",
};

function mountGiveDialog(computer: Computer): Harness {
  const harness = mountComputer(computer);
  render(
    <QueryClientProvider client={harness.queryClient}>
      <TeamGiveDialog
        client={harness.client}
        hostId={HOST_ID}
        hostName="Old laptop"
        currentEnvironmentId={null}
        team={TEAM}
        onClose={() => undefined}
        onGiven={() => undefined}
      />
    </QueryClientProvider>,
  );
  return harness;
}

/** Lets a pending read land and render. */
async function settle(): Promise<void> {
  await advanceLegendListTime(50);
}

/** The next poll of `environment.status` (every 5 s at rest), and its render. */
async function deliverNextStatusRead(): Promise<void> {
  await advanceLegendListTime(5_000);
  await advanceLegendListTime(1);
}

/** The plan is read again, as the app does when a cached read goes stale. */
async function rereadPlan(harness: Harness): Promise<void> {
  await act(async () => {
    await harness.queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes("environment.move.plan"),
    });
  });
  await settle();
}

function acceptButton(): HTMLElement {
  return screen.getByTestId("move-sheet-accept");
}

function acceptIsDisabled(): boolean {
  return acceptButton().hasAttribute("disabled");
}

function summaryText(): string | null {
  return screen.queryByTestId("move-sheet-moves-summary")?.textContent ?? null;
}

function planIsDrawn(): boolean {
  return (
    screen.queryByTestId("move-sheet-moves-summary") !== null ||
    screen.queryByTestId("move-sheet-nothing-to-move") !== null ||
    screen.queryByTestId("move-sheet-details") !== null
  );
}

beforeEach(() => {
  installLegendListTestClock();
  focusManager.setFocused(true);
  useMoveSheetStore.setState({ target: null });
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

describe("<MoveSheet /> after a refused plan read", () => {
  it("draws no plan and holds Move to Personal when the re-read is refused as not awaiting", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
    });
    await settle();
    expect(summaryText()).toBe("2 variables");
    expect(acceptIsDisabled()).toBe(false);

    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);

    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();
    expect(planIsDrawn()).toBe(false);
    expect(acceptIsDisabled()).toBe(true);
  });

  it.each([
    [
      "a generic host refusal",
      planRefusal("RPC_ERROR", "The computer took too long to answer."),
    ],
    ["a transport failure", new Error("The connection closed.")],
  ])(
    "draws no plan and holds Move to Personal when the re-read fails with %s",
    async (_name, failure) => {
      const harness = mountSheet({
        plan: STALE_PLAN,
        planFailure: null,
        status: awaitingConsentStatus(),
      });
      await settle();
      expect(summaryText()).toBe("2 variables");

      harness.computer.planFailure = failure;
      await rereadPlan(harness);

      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(planIsDrawn()).toBe(false);
      expect(acceptIsDisabled()).toBe(true);
    },
  );

  it("runs the stopped move again on Retry, then draws and accepts the fresh plan", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
    });
    await settle();
    harness.computer.status = stoppedStatus();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    const readsBeforeRetry = harness.planReads();
    expect(planIsDrawn()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(1);
    expect(harness.planReads()).toBe(readsBeforeRetry);
    expect(planIsDrawn()).toBe(false);
    expect(screen.getByTestId("move-sheet-loading")).toBeTruthy();
    expect(acceptIsDisabled()).toBe(true);

    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    harness.computer.status = awaitingConsentStatus();
    await deliverNextStatusRead();
    await settle();

    expect(summaryText()).toBe("3 variables");
    expect(acceptIsDisabled()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("FRESH_ONE")).toBeTruthy();
    expect(screen.queryByText("STALE_ONE")).toBeNull();

    fireEvent.click(acceptButton());
    await settle();

    expect(harness.starts).toEqual([
      {
        attemptId: ATTEMPT_ID,
        planHash: FRESH_PLAN.planHash,
        acceptanceId: ACCEPTANCE_ID,
      },
    ]);
  });

  it("only reads the plan again on Retry when the move is waiting for the person", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
    });
    await settle();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    const readsBeforeRetry = harness.planReads();
    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();

    harness.computer.planFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(0);
    expect(harness.planReads()).toBe(readsBeforeRetry + 1);
    expect(summaryText()).toBe("2 variables");
    expect(acceptIsDisabled()).toBe(false);
  });
});

describe("<TeamGiveDialog /> after a refused plan read", () => {
  it("holds Confirm at this computer when the re-read is refused", async () => {
    const harness = mountGiveDialog({
      plan: GIVE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
    });
    await settle();
    const confirm = (): HTMLElement =>
      screen.getByRole("button", { name: "Confirm at this computer" });
    expect(confirm().hasAttribute("disabled")).toBe(false);

    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);

    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();
    expect(confirm().hasAttribute("disabled")).toBe(true);
  });
});
