/**
 * The two Send-time agent checks a sandbox adds to a composer:
 *
 * - `useSandboxAgentGate`: the composer's host IS a sandbox, so the agent the
 *   person picked cannot be swapped for another; one that cannot run there is
 *   refused at Send with the configuration's own Providers.
 * - `useStagedSendSignInCheck`: the composer's host runs the configuration a
 *   staged sandbox will be created in, and the agent picked is signed out on
 *   it, so the create and the wake are refused before they start.
 *
 * Real hooks and the real host directory; only the host reads are answered.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  hostRpcRegistry,
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
  answers.principal = { kind: "personal" };
  answers.environments = [
    { environmentId: "env-acme", ownerKind: "organization", ownerId: "team-9" },
  ];
  answers.openEnvironmentPage.mockReset();
  installHostDirectoryRows([
    sandboxHostEntry(SANDBOX_HOST, null),
    sandboxHostEntry(TEAM_SANDBOX_HOST, { id: "team-9", name: "Acme" }),
    plainHostEntry(LAPTOP_HOST),
  ]);
});

afterEach(() => {
  resetHostDirectoryRows();
});

function gateOn(hostId: string | null, harnessId: "codex" | "claude" | null) {
  return renderHook(() =>
    useSandboxAgentGate({
      hostId,
      client: CLIENT,
      harnessId,
      active: true,
    }),
  ).result.current;
}

describe("useSandboxAgentGate", () => {
  it("refuses an agent that cannot run on the person's own sandbox, with Personal's Providers", () => {
    const gate = gateOn(SANDBOX_HOST, "codex");

    expect(gate.blocked).toBe(true);
    expect(gate.hint).toBe(
      "Sign in to a coding agent to run agents on Personal.",
    );
    expect(gate.notice).toMatchObject({
      kind: "refused",
      message: "Sign in to a coding agent to run agents on Personal.",
      action: { label: "Open Personal's Providers" },
    });
    gate.notice?.action?.onAction();
    expect(answers.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "personal",
      pageId: "providers",
    });
  });

  it("names the team and opens that team's own Providers on a team's sandbox", () => {
    const gate = gateOn(TEAM_SANDBOX_HOST, "codex");

    expect(gate.notice).toMatchObject({
      message: "Sign in to a coding agent to run agents on Acme.",
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

    const gate = gateOn(TEAM_SANDBOX_HOST, "codex");

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

function harnessesWith(
  authStatus: "authenticated" | "unauthenticated" | undefined,
): ReadonlyArray<GuiHarnessOption> {
  return [harnessRow("codex", { authStatus }), harnessRow("claude", {})];
}

function checkFor(harnessId: "codex" | "claude" | null) {
  return renderHook(() =>
    useStagedSendSignInCheck({
      client: CLIENT,
      hostId: LAPTOP_HOST,
      harnessId,
      active: true,
    }),
  ).result.current;
}

describe("useStagedSendSignInCheck", () => {
  it("refuses a Personal stage on a Personal host whose picked agent is signed out, with the Providers link", () => {
    answers.harnesses = harnessesWith("unauthenticated");

    const refusal = checkFor("codex")(stageIn({ kind: "personal" }));

    expect(refusal).toMatchObject({
      kind: "refused",
      message: "Sign in to a coding agent to run agents on Personal.",
      action: { label: "Open Personal's Providers" },
    });
    refusal?.action?.onAction();
    expect(answers.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "personal",
      pageId: "providers",
    });
  });

  it("refuses a team's stage on that team's host, naming the team and opening its Providers", () => {
    answers.harnesses = harnessesWith("unauthenticated");
    answers.principal = { kind: "team", teamName: "Acme" };

    const refusal = checkFor("codex")(
      stageIn({ kind: "team", teamId: "team-9", teamName: "Acme" }),
    );

    expect(refusal).toMatchObject({
      message: "Sign in to a coding agent to run agents on Acme.",
      action: { label: "Open Acme's Providers" },
    });
    refusal?.action?.onAction();
    expect(answers.openEnvironmentPage).toHaveBeenCalledWith({
      configurationId: "env-acme",
      pageId: "providers",
    });
  });

  it.each([
    [
      "the host runs another configuration than the stage",
      { kind: "team", teamName: "Other" } as const,
      "unauthenticated",
      "codex",
    ],
    [
      "the picked agent is signed in",
      { kind: "personal" } as const,
      "authenticated",
      "codex",
    ],
    [
      "another agent than the signed-out one is picked",
      { kind: "personal" } as const,
      "unauthenticated",
      "claude",
    ],
    [
      "the host does not report a sign-in",
      { kind: "personal" } as const,
      undefined,
      "codex",
    ],
  ] as const)(
    "cannot refuse when %s",
    (_label, principal, authStatus, harnessId) => {
      answers.principal = principal;
      answers.harnesses = harnessesWith(authStatus);

      expect(checkFor(harnessId)(stageIn({ kind: "personal" }))).toBeNull();
    },
  );

  it("refuses nothing when no agent is picked", () => {
    answers.harnesses = harnessesWith("unauthenticated");

    expect(checkFor(null)(stageIn({ kind: "personal" }))).toBeNull();
  });
});
