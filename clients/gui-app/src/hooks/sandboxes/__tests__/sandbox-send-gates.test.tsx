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
import { renderHook } from "@testing-library/react";
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
  catalogue: undefined as
    | {
        readonly offeredAgents?: ReadonlyArray<string>;
        readonly providers?: ReadonlyArray<unknown>;
      }
    | undefined,
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
  openForHarness: vi.fn<(harnessId: GuiHarnessId) => void>(),
}));

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
  it("refuses an agent not offered on sandboxes, with the model picker and other remedies", () => {
    answers.catalogue = { offeredAgents: ["traycer"] };
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
    expect(answers.openForHarness).toHaveBeenCalledWith("traycer");
    gate.notice?.secondaryActions?.[0]?.onAction();
    gate.notice?.secondaryActions?.[1]?.onAction();
    expect(answers.onOpenTerminalInstead).toHaveBeenCalledOnce();
    expect(answers.onChooseAnotherHost).toHaveBeenCalledOnce();
  });

  it("offers Personal's Providers when Traycer Inference is offered but unavailable", () => {
    answers.catalogue = { offeredAgents: ["traycer"] };
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
    answers.catalogue = { offeredAgents: ["traycer"] };
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
    answers.catalogue = { offeredAgents: ["traycer"] };
    answers.harnesses = [harnessRow("traycer", { available: false })];
    answers.providers = [providerRow("traycer", { status: "installed" })];

    const gate = gateOn(TEAM_SANDBOX_HOST, "traycer");

    expect(gate.blocked).toBe(true);
    expect(gate.notice?.action).toBeNull();
  });

  it.each([
    ["a host that is not a sandbox", LAPTOP_HOST, "codex", CODEX_SIGNED_OUT],
    ["an agent that can run there", SANDBOX_HOST, "claude", CODEX_SIGNED_OUT],
    [
      "an agent whose availability is still being probed",
      SANDBOX_HOST,
      "codex",
      [
        harnessRow("codex", { available: false, availabilityPending: true }),
        harnessRow("claude", { available: true }),
      ],
    ],
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

  it("holds nothing while the pack is still downloading (the pack gate waits instead)", () => {
    answers.providers = [
      providerRow("codex", { status: "downloading", percent: 40 }),
      providerRow("claude-code", { status: "installed" }),
    ];

    expect(gateOn(SANDBOX_HOST, "codex").blocked).toBe(false);
  });

  it("holds nothing before the host has answered its lists", () => {
    answers.harnesses = undefined;
    answers.providers = undefined;

    expect(gateOn(SANDBOX_HOST, "codex").blocked).toBe(false);
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
  ).result.current;
}

describe("useStagedSendSignInCheck", () => {
  it("refuses a picked agent the sandbox launch catalogue does not offer", () => {
    answers.catalogue = { offeredAgents: ["traycer"] };
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
    expect(answers.openForHarness).toHaveBeenCalledWith("traycer");
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

  it("lets a failed catalogue request fall back to the sandbox host", () => {
    answers.catalogue = undefined;
    answers.catalogueError = true;

    expect(checkFor("claude")(stageIn({ kind: "personal" }))).toBeNull();
    expect(answers.refetchCatalogue).not.toHaveBeenCalled();
  });

  it("allows a picked agent present in the catalogue regardless of desktop auth", () => {
    answers.catalogue = { offeredAgents: ["codex"] };
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
    answers.catalogue = { offeredAgents: [] };

    expect(checkFor(null)(stageIn({ kind: "personal" }))).toBeNull();
  });
});
