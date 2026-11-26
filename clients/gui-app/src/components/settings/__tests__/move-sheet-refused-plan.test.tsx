import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  type QueryKey,
} from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import {
  advanceLegendListTime,
  installLegendListTestClock,
  restoreLegendListTestClock,
} from "@/components/chat/__tests__/legend-list-test-environment";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { hostResponseErrorSchema } from "@traycer/protocol/framework/ws-protocol";
import {
  environmentSetupRetryResponseSchema,
  environmentStatusResponseSchemaV14,
  type EnvironmentStatusResponseV14,
} from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import {
  environmentMoveOutcomeAnswerSchema,
  environmentMovePersonalSchema,
  environmentMovePlanResponseSchemaV20,
  environmentMoveStageResponseSchema,
  type EnvironmentMovePlanResponseV20,
  type EnvironmentMoveStartRequest,
} from "@traycer/protocol/host/environment/move-contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { environmentQueryKeys } from "@/lib/query-keys";
import { fakeEnvironmentCloud } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import { MoveProgressDialog } from "@/components/settings/move/move-progress-dialog";
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
const ENVIRONMENT_ID = "env_01JA000000000000000000000A";
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

const STALE_PLAN = planOf("a".repeat(64), ["STALE_ONE", "STALE_TWO"]);
const FRESH_PLAN = planOf("b".repeat(64), [
  "FRESH_ONE",
  "FRESH_TWO",
  "FRESH_THREE",
]);

function planRefusal(code: RpcErrorCode, message: string): HostRpcError {
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

function stoppedStatus(): EnvironmentStatusResponseV14 {
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

function registeringStatus(): EnvironmentStatusResponseV14 {
  return environmentStatusFixture({
    setup: { stage: "registering", state: "running" },
  });
}

/** What the computer can read once a Retry has run the stopped move again. */
const RESUMED_STATUSES: readonly [string, EnvironmentStatusResponseV14][] = [
  [
    "running",
    environmentStatusFixture({
      setup: { stage: "moving_settings", state: "running" },
      move: {
        state: "running",
        attemptId: ATTEMPT_ID,
        acceptanceId: ACCEPTANCE_ID,
      },
    }),
  ],
  [
    "applying",
    environmentStatusFixture({
      setup: { stage: "applying", state: "running" },
      move: {
        state: "running",
        attemptId: ATTEMPT_ID,
        acceptanceId: ACCEPTANCE_ID,
      },
    }),
  ],
  [
    "already done",
    environmentStatusFixture({
      setup: { stage: "done", state: "done" },
      move: {
        state: "done",
        attemptId: ATTEMPT_ID,
        acceptanceId: ACCEPTANCE_ID,
      },
    }),
  ],
];

function awaitingConsentStatus(): EnvironmentStatusResponseV14 {
  return environmentStatusFixture({
    setup: { stage: "moving_settings", state: "awaiting_consent" },
  });
}

/** What the computer answers; a test moves it along between reads. */
interface Computer {
  plan: EnvironmentMovePlanResponseV20;
  /** While set, every plan read is refused with it. */
  planFailure: Error | null;
  status: EnvironmentStatusResponseV14;
  /** Whether the computer's handshake lists `environment.setup.retry`. */
  servesRetry: boolean;
}

interface Harness {
  readonly computer: Computer;
  readonly queryClient: QueryClient;
  readonly planReads: () => number;
  readonly retries: () => number;
  readonly statusReads: () => number;
  readonly stages: () => number;
  /** Holds the next status read unanswered until the returned function is called. */
  readonly holdNextStatusRead: () => () => void;
  /** Refuses the next status read; the one after it answers as usual. */
  readonly failNextStatusRead: () => void;
  /**
   * Holds the next plan read unanswered until the returned function is
   * called; the computer then answers with whatever it holds at that moment.
   */
  readonly holdNextPlanRead: () => () => void;
  readonly starts: EnvironmentMoveStartRequest[];
  readonly client: HostClient<HostRpcRegistry>;
  readonly refuseStage: (failure: HostRpcError) => void;
  readonly acceptancePosts: () => number;
}

function mountComputer(
  computer: Computer,
  queryClient: QueryClient,
  refusalOnly: boolean | undefined,
): Harness {
  let stageFailure: HostRpcError | null = null;
  const starts: EnvironmentMoveStartRequest[] = [];
  let retries = 0;
  let heldStatusRead: Promise<void> | null = null;
  let statusReadFails = false;
  let heldPlanRead: Promise<void> | null = null;
  let answered: EnvironmentMovePlanResponseV20 | null = null;
  const answerPlan = (): EnvironmentMovePlanResponseV20 => {
    if (computer.planFailure !== null) throw computer.planFailure;
    answered = environmentMovePlanResponseSchemaV20.parse(computer.plan);
    return answered;
  };
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.move.plan": () => {
        const held = heldPlanRead;
        heldPlanRead = null;
        return held === null ? answerPlan() : held.then(answerPlan);
      },
      "environment.status": () => {
        if (statusReadFails) {
          statusReadFails = false;
          throw new Error("The status read was refused.");
        }
        const asked = environmentStatusResponseSchemaV14.parse(computer.status);
        const held = heldStatusRead;
        heldStatusRead = null;
        return held === null ? asked : held.then(() => asked);
      },
      "environment.setup.retry": () => {
        retries += 1;
        return environmentSetupRetryResponseSchema.parse({
          attemptId: "retry-attempt",
        });
      },
      "environment.move.stage": (request) => {
        if (stageFailure !== null) throw stageFailure;
        if (answered === null)
          throw new Error("The plan must be read before staging.");
        return environmentMoveStageResponseSchema.parse({
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
        });
      },
      "environment.move.start": (request) => {
        starts.push(request);
        return environmentMoveOutcomeAnswerSchema.parse({
          state: "running",
          attemptId: ATTEMPT_ID,
          acceptanceId: ACCEPTANCE_ID,
        });
      },
    },
  });
  const authn = fakeEnvironmentCloud((request) => {
    const path = new URL(request.url).pathname;
    if (
      refusalOnly !== true &&
      request.method === "GET" &&
      path.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`)
    ) {
      return {
        status: 200,
        body: {
          hosts: [
            {
              hostId: HOST_ID,
              hostName: "Old laptop",
              hostKind: "personal",
              hostVersion: "1.5.0",
              bindingGeneration: 1,
              desiredRevision: 0,
              receivedRevision: 0,
              appliedRevision: 0,
              reportedAt: null,
              online: true,
              lastSeenAt: null,
              remoteAccess: { enabled: false, epoch: 0 },
              setupStage: null,
              purgePending: false,
              minimumHostVersion: null,
              localOverrides: [],
              items: [],
              setupAttempts: [],
            },
          ],
        },
      };
    }
    if (
      refusalOnly !== true &&
      request.method === "POST" &&
      path.endsWith("/move-acceptances")
    )
      return {
        status: 201,
        body: {
          acceptanceId: ACCEPTANCE_ID,
          expiresAt: "2026-01-01T00:10:00.000Z",
        },
      };
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
    ...(computer.servesRetry
      ? { "environment.setup.retry": { major: 1, minor: 0 } }
      : {}),
  });
  return {
    computer,
    client,
    queryClient,
    refuseStage: (failure) => {
      stageFailure = failure;
    },
    acceptancePosts: () =>
      authn.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/move-acceptances"),
      ).length,
    planReads: () =>
      messenger.calls.filter((call) => call.method === "environment.move.plan")
        .length,
    retries: () => retries,
    statusReads: () =>
      messenger.calls.filter((call) => call.method === "environment.status")
        .length,
    holdNextStatusRead: () => {
      const held = Promise.withResolvers<void>();
      heldStatusRead = held.promise;
      return () => held.resolve();
    },
    failNextStatusRead: () => {
      statusReadFails = true;
    },
    holdNextPlanRead: () => {
      const held = Promise.withResolvers<void>();
      heldPlanRead = held.promise;
      return () => held.resolve();
    },
    stages: () =>
      messenger.calls.filter((call) => call.method === "environment.move.stage")
        .length,
    starts,
  };
}

/** A cache that drops an entry once nothing reads it: a closed sheet keeps no answer. */
function shortLivedQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function mountSheet(computer: Computer): Harness {
  return mountSheetOn(computer, shortLivedQueryClient(), undefined);
}

function mountSheetOn(
  computer: Computer,
  queryClient: QueryClient,
  refusalOnly: boolean | undefined,
): Harness {
  const harness = mountComputer(computer, queryClient, refusalOnly);
  render(
    <QueryClientProvider client={harness.queryClient}>
      <MoveSheet />
      <MoveProgressDialog />
    </QueryClientProvider>,
  );
  openMoveSheet();
  return harness;
}

function openMoveSheet(): void {
  act(() => {
    useMoveSheetStore
      .getState()
      .openSheet({ hostId: HOST_ID, hostName: "Old laptop" });
  });
}

function closeMoveSheet(): void {
  act(() => {
    useMoveSheetStore.getState().closeSheet();
  });
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
  const harness = mountComputer(computer, shortLivedQueryClient(), undefined);
  renderGiveDialog(harness);
  return harness;
}

function renderGiveDialog(harness: Harness): void {
  render(
    <QueryClientProvider client={harness.queryClient}>
      <TeamGiveDialog
        client={harness.client}
        hostId={HOST_ID}
        hostName="Old laptop"
        currentEnvironmentId={null}
        team={TEAM}
        onClose={() => undefined}
        onStarted={() => undefined}
        onGiven={() => undefined}
      />
    </QueryClientProvider>,
  );
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

function isMovePlanKey(candidate: unknown): candidate is QueryKey {
  if (!Array.isArray(candidate)) return false;
  const key: readonly unknown[] = candidate;
  return key.includes("environment.move.plan");
}

/** The plan is read again, as the app does when a cached read goes stale. */
async function rereadPlan(harness: Harness): Promise<void> {
  await act(async () => {
    await harness.queryClient.invalidateQueries({
      predicate: (query) => isMovePlanKey(query.queryKey),
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

describe("Move's Keep wording for the target computer", () => {
  it.each([
    [true, "Keep on Old laptop only"],
    [false, "Leave on this computer only"],
  ] as const)(
    "follows the target's OwnSlots capability (%s)",
    async (supported, label) => {
      restoreLegendListTestClock();
      const queryClient = shortLivedQueryClient();
      queryClient.setQueryData(
        environmentQueryKeys.personalForMove("user-me"),
        environmentMovePersonalSchema.parse({ items: [], holdsSecrets: false }),
      );
      mountSheetOn(
        {
          plan: {
            ...STALE_PLAN,
            rows: {
              ...STALE_PLAN.rows,
              moves: [
                {
                  kind: "secret",
                  key: "OPENAI_API_KEY",
                  os: null,
                  label: "OPENAI_API_KEY",
                  detail: null,
                },
              ],
            },
          },
          planFailure: null,
          status: awaitingConsentStatus(),
          servesRetry: false,
        },
        queryClient,
        true,
      );
      act(() => {
        recordNegotiatedHostManifest(HOST_ID, {
          "environment.move.plan": { major: 2, minor: 0 },
          "environment.move.stage": { major: 1, minor: 0 },
          "environment.move.start": { major: 1, minor: 0 },
          "environment.status": { major: 1, minor: 4 },
          ...(supported
            ? { "environment.ownSlots": { major: 1, minor: 0 } }
            : {}),
        });
      });
      const details = Promise.withResolvers<void>();
      const check = () => {
        if (screen.queryByTestId("move-sheet-details") !== null)
          details.resolve();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        check();
        await details.promise;
      } finally {
        observer.disconnect();
      }

      fireEvent.click(screen.getByTestId("move-sheet-details"));
      const moving = screen.getByTestId("move-sheet-moves-row");
      const keep = within(moving).getByRole("button", { name: label });
      fireEvent.click(keep);
      const stayed = screen.getByTestId("move-sheet-left-here-row");
      const undo = within(stayed).getByRole("button", { name: label });
      fireEvent.click(undo);
      expect(screen.queryByTestId("move-sheet-left-here-row")).toBeNull();
    },
  );
});

const LOCAL_SOURCE_REFUSAL =
  "Couldn't read this computer's settings. Try again.";

function sourceRefusal(method: "plan" | "stage", code: string): HostRpcError {
  return HostRpcError.fromWireEnvelope(
    hostResponseErrorSchema.parse({ code, message: LOCAL_SOURCE_REFUSAL }),
    `refused-${method}`,
    `environment.move.${method}`,
  );
}

function mountLocalSourceSheet(
  planFailure: HostRpcError | null,
  queryClient: QueryClient,
  servesRetry: boolean | undefined,
): Harness {
  queryClient.setQueryData(
    environmentQueryKeys.personalForMove("user-me"),
    environmentMovePersonalSchema.parse({ items: [], holdsSecrets: false }),
  );
  return mountSheetOn(
    {
      plan: STALE_PLAN,
      planFailure,
      status: awaitingConsentStatus(),
      servesRetry: servesRetry === true,
    },
    queryClient,
    true,
  );
}

async function pressMove(harness: Harness): Promise<void> {
  const finished = Promise.withResolvers<void>();
  const unsubscribe = harness.queryClient
    .getMutationCache()
    .subscribe((event) => {
      if (
        event.type === "updated" &&
        (event.action.type === "success" || event.action.type === "error")
      ) {
        finished.resolve();
      }
    });
  try {
    await act(async () => {
      fireEvent.click(acceptButton());
      await finished.promise;
    });
  } finally {
    unsubscribe();
  }
  await settle();
}

async function retryLocalPlan(
  harness: Harness,
  terminal: "error" | "success",
): Promise<void> {
  const finished = Promise.withResolvers<void>();
  const unsubscribe = harness.queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === terminal &&
      isMovePlanKey(event.query.queryKey)
    ) {
      finished.resolve();
    }
  });
  try {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await finished.promise;
    });
  } finally {
    unsubscribe();
  }
  await settle();
}

async function retryStoppedSourceMove(): Promise<Harness> {
  const harness = mountLocalSourceSheet(
    sourceRefusal("plan", "E_MOVE_LOCAL_SOURCE_UNREAD"),
    shortLivedQueryClient(),
    true,
  );
  await settle();
  harness.computer.status = stoppedStatus();
  await deliverNextStatusRead();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await settle();
  expect(harness.retries()).toBe(1);
  return harness;
}

describe("<MoveSheet /> with unread computer settings", () => {
  it("shows the opening refusal without automatically retrying the plan", async () => {
    const harness = mountLocalSourceSheet(
      sourceRefusal("plan", "E_MOVE_LOCAL_SOURCE_UNREAD"),
      createAppQueryClient(),
      undefined,
    );
    await settle();

    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(acceptIsDisabled()).toBe(true);

    harness.computer.planFailure = null;
    await advanceLegendListTime(1_000);
    expect(harness.planReads()).toBe(1);
    expect(acceptIsDisabled()).toBe(true);
  });

  it("keeps the opening refusal after a background plan refresh until Retry", async () => {
    const harness = mountLocalSourceSheet(
      sourceRefusal("plan", "E_MOVE_LOCAL_SOURCE_UNREAD"),
      shortLivedQueryClient(),
      undefined,
    );
    await settle();
    expect(acceptIsDisabled()).toBe(true);

    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    const reads = harness.planReads();
    await rereadPlan(harness);

    expect(harness.planReads()).toBe(reads + 1);
    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    await retryLocalPlan(harness, "success");
    expect(summaryText()).toBe("3 variables");
    expect(acceptIsDisabled()).toBe(false);
  });

  it("keeps the source refusal when cancellation restores an earlier successful plan", async () => {
    const harness = mountLocalSourceSheet(
      sourceRefusal("plan", "E_MOVE_LOCAL_SOURCE_UNREAD"),
      shortLivedQueryClient(),
      undefined,
    );
    await settle();
    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    await rereadPlan(harness);
    expect(acceptIsDisabled()).toBe(true);

    const entered = Promise.withResolvers<QueryKey>();
    const finishCancelledRead = harness.holdNextPlanRead();
    const reads = harness.planReads();
    const unsubscribe = harness.queryClient
      .getQueryCache()
      .subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "fetch") return;
        const key: unknown = event.query.queryKey;
        if (isMovePlanKey(key)) entered.resolve(key);
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      const queryKey = await entered.promise;
      await settle();
      expect(harness.planReads()).toBe(reads + 1);
      await act(async () => {
        await harness.queryClient.cancelQueries({ queryKey, exact: true });
        finishCancelledRead();
      });
    } finally {
      unsubscribe();
    }
    await settle();

    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    await retryLocalPlan(harness, "success");
    expect(acceptIsDisabled()).toBe(false);
  });

  it("keeps the source refusal when active invalidation replaces the held Retry", async () => {
    const harness = mountLocalSourceSheet(
      sourceRefusal("plan", "E_MOVE_LOCAL_SOURCE_UNREAD"),
      shortLivedQueryClient(),
      undefined,
    );
    await settle();
    harness.computer.planFailure = null;
    await rereadPlan(harness);

    const finishSupersededRead = harness.holdNextPlanRead();
    const reads = harness.planReads();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(harness.planReads()).toBe(reads + 1);

    harness.computer.plan = FRESH_PLAN;
    await rereadPlan(harness);
    expect(harness.planReads()).toBe(reads + 2);
    finishSupersededRead();
    await settle();

    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    await retryLocalPlan(harness, "success");
    expect(acceptIsDisabled()).toBe(false);
  });

  it("keeps the source refusal when the setup Retry stops and another client restarts it", async () => {
    const harness = await retryStoppedSourceMove();
    const reads = harness.planReads();
    await deliverNextStatusRead();
    expect(planIsDrawn()).toBe(false);
    expect(harness.planReads()).toBe(reads);

    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    harness.computer.status = awaitingConsentStatus();
    await deliverNextStatusRead();
    await settle();
    expect(harness.planReads()).toBe(reads + 1);
    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    await retryLocalPlan(harness, "success");
    expect(acceptIsDisabled()).toBe(false);
  });

  it("enables Move when the setup Retry's first plan answers successfully", async () => {
    const harness = await retryStoppedSourceMove();
    expect(acceptIsDisabled()).toBe(true);
    const reads = harness.planReads();

    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    harness.computer.status = awaitingConsentStatus();
    await deliverNextStatusRead();
    await settle();

    expect(harness.planReads()).toBe(reads + 1);
    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).toBeNull();
    expect(summaryText()).toBe("3 variables");
    expect(acceptIsDisabled()).toBe(false);
  });

  it("keeps the source refusal when the setup Retry's own plan fails", async () => {
    const harness = mountLocalSourceSheet(
      sourceRefusal("plan", "E_MOVE_LOCAL_SOURCE_UNREAD"),
      shortLivedQueryClient(),
      true,
    );
    await settle();
    harness.computer.status = stoppedStatus();
    await deliverNextStatusRead();

    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(harness.retries()).toBe(1);
    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();

    const failed = Promise.withResolvers<void>();
    const unsubscribe = harness.queryClient
      .getQueryCache()
      .subscribe((event) => {
        if (
          event.type === "updated" &&
          event.action.type === "error" &&
          isMovePlanKey(event.query.queryKey)
        ) {
          failed.resolve();
        }
      });
    try {
      harness.computer.planFailure = planRefusal(
        "RPC_ERROR",
        "The computer took too long to answer.",
      );
      harness.computer.status = awaitingConsentStatus();
      await deliverNextStatusRead();
      await failed.promise;
    } finally {
      unsubscribe();
    }
    await settle();
    expect(acceptIsDisabled()).toBe(true);

    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    await rereadPlan(harness);
    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    await retryLocalPlan(harness, "success");
    expect(acceptIsDisabled()).toBe(false);
  });

  it("keeps the generic stage failure when the same message comes without the source refusal code", async () => {
    const harness = mountLocalSourceSheet(
      null,
      shortLivedQueryClient(),
      undefined,
    );
    await settle();
    expect(acceptIsDisabled()).toBe(false);

    harness.refuseStage(sourceRefusal("stage", "RPC_ERROR"));
    await pressMove(harness);

    expect(harness.acceptancePosts()).toBe(0);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(acceptIsDisabled()).toBe(false);
  });

  it("refuses the press before any acceptance POST and enables Move only after Retry reads the plan", async () => {
    const harness = mountLocalSourceSheet(
      null,
      shortLivedQueryClient(),
      undefined,
    );
    await settle();
    expect(acceptIsDisabled()).toBe(false);

    harness.refuseStage(sourceRefusal("stage", "E_MOVE_LOCAL_SOURCE_UNREAD"));
    await pressMove(harness);

    expect(harness.stages()).toBe(1);
    expect(harness.acceptancePosts()).toBe(0);
    expect(
      within(screen.getByTestId("move-sheet")).queryByText(
        LOCAL_SOURCE_REFUSAL,
      ),
    ).not.toBeNull();
    expect(planIsDrawn()).toBe(false);
    expect(acceptIsDisabled()).toBe(true);

    harness.computer.planFailure = sourceRefusal(
      "plan",
      "E_MOVE_LOCAL_SOURCE_UNREAD",
    );
    await retryLocalPlan(harness, "error");
    expect(screen.queryByText(LOCAL_SOURCE_REFUSAL)).not.toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    const answerPlan = harness.holdNextPlanRead();
    harness.computer.plan = FRESH_PLAN;
    harness.computer.planFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(acceptIsDisabled()).toBe(true);

    answerPlan();
    await settle();
    expect(summaryText()).toBe("3 variables");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(acceptIsDisabled()).toBe(false);
  });
});

describe("<MoveSheet /> after a refused plan read", () => {
  it("draws no plan and holds Move to Personal when the re-read is refused as not awaiting", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
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
        servesRetry: true,
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
      servesRetry: true,
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

  it.each(RESUMED_STATUSES)(
    "hands over to the move's progress when the re-run resumes without asking and the status reads %s",
    async (_name, resumedStatus) => {
      const harness = mountSheet({
        plan: STALE_PLAN,
        planFailure: null,
        status: awaitingConsentStatus(),
        servesRetry: true,
      });
      await settle();
      harness.computer.status = stoppedStatus();
      harness.computer.planFailure = NOT_AWAITING;
      await rereadPlan(harness);
      await deliverNextStatusRead();
      const readsBeforeRetry = harness.planReads();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settle();
      expect(harness.retries()).toBe(1);
      expect(useMoveSheetStore.getState().target).not.toBeNull();

      harness.computer.status = registeringStatus();
      await deliverNextStatusRead();
      expect(useMoveSheetStore.getState().target).not.toBeNull();
      expect(screen.getByTestId("move-sheet-loading")).toBeTruthy();
      expect(screen.queryByTestId("move-progress-dialog")).toBeNull();

      harness.computer.status = resumedStatus;
      await deliverNextStatusRead();
      const dialog = await screen.findByTestId("move-progress-dialog");

      expect(useMoveSheetStore.getState().target).toBeNull();
      expect(useMoveProgressDialogStore.getState().target).toEqual({
        hostId: HOST_ID,
        hostName: "Old laptop",
      });
      expect(
        within(dialog).getByText("Moving Old laptop to Personal"),
      ).toBeTruthy();
      expect(screen.queryByTestId("move-sheet-accept")).toBeNull();
      expect(harness.planReads()).toBe(readsBeforeRetry);
      expect(harness.stages()).toBe(0);
      expect(harness.starts).toEqual([]);
    },
  );

  it("comes back to the refused line and its Retry when the re-run stops again before asking", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
    });
    await settle();
    harness.computer.status = stoppedStatus();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    const releaseStatusRead = harness.holdNextStatusRead();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(harness.retries()).toBe(1);
    expect(screen.getByTestId("move-sheet-loading")).toBeTruthy();
    expect(screen.queryByText(NOT_AWAITING.message)).toBeNull();

    releaseStatusRead();
    await settle();

    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();
    expect(screen.queryByTestId("move-sheet-loading")).toBeNull();
    expect(planIsDrawn()).toBe(false);
    expect(acceptIsDisabled()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(2);
  });

  it.each(["failed", "stalled"])(
    "re-runs again when the re-run stopped in registering as %s",
    async (state) => {
      const harness = mountSheet({
        plan: STALE_PLAN,
        planFailure: null,
        status: awaitingConsentStatus(),
        servesRetry: true,
      });
      await settle();
      harness.computer.status = stoppedStatus();
      harness.computer.planFailure = NOT_AWAITING;
      await rereadPlan(harness);
      await deliverNextStatusRead();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settle();
      expect(harness.retries()).toBe(1);

      harness.computer.status = environmentStatusFixture({
        setup: { stage: "registering", state },
      });
      await deliverNextStatusRead();
      expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();
      const readsBeforeSecondRetry = harness.planReads();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settle();

      expect(harness.retries()).toBe(2);
      expect(harness.planReads()).toBe(readsBeforeSecondRetry);
    },
  );

  it("asks the fresh plan when the re-run passes registering and waits for the person again", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
    });
    await settle();
    harness.computer.status = stoppedStatus();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    const readsBeforeRetry = harness.planReads();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(harness.retries()).toBe(1);

    harness.computer.status = registeringStatus();
    await deliverNextStatusRead();

    expect(useMoveSheetStore.getState().target).not.toBeNull();
    expect(screen.getByTestId("move-sheet-loading")).toBeTruthy();
    expect(harness.planReads()).toBe(readsBeforeRetry);
    expect(screen.queryByTestId("move-progress-dialog")).toBeNull();

    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    harness.computer.status = environmentStatusFixture({
      setup: { stage: "moving_settings", state: "awaiting_consent" },
      move: {
        state: "needs_person",
        attemptId: ATTEMPT_ID,
        acceptanceId: ACCEPTANCE_ID,
        reason: "acceptance_missing",
      },
    });
    await deliverNextStatusRead();
    await settle();

    expect(summaryText()).toBe("3 variables");
    expect(acceptIsDisabled()).toBe(false);
    expect(harness.planReads()).toBe(readsBeforeRetry + 1);
    expect(screen.queryByTestId("move-progress-dialog")).toBeNull();
  });

  it("hides the plan it drew for the re-run's consent wait once a later status leaves that wait", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
    });
    await settle();
    harness.computer.status = stoppedStatus();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    harness.computer.planFailure = null;
    harness.computer.plan = FRESH_PLAN;
    harness.computer.status = awaitingConsentStatus();
    await deliverNextStatusRead();
    await settle();
    expect(summaryText()).toBe("3 variables");
    expect(acceptIsDisabled()).toBe(false);

    harness.computer.status = registeringStatus();
    await deliverNextStatusRead();

    expect(planIsDrawn()).toBe(false);
    expect(acceptIsDisabled()).toBe(true);
  });

  it("waits through a resumed consent that still carries the stopped attempt, then hands over", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
    });
    await settle();
    harness.computer.status = stoppedStatus();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    const readsBeforeRetry = harness.planReads();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(harness.retries()).toBe(1);

    harness.computer.status = environmentStatusFixture({
      setup: { stage: "moving_settings", state: "awaiting_consent" },
      move: {
        state: "retry",
        cause: "unavailable",
        attemptId: ATTEMPT_ID,
        acceptanceId: ACCEPTANCE_ID,
      },
    });
    await deliverNextStatusRead();

    expect(harness.planReads()).toBe(readsBeforeRetry);
    expect(acceptIsDisabled()).toBe(true);
    expect(screen.getByTestId("move-sheet-loading")).toBeTruthy();
    expect(screen.queryByTestId("move-progress-dialog")).toBeNull();

    harness.computer.status = RESUMED_STATUSES[0][1];
    await deliverNextStatusRead();
    await screen.findByTestId("move-progress-dialog");

    expect(useMoveSheetStore.getState().target).toBeNull();
  });

  it("does not flash the old refusal from a status read sent before the retry", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
    });
    await settle();
    harness.computer.status = stoppedStatus();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    await deliverNextStatusRead();
    const readsBeforePoll = harness.statusReads();
    const releaseStatusRead = harness.holdNextStatusRead();
    await deliverNextStatusRead();
    expect(harness.statusReads()).toBe(readsBeforePoll + 1);
    harness.computer.status = registeringStatus();
    const releaseReplacement = harness.holdNextStatusRead();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(harness.retries()).toBe(1);
    expect(harness.statusReads()).toBe(readsBeforePoll + 2);
    releaseStatusRead();
    await settle();

    expect(screen.queryByText(NOT_AWAITING.message)).toBeNull();

    releaseReplacement();
    await settle();

    expect(screen.queryByText(NOT_AWAITING.message)).toBeNull();
    expect(screen.getByTestId("move-sheet-loading")).toBeTruthy();
  });

  it("keeps the plan refetch on a host without environment.setup.retry", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: stoppedStatus(),
      servesRetry: false,
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
    expect(harness.stages()).toBe(0);
  });

  it("only reads the plan again on Retry when the move is waiting for the person", async () => {
    const harness = mountSheet({
      plan: STALE_PLAN,
      planFailure: null,
      status: awaitingConsentStatus(),
      servesRetry: true,
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
      servesRetry: true,
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

describe("<TeamGiveDialog /> reopened over an earlier opening's answer", () => {
  it("holds Confirm at this computer on a reopen until this opening's read answers", async () => {
    const harness = mountComputer(
      {
        plan: GIVE_PLAN,
        planFailure: null,
        status: awaitingConsentStatus(),
        servesRetry: true,
      },
      createAppQueryClient(),
      undefined,
    );
    renderGiveDialog(harness);
    await settle();
    const confirm = (): HTMLElement =>
      screen.getByRole("button", { name: "Confirm at this computer" });
    expect(confirm().hasAttribute("disabled")).toBe(false);
    cleanup();

    const answer = harness.holdNextPlanRead();
    renderGiveDialog(harness);
    await settle();

    expect(confirm().hasAttribute("disabled")).toBe(true);

    answer();
    await settle();

    expect(confirm().hasAttribute("disabled")).toBe(false);
  });
});

describe("<MoveSheet /> reopened over an earlier opening's answer", () => {
  /**
   * The app's own cache, which keeps a closed sheet's answers for minutes and
   * calls an answer fresh for a minute. Only its retry is switched off: a
   * retried refusal waits out a backoff the fake clock does not run here.
   */
  function mountWithAppCache(computer: Computer): Harness {
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({
      ...queryClient.getDefaultOptions(),
      queries: { ...queryClient.getDefaultOptions().queries, retry: false },
    });
    return mountSheetOn(computer, queryClient, undefined);
  }

  const awaitingComputer = (): Computer => ({
    plan: STALE_PLAN,
    planFailure: null,
    status: awaitingConsentStatus(),
    servesRetry: true,
  });

  it("offers no plan and holds Move to Personal until this opening's read answers, then accepts the fresh plan", async () => {
    const harness = mountWithAppCache(awaitingComputer());
    await settle();
    expect(summaryText()).toBe("2 variables");
    closeMoveSheet();
    await settle();

    harness.computer.plan = FRESH_PLAN;
    const answer = harness.holdNextPlanRead();
    openMoveSheet();
    await settle();

    expect(harness.planReads()).toBe(2);
    expect(planIsDrawn()).toBe(false);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Leave on this computer only" }),
    ).toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    answer();
    await settle();

    expect(summaryText()).toBe("3 variables");
    expect(acceptIsDisabled()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("FRESH_ONE")).toBeTruthy();
    expect(screen.queryByText("STALE_ONE")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Leave on this computer only" })
        .length,
    ).toBeGreaterThan(0);

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

  it("shows no refusal line or Retry from the last opening until this opening's read answers", async () => {
    const harness = mountWithAppCache(awaitingComputer());
    await settle();
    harness.computer.planFailure = NOT_AWAITING;
    await rereadPlan(harness);
    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();
    closeMoveSheet();
    await settle();

    const answer = harness.holdNextPlanRead();
    openMoveSheet();
    await settle();

    expect(screen.queryByText(NOT_AWAITING.message)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(acceptIsDisabled()).toBe(true);

    answer();
    await settle();

    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("runs the stopped move again from Retry only once this opening's status has answered stopped", async () => {
    const harness = mountWithAppCache({
      plan: STALE_PLAN,
      planFailure: NOT_AWAITING,
      status: stoppedStatus(),
      servesRetry: true,
    });
    await settle();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    closeMoveSheet();
    await settle();

    const answerStatus = harness.holdNextStatusRead();
    const readsBeforeReopen = harness.planReads();
    openMoveSheet();
    await settle();
    expect(screen.getByText(NOT_AWAITING.message)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(0);
    expect(harness.planReads()).toBe(readsBeforeReopen + 2);

    answerStatus();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(1);
  });

  it("does not run the stopped move again from Retry while this opening's status read has failed", async () => {
    const harness = mountWithAppCache({
      plan: STALE_PLAN,
      planFailure: NOT_AWAITING,
      status: stoppedStatus(),
      servesRetry: true,
    });
    await settle();
    closeMoveSheet();
    await settle();

    harness.failNextStatusRead();
    openMoveSheet();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(0);

    await deliverNextStatusRead();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();

    expect(harness.retries()).toBe(1);
  });
});
