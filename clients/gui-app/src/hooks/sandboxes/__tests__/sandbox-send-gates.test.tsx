/**
 * The two Send-time agent checks a sandbox adds to a composer:
 *
 * - `useSandboxAgentGate`: the composer's host IS a sandbox, so the agent the
 *   person picked cannot be swapped for another; one not offered or unusable
 *   there is refused at Send.
 * - `useStagedSendSignInCheck`: the server catalogue says whether the selected
 *   agent can run on a staged sandbox, so an unoffered pick is refused before
 *   create or wake; a legacy catalogue leaves readiness to that host.
 *
 * Real hooks and the real host directory; only the host reads are answered.
 */
import type { QueryObserverResult } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
  type GuiHarnessId,
  type GuiHarnessOption,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  harnessRow,
  opencodeProviderRow,
  providerRow,
} from "@/lib/sandboxes/__tests__/pending-send-fixtures";
import {
  installHostDirectoryRows,
  plainHostEntry,
  resetHostDirectoryRows,
  sandboxHostEntry,
} from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import {
  readStagedSandbox,
  useStagedSandboxStore,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";

const SANDBOX_HOST = "sbx-host";
const TEAM_SANDBOX_HOST = "team-sbx-host";
const LAPTOP_HOST = "laptop-host";

const answers = vi.hoisted(() => ({
  harnesses: undefined as ReadonlyArray<unknown> | undefined,
  providers: undefined as ReadonlyArray<unknown> | undefined,
  catalogue: undefined as SandboxCatalogue | undefined,
  user: null as AuthenticatedUser | null,
  refetchUser:
    vi.fn<
      () => Promise<
        Pick<QueryObserverResult<AuthenticatedUser | null>, "data" | "isError">
      >
    >(),
  catalogueError: false,
  catalogueFetching: false,
  refetchCatalogue: vi.fn<() => Promise<unknown>>(),
  principal: { kind: "personal" } as
    | { readonly kind: "personal" }
    | { readonly kind: "team"; readonly teamName: string },
  environments: [] as Array<{
    readonly environmentId: string;
    readonly ownerKind: "user" | "organization";
    readonly ownerId: string;
  }>,
  openEnvironmentPage:
    vi.fn<(address: { configurationId: string; pageId: string }) => void>(),
  onOpenTerminalInstead: vi.fn<() => void>(),
  onChooseAnotherHost: vi.fn<() => void>(),
  openForHarness:
    vi.fn<
      (
        harnessId: GuiHarnessId,
        offeredAgents: ReadonlyArray<string> | null,
      ) => void
    >(),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://billing.test" }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: answers.user, refetch: answers.refetchUser }),
}));
vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://billing.test",
}));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@/hooks/harnesses/use-gui-harness-catalog", () => ({
  useGuiHarnessesQueryForClient: () => ({
    data:
      answers.harnesses === undefined
        ? undefined
        : { harnesses: answers.harnesses },
  }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data:
      answers.providers === undefined
        ? undefined
        : { providers: answers.providers },
  }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    data: answers.catalogue,
    isError: answers.catalogueError,
    isFetching: answers.catalogueFetching,
    refetch: answers.refetchCatalogue,
  }),
}));
vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({
    supported: true,
    data: { principal: answers.principal },
    isError: false,
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: { environments: answers.environments },
  }),
}));
vi.mock("@/components/settings/environment/open-environment-page", () => ({
  openEnvironmentPage: answers.openEnvironmentPage,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

import { useSandboxAgentGate } from "@/hooks/sandboxes/use-sandbox-agent-gate";
import { ChatOpencodeLineContext } from "@/hooks/harnesses/chat-opencode-line-context";
import { useStagedSendSignInCheck } from "@/hooks/sandboxes/use-staged-send-sign-in-check";
import {
  registerActiveModelPicker,
  resetActiveModelPickerForTests,
} from "@/lib/commands/active-model-picker-registry";

function buildClient(hostId: string): HostClient<HostRpcRegistry> {
  const entry = plainHostEntry(hostId);
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => {} },
    findHostById: (id) => (id === hostId ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-${hostId}`,
      handlers: {},
    }),
  });
  return spine.createRequester(entry);
}

const CLIENT = buildClient("client-host");

const CODEX_SIGNED_OUT: ReadonlyArray<GuiHarnessOption> = [
  harnessRow("codex", { available: false, availabilityPending: false }),
  harnessRow("claude", { available: true }),
];
const PACKS_INSTALLED: ReadonlyArray<ProviderCliState> = [
  providerRow("codex", { status: "installed" }),
  providerRow("claude-code", { status: "installed" }),
];

beforeEach(() => {
  answers.user = null;
  answers.refetchUser.mockReset();
  answers.refetchUser.mockResolvedValue({ data: null, isError: false });
  answers.harnesses = CODEX_SIGNED_OUT;
  answers.providers = PACKS_INSTALLED;
  answers.catalogue = undefined;
  answers.catalogueError = false;
  answers.catalogueFetching = false;
  answers.principal = { kind: "personal" };
  answers.environments = [
    { environmentId: "env-acme", ownerKind: "organization", ownerId: "team-9" },
  ];
  answers.openEnvironmentPage.mockReset();
  answers.onOpenTerminalInstead.mockReset();
  answers.onChooseAnotherHost.mockReset();
  answers.openForHarness.mockReset();
  answers.refetchCatalogue.mockReset();
  answers.refetchCatalogue.mockResolvedValue(undefined);
  resetActiveModelPickerForTests();
  installHostDirectoryRows([
    sandboxHostEntry(SANDBOX_HOST, null),
    sandboxHostEntry(TEAM_SANDBOX_HOST, { id: "team-9", name: "Acme" }),
    plainHostEntry(LAPTOP_HOST),
  ]);
});

afterEach(() => {
  resetHostDirectoryRows();
});

function gateOn(
  hostId: string | null,
  harnessId: "codex" | "claude" | "traycer" | null,
) {
  return renderHook(() =>
    useSandboxAgentGate({
      hostId,
      client: CLIENT,
      harnessId,
      active: true,
      onOpenTerminalInstead: answers.onOpenTerminalInstead,
      onChooseAnotherHost: answers.onChooseAnotherHost,
    }),
  ).result.current;
}

describe("useSandboxAgentGate", () => {
  it("holds Send until Traycer's actual engine is ready, including missing line facts", () => {
    answers.harnesses = [harnessRow("traycer", {})];
    answers.providers = [providerRow("traycer", { status: "installed" })];
    const { result, rerender } = renderHook(() =>
      useSandboxAgentGate({
        hostId: SANDBOX_HOST,
        client: CLIENT,
        harnessId: "traycer",
        active: true,
      }),
    );
    expect(result.current).toMatchObject({
      blocked: true,
      notice: { pending: true },
    });

    answers.providers = [
      providerRow("traycer", { status: "installed" }),
      opencodeProviderRow({ status: "downloading", percent: 40 }, {}),
    ];
    rerender();
    expect(result.current.blocked).toBe(true);

    answers.providers = [
      providerRow("traycer", { status: "installed" }),
      opencodeProviderRow(
        {
          status: "error",
          reason: "disk-full",
          message: "ENOSPC",
          retryAtMs: null,
        },
        {},
      ),
    ];
    rerender();
    expect(result.current.notice).toMatchObject({
      kind: "refused",
      action: { label: "Open Personal's Providers" },
    });
    expect(result.current.notice?.message).toContain("disk space");

    answers.providers = [
      providerRow("traycer", { status: "installed" }),
      opencodeProviderRow({ status: "installed" }, {}),
    ];
    rerender();
    expect(result.current).toEqual({
      blocked: false,
      hint: null,
      notice: null,
    });
  });

  it("checks a bound chat's recorded line while a new chat would wait on Managed 2", () => {
    answers.harnesses = [harnessRow("traycer", {})];
    answers.providers = [
      opencodeProviderRow({ status: "downloading", percent: 40 }, {}),
    ];
    expect(gateOn(SANDBOX_HOST, "traycer").blocked).toBe(true);

    const { result } = renderHook(
      () =>
        useSandboxAgentGate({
          hostId: SANDBOX_HOST,
          client: CLIENT,
          harnessId: "traycer",
          active: true,
        }),
      {
        wrapper: ({ children }: { readonly children: ReactNode }) => (
          <ChatOpencodeLineContext value={1}>
            {children}
          </ChatOpencodeLineContext>
        ),
      },
    );
    expect(result.current.blocked).toBe(false);
  });

  it("refuses an agent not offered on sandboxes, with the model picker and other remedies", () => {
    answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
    registerActiveModelPicker({
      toggle: vi.fn(),
      openForHarness: answers.openForHarness,
      getSelectionSummary: () => null,
    });
    const gate = gateOn(SANDBOX_HOST, "claude");

    expect(gate.blocked).toBe(true);
    expect(gate.notice).toMatchObject({
      kind: "refused",
      message:
        "Claude Code doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      action: { label: "Choose a model" },
      secondaryActions: [
        { label: "Open terminal instead" },
        { label: "Choose another host" },
      ],
    });
    gate.notice?.action?.onAction();
    expect(answers.openForHarness).toHaveBeenCalledWith("traycer", ["traycer"]);
    gate.notice?.secondaryActions?.[0]?.onAction();
    gate.notice?.secondaryActions?.[1]?.onAction();
    expect(answers.onOpenTerminalInstead).toHaveBeenCalledOnce();
    expect(answers.onChooseAnotherHost).toHaveBeenCalledOnce();
  });

  it("offers Personal's Providers when Traycer Inference is offered but unavailable", () => {
    answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
    answers.harnesses = [harnessRow("traycer", { available: false })];
    answers.providers = [providerRow("traycer", { status: "installed" })];

    const gate = gateOn(SANDBOX_HOST, "traycer");

    expect(gate.blocked).toBe(true);
    expect(gate.hint).toBe(
      "Turn on Traycer Inference in Personal's Providers to run agents on sandboxes.",
    );
    expect(gate.notice).toMatchObject({
      message:
        "Turn on Traycer Inference in Personal's Providers to run agents on sandboxes.",
      action: { label: "Open Personal's Providers" },
      secondaryActions: [
        { label: "Open terminal instead" },
        { label: "Choose another host" },
      ],
    });
    gate.notice?.action?.onAction();
    expect(answers.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "personal",
      pageId: "providers",
    });
  });

  it("names the team and opens that team's own Providers on a team's sandbox", () => {
    answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
    answers.harnesses = [harnessRow("traycer", { available: false })];
    answers.providers = [providerRow("traycer", { status: "installed" })];
    const gate = gateOn(TEAM_SANDBOX_HOST, "traycer");

    expect(gate.notice).toMatchObject({
      message:
        "Turn on Traycer Inference in Acme's Providers to run agents on sandboxes.",
      action: { label: "Open Acme's Providers" },
    });
    gate.notice?.action?.onAction();
    expect(answers.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "env-acme",
      pageId: "providers",
    });
  });

  it("offers no link when the team's environment has not been read", () => {
    answers.environments = [];
    answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
    answers.harnesses = [harnessRow("traycer", { available: false })];
    answers.providers = [providerRow("traycer", { status: "installed" })];

    const gate = gateOn(TEAM_SANDBOX_HOST, "traycer");

    expect(gate.blocked).toBe(true);
    expect(gate.notice?.action).toBeNull();
  });

  it.each([
    ["a host that is not a sandbox", LAPTOP_HOST, "codex", CODEX_SIGNED_OUT],
    ["an agent that can run there", SANDBOX_HOST, "claude", CODEX_SIGNED_OUT],
  ] as const)(
    "holds nothing for %s",
    (_label, hostId, harnessId, harnesses) => {
      answers.harnesses = harnesses;

      expect(gateOn(hostId, harnessId)).toEqual({
        blocked: false,
        hint: null,
        notice: null,
      });
    },
  );

  it("holds Send while the requested agent's availability is still being probed", () => {
    answers.harnesses = [
      harnessRow("codex", { available: true, availabilityPending: true }),
    ];
    expect(gateOn(SANDBOX_HOST, "codex")).toMatchObject({
      blocked: true,
      notice: { pending: true },
    });
  });

  it("holds Send while the pack is still downloading", () => {
    answers.providers = [
      providerRow("codex", { status: "downloading", percent: 40 }),
      providerRow("claude-code", { status: "installed" }),
    ];

    expect(gateOn(SANDBOX_HOST, "codex")).toMatchObject({
      blocked: true,
      notice: { pending: true },
    });
  });

  it("holds Send before the host has answered its lists", () => {
    answers.harnesses = undefined;
    answers.providers = undefined;

    expect(gateOn(SANDBOX_HOST, "codex")).toMatchObject({
      blocked: true,
      notice: { pending: true },
    });
  });
});

function stageIn(
  configuration:
    | { readonly kind: "personal" }
    | {
        readonly kind: "team";
        readonly teamId: string;
        readonly teamName: string;
      },
): StagedSandbox {
  useStagedSandboxStore.setState({ bySurface: {} });
  useStagedSandboxStore.getState().stage("surface", {
    kind: "new",
    configuration,
    shape: {
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 30,
      destroyAfterRestingMinutes: null,
    },
    name: "",
    wakeString: null,
  });
  const staged = readStagedSandbox("surface");
  if (staged === null) throw new Error("the stage was not recorded");
  return staged;
}

function checkFor(harnessId: "codex" | "claude" | null) {
  return renderHook(() =>
    useStagedSendSignInCheck({
      harnessId,
      active: true,
      onOpenTerminalInstead: answers.onOpenTerminalInstead,
      onChooseAnotherHost: answers.onChooseAnotherHost,
    }),
  ).result.current.check;
}

const QUOTED_CATALOGUE: SandboxCatalogue = {
  offeredAgents: ["codex"],
  providers: [
    {
      provider: "tensorlake",
      os: ["linux"],
      shape: {
        cpuMin: 1,
        cpuMax: 16,
        cpuStep: 1,
        memoryPerCpuMinMb: 1024,
        memoryPerCpuMaxMb: 8192,
        memoryMinMb: 1024,
        memoryMaxMb: 65536,
        memoryStepMb: 512,
        diskMinMb: 10240,
        diskMaxMb: 102400,
        diskDefaultMb: 20480,
      },
      suspendFidelity: "memory",
      stoppedStorage: "snapshot",
      wakeClass: "resume",
      shapes: null,
      dockerInGuest: true,
      creatable: true,
      notCreatableReason: null,
      regions: [
        {
          id: "us-east",
          label: "US East",
          fromPriceMcPerHour: {
            awakeMc: 210,
            suspendedMc: 1,
            stoppedMc: 1,
          },
          pricing: null,
        },
      ],
    },
  ],
};

describe("useStagedSendSignInCheck", () => {
  it("shows the advisory short allowance in the existing staged-send gate and keeps the stage", () => {
    answers.user = userWith(
      userSubscription({
        totalPlanCredits: 100,
        consumedFromPlan: 0,
        bonusCredits: 0,
        consumedFromBonus: 0,
        bundleRemaining: 0,
      }),
      [teamSubscription(0)],
    );
    answers.catalogue = QUOTED_CATALOGUE;
    const stage = stageIn({ kind: "team", teamId: "team-1", teamName: "Acme" });
    const notice = checkFor("codex")(stage);
    expect(notice).toMatchObject({
      kind: "refused",
      message:
        "Your Acme allowance is short $0.21. $0.21 more starts this sandbox for an hour.",
    });
    expect(notice?.secondaryActions?.map((action) => action.label)).toEqual([
      "Choose another host",
    ]);
    expect(readStagedSandbox("surface")).toBe(stage);
  });

  it.each([false, true])(
    "uses a fresh allowance at Send: still short=%s",
    async (stillShort) => {
      const user = (credits: number): AuthenticatedUser =>
        userWith(
          userSubscription({
            totalPlanCredits: 100,
            consumedFromPlan: 0,
            bonusCredits: 0,
            consumedFromBonus: 0,
            bundleRemaining: 0,
          }),
          [teamSubscription(credits)],
        );
      answers.catalogue = QUOTED_CATALOGUE;
      answers.user = user(stillShort ? 10 : 0);
      answers.refetchUser.mockResolvedValue({
        data: user(stillShort ? 0 : 10),
        isError: false,
      });
      const stage = stageIn({
        kind: "team",
        teamId: "team-1",
        teamName: "Acme",
      });
      const gate = renderHook(() =>
        useStagedSendSignInCheck({ harnessId: "codex", active: true }),
      ).result.current;
      const refusal = await gate.beforeSend(stage);
      if (stillShort)
        expect(refusal?.message).toBe(
          "Your Acme allowance is short $0.21. $0.21 more starts this sandbox for an hour.",
        );
      else expect(refusal).toBeNull();
      expect(answers.refetchUser).toHaveBeenCalledOnce();
      expect(readStagedSandbox("surface")).toBe(stage);
    },
  );

  it("refuses a picked agent the sandbox launch catalogue does not offer", () => {
    answers.catalogue = { providers: [], offeredAgents: ["traycer"] };
    registerActiveModelPicker({
      toggle: vi.fn(),
      openForHarness: answers.openForHarness,
      getSelectionSummary: () => null,
    });

    const refusal = checkFor("claude")(stageIn({ kind: "personal" }));

    expect(refusal).toMatchObject({
      kind: "refused",
      message:
        "Claude Code doesn't run on sandboxes. Choose a Traycer model to run agents here.",
      action: { label: "Choose a model" },
      secondaryActions: [
        { label: "Open terminal instead" },
        { label: "Choose another host" },
      ],
    });
    refusal?.action?.onAction();
    refusal?.secondaryActions?.[0]?.onAction();
    refusal?.secondaryActions?.[1]?.onAction();
    expect(answers.openForHarness).toHaveBeenCalledWith("traycer", ["traycer"]);
    expect(answers.onOpenTerminalInstead).toHaveBeenCalledOnce();
    expect(answers.onChooseAnotherHost).toHaveBeenCalledOnce();
  });

  it("shows a checking notice while the sandbox catalogue is unresolved", () => {
    answers.catalogue = undefined;
    answers.catalogueFetching = true;

    const notice = checkFor("claude")(stageIn({ kind: "personal" }));

    expect(notice).toEqual({
      kind: "mirror",
      pending: true,
      message: "Checking which agents run on sandboxes.",
      action: null,
    });
  });

  it("refuses a staged send when the catalogue couldn't be read, offering Retry", () => {
    answers.catalogue = undefined;
    answers.catalogueError = true;

    expect(checkFor("claude")(stageIn({ kind: "personal" }))).toMatchObject({
      kind: "refused",
      message: "Couldn't check which agents run on sandboxes.",
      action: { label: "Retry" },
    });
  });

  it("allows a picked agent present in the catalogue regardless of desktop auth", () => {
    answers.catalogue = { providers: [], offeredAgents: ["codex"] };
    answers.harnesses = [
      harnessRow("codex", { authStatus: "unauthenticated" }),
    ];

    expect(checkFor("codex")(stageIn({ kind: "personal" }))).toBeNull();
  });

  it("allows a legacy catalogue response without offeredAgents to reach the sandbox host", () => {
    answers.catalogue = { providers: [] };
    answers.harnesses = [
      harnessRow("codex", { authStatus: "unauthenticated" }),
    ];

    expect(checkFor("codex")(stageIn({ kind: "personal" }))).toBeNull();
  });

  it("refuses nothing when no agent is picked", () => {
    answers.catalogue = { providers: [], offeredAgents: [] };

    expect(checkFor(null)(stageIn({ kind: "personal" }))).toBeNull();
  });
});
