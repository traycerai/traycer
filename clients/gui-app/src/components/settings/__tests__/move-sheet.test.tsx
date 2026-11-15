import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  EnvironmentMovePlanRequestV20,
  EnvironmentMovePlanResponseV20,
  EnvironmentMoveStageRequest,
  EnvironmentMoveStageResponse,
  EnvironmentMoveStartRequest,
} from "@traycer/protocol/host/environment/move-contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import {
  fakeEnvironmentCloud,
  type FakeEnvironmentCloud,
  type FakeEnvironmentCloudAnswer,
  type FakeEnvironmentCloudResponder,
} from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { MoveSheet } from "@/components/settings/move-sheet";
import type { HostsRunningConfiguration } from "@/components/settings/environment/hosts-running-configuration-model";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
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

// The computers running Personal, as the one hook answers them.
const runningPersonalMock = vi.hoisted(
  (): { current: HostsRunningConfiguration | null; retry: () => void } => ({
    current: null,
    retry: () => undefined,
  }),
);
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => runningPersonalMock.current,
  }),
);

type PlanRows = EnvironmentMovePlanResponseV20["rows"];

function row(key: string, label: string, detail: string | null) {
  return { kind: "variable" as const, key, os: null, label, detail };
}

function rowOfKind(key: string, kind: string, label: string) {
  return { kind, key, os: null, label, detail: null };
}

function plan(
  planHash: string,
  rows: Partial<PlanRows>,
): EnvironmentMovePlanResponseV20 {
  return planWith(planHash, rows, { personalHoldsSecrets: false });
}

function planWith(
  planHash: string,
  rows: Partial<PlanRows>,
  flags: { readonly personalHoldsSecrets: boolean },
): EnvironmentMovePlanResponseV20 {
  return {
    planHash,
    planRevision: 1,
    hostVersion: "1.5.0",
    disclosureVersion: 1,
    rows: {
      moves: [],
      staysOnThisComputer: [],
      alreadyInPersonal: [],
      differsMasked: [],
      ...rows,
    },
    guideDiffers: false,
    personalHoldsSecrets: flags.personalHoldsSecrets,
  };
}

const FIRST_PLAN = plan("hash-1", {
  moves: [row("EDITOR", "EDITOR", "variable"), row("PAGER", "PAGER", null)],
  staysOnThisComputer: [
    row("SSH", "SSH sign-in", "terminal"),
    row(
      "OPENAI_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_API_KEY (variable) holds a value that reads like a key, and a key's value does not move in or out of a computer, so it stays here and keeps working. To use it everywhere, add it on Secrets.",
    ),
  ],
});

interface Harness {
  readonly plans: EnvironmentMovePlanRequestV20[];
  readonly stages: EnvironmentMoveStageRequest[];
  readonly stageEvidence: {
    readonly planHash: string;
    readonly planRevision: number;
  }[];
  readonly starts: EnvironmentMoveStartRequest[];
  readonly authn: FakeEnvironmentCloud;
}

interface MountOptions {
  readonly plans: readonly EnvironmentMovePlanResponseV20[];
  readonly authnAnswer?:
    | FakeEnvironmentCloudAnswer
    | FakeEnvironmentCloudResponder;
  readonly firstPlanError?: Error;
  readonly stageError?: Error;
}

function mount(options: MountOptions): Harness {
  return mountReaching(options, []);
}

function mountReaching(
  options: MountOptions,
  runningPersonal: readonly { hostId: string; name: string }[],
): Harness {
  return mountWithRunning(options, {
    hosts: runningPersonal.map((host) => ({
      hostId: host.hostId,
      hostName: host.name,
      name: host.name,
      kind: "personal",
      isThisComputer: false,
      lastReportedAt: 1,
      applied: [],
    })),
    state: "ready",
    thisComputerUnread: false,
    collisions: [],
    retry: runningPersonalMock.retry,
    reread: () => undefined,
  });
}

function mountWithRunning(
  options: MountOptions,
  running: HostsRunningConfiguration,
): Harness {
  const plans: EnvironmentMovePlanRequestV20[] = [];
  const stages: EnvironmentMoveStageRequest[] = [];
  const stageEvidence: { planHash: string; planRevision: number }[] = [];
  const starts: EnvironmentMoveStartRequest[] = [];
  let planReads = 0;
  let latestPlan: EnvironmentMovePlanResponseV20 | null = null;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.move.plan": (request) => {
        plans.push(request);
        if (planReads === 0 && options.firstPlanError !== undefined) {
          planReads += 1;
          throw options.firstPlanError;
        }
        const answer =
          options.plans[Math.min(planReads, options.plans.length - 1)];
        planReads += 1;
        latestPlan = answer;
        return answer;
      },
      "environment.move.stage": (request) => {
        stages.push(request);
        if (options.stageError !== undefined) throw options.stageError;
        if (latestPlan === null)
          throw new Error("The plan must be read before staging.");
        const evidence = {
          attemptId: ATTEMPT_ID,
          planHash: latestPlan.planHash,
          planRevision: latestPlan.planRevision,
          hostVersion: latestPlan.hostVersion,
          itemCount: latestPlan.rows.moves.length,
          keyChoices: request.keyChoices,
          sourceHostId: HOST_ID,
          sharingGeneration: 1,
          targetKind: "personal",
          environmentId: ENVIRONMENT_ID,
          disclosureVersion: latestPlan.disclosureVersion,
        } satisfies EnvironmentMoveStageResponse["evidence"];
        stageEvidence.push({
          planHash: evidence.planHash,
          planRevision: evidence.planRevision,
        });
        return {
          evidence,
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
  const authn = fakeEnvironmentCloud(
    options.authnAnswer ??
      ((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`))
          return { status: 200, body: { hosts: [{ purgePending: false }] } };
        if (path.endsWith("/move-acceptances"))
          return { status: 201, body: { acceptanceId: ACCEPTANCE_ID } };
        throw new Error(
          `Unexpected environment request: ${request.method} ${path}`,
        );
      }),
  );
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
  runningPersonalMock.current = running;
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.move.plan": { major: 2, minor: 0 },
    "environment.move.stage": { major: 1, minor: 0 },
    "environment.move.start": { major: 1, minor: 0 },
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
      <MoveSheet />
    </QueryClientProvider>,
  );
  act(() => {
    useMoveSheetStore
      .getState()
      .openSheet({ hostId: HOST_ID, hostName: "Old laptop" });
  });
  return { plans, stages, stageEvidence, starts, authn };
}

async function settle(): Promise<void> {
  await advanceLegendListTime(50);
}

beforeEach(() => {
  installLegendListTestClock();
  useMoveSheetStore.setState({ target: null });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  fixtureMock.client = null;
  fixtureMock.binding = null;
  useAuthStore.getState().setSignedOut();
});

describe("<MoveSheet />", () => {
  it("shows the disclosure and Move to Personal for disclosure version 1", async () => {
    const harness = mount({ plans: [FIRST_PLAN] });
    await settle();

    expect(screen.getByTestId("move-sheet-disclosure").textContent).toContain(
      "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.",
    );
    expect(screen.getByTestId("move-sheet-accept").textContent).toContain(
      "Move to Personal",
    );
    expect(harness.plans).toEqual([
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        personal: null,
      },
    ]);
  });

  it("asks for an update and stages nothing for an unsupported disclosure version", async () => {
    const harness = mount({
      plans: [{ ...FIRST_PLAN, disclosureVersion: 2 }],
    });
    await settle();

    expect(
      screen.getByText("Old laptop needs an update to show its settings here."),
    ).toBeTruthy();
    expect(screen.queryByTestId("move-sheet-accept")).toBeNull();
    expect(harness.stages).toEqual([]);
    expect(
      harness.authn.requests.some((request) =>
        request.url.endsWith("/move-acceptances"),
      ),
    ).toBe(false);
  });

  it("draws the plan's rows: Moves, Stays with a key-shaped value, Already in Personal (empty)", async () => {
    mount({ plans: [FIRST_PLAN] });
    await settle();

    expect(screen.getByText("Move Old laptop to Personal?")).toBeTruthy();
    expect(screen.getByTestId("move-sheet-description").textContent).toBe(
      "It then uses your Personal settings, the same ones every computer and sandbox running Personal uses. You can move it back any time.",
    );
    expect(screen.getByTestId("move-sheet-nothing-deleted").textContent).toBe(
      "Everything also stays on Old laptop; nothing is deleted.",
    );
    expect(screen.queryByTestId("move-sheet-nothing-to-move")).toBeNull();
    const moves = screen.getByTestId("move-sheet-moves");
    expect(moves.textContent).toContain("Moves");
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "2 variables",
    );
    expect(
      within(moves).getByRole("button", { name: "Show all 2" }),
    ).toBeTruthy();
    const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
    expect(stays.textContent).toContain("Stays on this computer");
    // The key-shaped value is a stay, with its own reason and no choice.
    expect(stays.textContent).toContain("OPENAI_API_KEY");
    expect(stays.textContent).toContain(
      "a key's value does not move in or out of a computer",
    );
    expect(
      screen.getByTestId("move-sheet-alreadyInPersonal").textContent,
    ).toContain("Nothing yet.");
    // Different from Personal is drawn only when the plan has any.
    expect(screen.queryByTestId("move-sheet-differsMasked")).toBeNull();
    // Nothing here is stored as a secret, so no custody sentence.
    expect(
      screen.getByTestId("move-sheet-disclosure").textContent,
    ).not.toContain("Stored encrypted in Traycer's cloud.");
  });

  it("titles the differing section and reads its rows as label: detail", async () => {
    mount({
      plans: [
        plan("hash-d", {
          moves: [row("EDITOR", "EDITOR", "variable")],
          differsMasked: [row("PAGER", "PAGER", "value differs")],
        }),
      ],
    });
    await settle();

    const differs = screen.getByTestId("move-sheet-differsMasked");
    expect(differs.textContent).toContain("Different from Personal");
    expect(differs.textContent).not.toContain("Differs, masked");
    fireEvent.click(within(differs).getByRole("button", { name: "1 item" }));
    expect(differs.textContent).toContain("PAGER: value differs");
    // The other sections keep the `label · detail` form.
    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    expect(moves.textContent).toContain("EDITOR · variable");
  });

  it("draws Already in Personal above Different from Personal", async () => {
    mount({
      plans: [
        plan("hash-s", {
          alreadyInPersonal: [row("HOME", "HOME", null)],
          differsMasked: [row("PAGER", "PAGER", "value differs")],
        }),
      ],
    });
    await settle();

    const already = screen.getByTestId("move-sheet-alreadyInPersonal");
    const differs = screen.getByTestId("move-sheet-differsMasked");
    expect(already.textContent).toContain("Already in Personal");
    expect(
      already.compareDocumentPosition(differs) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says above Moves where an edited agent selection guide goes, naming the computer", async () => {
    mount({
      plans: [{ ...FIRST_PLAN, guideDiffers: true }],
    });
    await settle();

    const note = screen.getByTestId("move-sheet-guide-differs");
    expect(note.textContent).toBe(
      "Agent selection guide: this computer's guide has your edits. It moves to Personal only if Personal has never had a guide. Otherwise it is set aside on Old laptop, and Old laptop uses Personal's guide, or the built-in one if Personal's was removed. Nothing in Personal is replaced or restored.",
    );
    expect(
      note.compareDocumentPosition(screen.getByTestId("move-sheet-moves")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says nothing of the guide while it is not edited", async () => {
    mount({ plans: [FIRST_PLAN] });
    await settle();

    expect(screen.queryByTestId("move-sheet-guide-differs")).toBeNull();
  });

  it("holds Move to Personal while the computers running Personal are unread", async () => {
    mountWithRunning(
      { plans: [FIRST_PLAN] },
      {
        hosts: [],
        state: "loading",
        thisComputerUnread: false,
        collisions: [],
        retry: () => undefined,
        reread: () => undefined,
      },
    );
    await settle();

    expect(
      screen.getByTestId("move-sheet-accept").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says it couldn't read which computers run Personal, and Retry reads again", async () => {
    const retry = vi.fn<() => void>();
    mountWithRunning(
      { plans: [FIRST_PLAN] },
      {
        hosts: [],
        state: "failed",
        thisComputerUnread: false,
        collisions: [],
        retry,
        reread: () => undefined,
      },
    );
    await settle();

    expect(
      screen.getByText("Couldn't read which computers run Personal."),
    ).toBeTruthy();
    expect(screen.queryByTestId("move-sheet-loading")).toBeNull();
    expect(
      screen.getByTestId("move-sheet-accept").hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("stages an empty plan with no choices and closes after start", async () => {
    const harness = mount({
      plans: [
        plan("hash-n", {
          alreadyInPersonal: [row("HOME", "HOME", null)],
          staysOnThisComputer: [],
        }),
      ],
    });
    await settle();

    expect(screen.getByTestId("move-sheet-not-now")).toBeTruthy();
    expect(screen.getByTestId("move-sheet-accept")).toBeTruthy();
    expect(screen.queryByTestId("move-sheet-disclosure")).toBeNull();
    expect(screen.getByTestId("move-sheet-nothing-to-move").textContent).toBe(
      "Nothing on Old laptop needs moving.",
    );
    expect(screen.queryByTestId("move-sheet-nothing-deleted")).toBeNull();
    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();
    expect(screen.queryByTestId("move-sheet-staysOnThisComputer")).toBeNull();
    expect(screen.getByTestId("move-sheet-alreadyInPersonal")).toBeTruthy();
    const target = { kind: "personal", environmentId: ENVIRONMENT_ID } as const;
    expect(harness.plans).toEqual([{ target, personal: null }]);
    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await waitFor(() => expect(useMoveSheetStore.getState().target).toBeNull());
    expect(harness.stages).toEqual([
      { target, keyChoices: [], personal: null },
    ]);
    expect(harness.stageEvidence).toEqual([
      { planHash: "hash-n", planRevision: 1 },
    ]);
    expect(harness.starts).toEqual([
      {
        attemptId: ATTEMPT_ID,
        planHash: "hash-n",
        acceptanceId: ACCEPTANCE_ID,
      },
    ]);
    expect(
      harness.authn.requests
        .filter((request) => request.url.endsWith("/move-acceptances"))
        .map(({ body }) => body),
    ).toEqual([
      expect.objectContaining({ planHash: "hash-n", planRevision: 1 }),
    ]);
  });

  it("shows Personal's existing secrets when an empty move reaches them", async () => {
    mount({
      plans: [
        planWith(
          "hash-empty-secrets",
          {},
          {
            personalHoldsSecrets: true,
          },
        ),
      ],
    });
    await settle();

    expect(screen.getByTestId("move-sheet-disclosure").textContent).toBe(
      "Nothing new is stored as a secret. Once Old laptop runs Personal, it receives Personal's existing keys and secrets as values its tools and agents can read.",
    );
  });

  it("names a one-of-a-kind row by its page, and leaves other rows their label", async () => {
    mount({
      plans: [
        plan("hash-p", {
          moves: [
            rowOfKind("browser", "browser_agent_access", "browser"),
            rowOfKind("EDITOR", "variable", "EDITOR"),
            rowOfKind(
              "claude-code:ANTHROPIC_BASE_URL",
              "env_override",
              "ANTHROPIC_BASE_URL",
            ),
          ],
        }),
      ],
    });
    await settle();

    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 3" }));
    expect(moves.textContent).toContain("Browser agent access");
    expect(moves.textContent).toContain("ANTHROPIC_BASE_URL (Claude Code)");
    expect(moves.textContent).not.toContain("Claude Code: ");
    expect(moves.textContent).not.toContain("browser ");
    expect(moves.textContent).toContain("EDITOR");
  });

  it("says where secrets are stored and who receives them only when something is stored as a secret", async () => {
    const custody =
      "Stored encrypted in Traycer's cloud. Computers running Personal receive the value, readable by their tools and agents; sandboxes use it without seeing it.";
    const accepts =
      "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";
    const disclosure = () =>
      screen.getByTestId("move-sheet-disclosure").textContent;
    const secretPlan = plan("hash-s", {
      moves: [rowOfKind("TOKEN", "secret", "TOKEN")],
    });
    const options = { plans: [secretPlan] };

    mount({
      plans: [plan("hash-v", { moves: [row("EDITOR", "EDITOR", null)] })],
    });
    await settle();
    expect(disclosure()).toBe(accepts);
    cleanup();

    mountReaching(options, [
      { hostId: "mac", name: "MacBook Pro" },
      { hostId: "dev", name: "dev-box" },
      { hostId: HOST_ID, name: "Old laptop" },
    ]);
    await settle();
    expect(disclosure()).toBe(
      `${custody} Today that is MacBook Pro and dev-box, and any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read. ${accepts}`,
    );
    cleanup();

    mount(options);
    await settle();
    expect(disclosure()).toBe(
      `${custody} No other computer runs Personal yet. Any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read. ${accepts}`,
    );
  });

  it("offers How Traycer handles this under the disclosure, and not on the nothing-to-move sheet", async () => {
    mount({ plans: [FIRST_PLAN] });
    await settle();

    expect(screen.queryByTestId("members-data-handling-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("members-data-handling-trigger"));
    expect(
      screen.getByTestId("members-data-handling-notice").textContent,
    ).toContain(
      "Traycer's cloud stores the value encrypted. Sandboxes running Personal or a team use the value without seeing it.",
    );
    cleanup();

    mount({
      plans: [
        plan("hash-n", { alreadyInPersonal: [row("HOME", "HOME", null)] }),
      ],
    });
    await settle();
    expect(screen.queryByTestId("members-data-handling-trigger")).toBeNull();
  });

  it("has no Moves section when only stays rows are planned", async () => {
    mount({
      plans: [
        plan("hash-n2", { staysOnThisComputer: [row("SSH", "SSH", null)] }),
      ],
    });
    await settle();

    expect(screen.queryByTestId("move-sheet-moves")).toBeNull();
  });

  it("shows a stays row's detail alone, so the item's name appears once", async () => {
    const detail =
      "github (MCP server) runs npx -y @acme/github on this computer, so it stays here and keeps working.";
    mount({
      plans: [
        plan("hash-s", {
          staysOnThisComputer: [
            row("github", "github", detail),
            row("SSH", "SSH sign-in", null),
          ],
        }),
      ],
    });
    await settle();

    const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
    const text = stays.textContent;
    expect(text).toContain(detail);
    expect(text.split("github").length - 1).toBe(
      detail.split("github").length - 1,
    );
    expect(text).not.toContain("github · ");
    expect(text).not.toContain("github: ");
    expect(text).toContain("SSH sign-in");
  });

  it("shows what stays on this computer without a click, while Moves stays folded", async () => {
    mount({
      plans: [
        plan("hash-stays", {
          moves: [row("PATH", "PATH", null)],
          staysOnThisComputer: [row("EDITOR", "EDITOR", null)],
        }),
      ],
    });
    await settle();

    expect(
      screen.getByTestId("move-sheet-staysOnThisComputer").textContent,
    ).toContain("EDITOR");
    expect(screen.getByTestId("move-sheet-moves").textContent).not.toContain(
      "PATH",
    );
  });

  it("opens a section to its items", async () => {
    mount({ plans: [FIRST_PLAN] });
    await settle();

    fireEvent.click(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "Show all 2",
      }),
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "EDITOR",
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "PAGER",
    );
    expect(screen.getByTestId("move-sheet-moves").textContent).toContain(
      "variable",
    );
  });

  it("stages and starts the displayed plan when no row choice changed", async () => {
    const harness = mount({
      plans: [FIRST_PLAN],
    });
    await settle();

    const target = { kind: "personal", environmentId: ENVIRONMENT_ID } as const;
    expect(harness.plans).toEqual([{ target, personal: null }]);
    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await waitFor(() => expect(useMoveSheetStore.getState().target).toBeNull());

    expect(harness.stages).toEqual([
      { target, keyChoices: [], personal: null },
    ]);
    expect(harness.stageEvidence).toEqual([
      { planHash: "hash-1", planRevision: 1 },
    ]);
    expect(harness.starts).toEqual([
      {
        attemptId: ATTEMPT_ID,
        planHash: "hash-1",
        acceptanceId: ACCEPTANCE_ID,
      },
    ]);
    expect(
      harness.authn.requests
        .filter((request) => request.url.endsWith("/move-acceptances"))
        .map(({ method, url, body }) => [method, url, body]),
    ).toEqual([
      [
        "POST",
        `https://authn.test/api/v3/hosts/${HOST_ID}/move-acceptances`,
        {
          attemptId: ATTEMPT_ID,
          planHash: "hash-1",
          planRevision: 1,
          hostVersion: "1.5.0",
          itemCount: 2,
          keyChoices: [],
          sourceHostId: HOST_ID,
          sharingGeneration: 1,
          targetKind: "personal",
          environmentId: ENVIRONMENT_ID,
          disclosureVersion: 1,
          manifestHash: MANIFEST_HASH,
        },
      ],
    ]);
  });

  it("reads Personal again after its first refusal before retrying the plan", async () => {
    const personalItem = {
      kind: "variable",
      key: "EDITOR",
      os: null,
      value: "zed",
      revision: 4,
      updatedAt: 1_700_000_000_000,
      writtenBy: { source: "app", hostId: HOST_ID, hostName: "Old laptop" },
    };
    let personalReadSucceeds = false;
    const harness = mount({
      plans: [FIRST_PLAN],
      firstPlanError: new HostRpcError({
        code: "RPC_ERROR",
        message: "Personal is unavailable to this computer.",
        requestId: "plan-personal-unavailable",
        method: "environment.move.plan",
        fatalDetails: null,
      }),
      authnAnswer: (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/environments/me")) {
          return personalReadSucceeds
            ? { status: 200, body: { environmentId: ENVIRONMENT_ID } }
            : { status: 403, body: {} };
        }
        if (url.pathname.endsWith(`/environments/${ENVIRONMENT_ID}/items`)) {
          return {
            status: 200,
            body: {
              items:
                url.searchParams.get("kind") === "variable"
                  ? [personalItem]
                  : [],
            },
          };
        }
        if (url.pathname.endsWith(`/environments/${ENVIRONMENT_ID}/secrets`))
          return { status: 200, body: { secrets: [], removed: [] } };
        if (url.pathname.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`))
          return { status: 200, body: { hosts: [{ purgePending: false }] } };
        if (url.pathname.endsWith("/move-acceptances"))
          return { status: 201, body: { acceptanceId: ACCEPTANCE_ID } };
        throw new Error(
          `Unexpected environment request: ${request.method} ${url.pathname}`,
        );
      },
    });
    await screen.findByText("Personal is unavailable to this computer.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(harness.plans).toEqual([
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        personal: null,
      },
    ]);

    personalReadSucceeds = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByTestId("move-sheet-moves")).toBeTruthy();
    expect(harness.plans).toEqual([
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        personal: null,
      },
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        personal: {
          items: [{ kind: "variable", key: "EDITOR", os: null, value: "zed" }],
          holdsSecrets: false,
        },
      },
    ]);
    expect(
      harness.authn.requests.filter((request) =>
        request.url.endsWith("/api/v3/environments/me"),
      ),
    ).toHaveLength(2);
  });

  it("does not start or close when the sign-in changes during acceptance", async () => {
    const acceptanceRequested = Promise.withResolvers<void>();
    const acceptanceAnswer =
      Promise.withResolvers<FakeEnvironmentCloudAnswer>();
    const harness = mount({
      plans: [FIRST_PLAN],
      authnAnswer: (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`))
          return { status: 200, body: { hosts: [{ purgePending: false }] } };
        if (path.endsWith("/move-acceptances")) {
          acceptanceRequested.resolve();
          return acceptanceAnswer.promise;
        }
        throw new Error(
          `Unexpected environment request: ${request.method} ${path}`,
        );
      },
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await acceptanceRequested.promise;
    harness.authn.origin.current = false;
    acceptanceAnswer.resolve({
      status: 201,
      body: { acceptanceId: ACCEPTANCE_ID },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("move-sheet-accept").hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(useMoveSheetStore.getState().target).not.toBeNull();
    expect(harness.starts).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("move-sheet-plan-changed")).toBeNull();
    expect(screen.queryByTestId("move-sheet-not-awaiting")).toBeNull();
  });

  it("re-reads the plan on plan_changed, says so, and sends the new hash next", async () => {
    const changed = planWith(
      "hash-2",
      { moves: [row("EDITOR-UPDATED", "EDITOR updated", null)] },
      { personalHoldsSecrets: false },
    );
    let acceptanceCalls = 0;
    const harness = mount({
      plans: [
        planWith(
          "hash-1",
          { moves: [row("EDITOR", "EDITOR", null)] },
          { personalHoldsSecrets: false },
        ),
        changed,
      ],
      authnAnswer: (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/environments/${ENVIRONMENT_ID}/hosts`))
          return { status: 200, body: { hosts: [{ purgePending: false }] } };
        if (path.endsWith("/move-acceptances")) {
          acceptanceCalls += 1;
          return acceptanceCalls === 1
            ? { status: 409, body: { code: "operation_acceptance_invalid" } }
            : { status: 201, body: { acceptanceId: ACCEPTANCE_ID } };
        }
        throw new Error(
          `Unexpected environment request: ${request.method} ${path}`,
        );
      },
    });
    await settle();
    fireEvent.click(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "Show all 1",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Leave on this computer only" }),
    );

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    expect(await screen.findByTestId("move-sheet-plan-changed")).toBeTruthy();

    expect(screen.getByTestId("move-sheet-plan-changed").textContent).toBe(
      "This list changed. Read it again.",
    );
    expect(useMoveSheetStore.getState().target).not.toBeNull();
    fireEvent.click(
      within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
        name: "Show all 1",
      }),
    );
    expect(await screen.findByText("EDITOR updated")).toBeTruthy();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    await waitFor(() => expect(useMoveSheetStore.getState().target).toBeNull());

    expect(harness.stages).toEqual([
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        keyChoices: [{ key: "item:variable:EDITOR", choice: "stays" }],
        personal: null,
      },
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        keyChoices: [],
        personal: null,
      },
    ]);
    expect(harness.starts).toEqual([
      {
        attemptId: ATTEMPT_ID,
        planHash: "hash-2",
        acceptanceId: ACCEPTANCE_ID,
      },
    ]);
  });

  it("closes on Not now and sends nothing", async () => {
    const harness = mount({
      plans: [FIRST_PLAN],
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-not-now"));
    await settle();

    expect(useMoveSheetStore.getState().target).toBeNull();
    expect(harness.stages).toEqual([]);
    expect(
      harness.authn.requests.some((request) =>
        request.url.endsWith("/move-acceptances"),
      ),
    ).toBe(false);
  });

  it("says nothing moved, and leaves the sheet open, when the host has no move waiting", async () => {
    const harness = mount({
      plans: [FIRST_PLAN],
      stageError: new HostRpcError({
        code: "E_MOVE_NOT_AWAITING",
        message: "no move awaits",
        requestId: "stage-not-awaiting",
        method: "environment.move.stage",
        fatalDetails: null,
      }),
    });
    await settle();

    fireEvent.click(screen.getByTestId("move-sheet-accept"));
    expect(await screen.findByTestId("move-sheet-not-awaiting")).toBeTruthy();

    expect(harness.stages).toEqual([
      {
        target: { kind: "personal", environmentId: ENVIRONMENT_ID },
        keyChoices: [],
        personal: null,
      },
    ]);
    expect(harness.starts).toEqual([]);
    expect(
      harness.authn.requests.some((request) =>
        request.url.endsWith("/move-acceptances"),
      ),
    ).toBe(false);
    expect(screen.getByTestId("move-sheet-not-awaiting").textContent).toBe(
      "Old laptop has no move waiting to start, so nothing moved.",
    );
    expect(useMoveSheetStore.getState().target).not.toBeNull();
  });
  it("lists a provider override as <NAME> (<Provider>)", async () => {
    mount({
      plans: [
        plan("hash-o", {
          moves: [
            rowOfKind(
              "claude-code:ANTHROPIC_BASE_URL",
              "env_override",
              "ANTHROPIC_BASE_URL",
            ),
          ],
        }),
      ],
    });
    await settle();

    const moves = screen.getByTestId("move-sheet-moves");
    fireEvent.click(within(moves).getByRole("button", { name: "Show all 1" }));
    expect(
      within(moves).getByText("ANTHROPIC_BASE_URL (Claude Code)"),
    ).toBeTruthy();
    expect(screen.getByTestId("move-sheet-moves-summary").textContent).toBe(
      "1 Claude Code env setting",
    );
  });

  it("names the other computers in the recipient boundary when a secret moves", async () => {
    const secretPlan = plan("hash-r", {
      moves: [rowOfKind("TOKEN", "secret", "TOKEN")],
    });
    const later =
      "any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read.";
    const disclosure = () =>
      screen.getByTestId("move-sheet-disclosure").textContent;

    mount({ plans: [secretPlan] });
    await settle();
    expect(disclosure()).toContain(
      `No other computer runs Personal yet. Any computer that starts running Personal later receives these keys and secrets as values its tools and agents can read.`,
    );
    cleanup();

    mountReaching({ plans: [secretPlan] }, [
      { hostId: "a", name: "A" },
      { hostId: "b", name: "B" },
      { hostId: HOST_ID, name: "Old laptop" },
    ]);
    await settle();
    expect(disclosure()).toContain(`Today that is A and B, and ${later}`);
  });

  it("tells a second computer that Personal's existing keys and secrets arrive, when it stores none itself", async () => {
    const arrives =
      "Nothing new is stored as a secret. Once Old laptop runs Personal, it receives Personal's existing keys and secrets as values its tools and agents can read.";
    const accepts =
      "Move accepts this list as shown; if it changes before the upload finishes, you are asked again.";
    const variablePlan = (holds: boolean) =>
      planWith(
        "hash-h",
        { moves: [row("EDITOR", "EDITOR", null)] },
        { personalHoldsSecrets: holds },
      );

    mount({ plans: [variablePlan(true)] });
    await settle();
    expect(screen.getByTestId("move-sheet-disclosure").textContent).toBe(
      `${arrives} ${accepts}`,
    );
    cleanup();

    mount({ plans: [variablePlan(false)] });
    await settle();
    expect(screen.getByTestId("move-sheet-disclosure").textContent).toBe(
      accepts,
    );
  });

  describe("choices on a Moves row", () => {
    const itemPlan = () =>
      planWith(
        "hash-i",
        {
          moves: [
            row("EDITOR", "EDITOR", null),
            rowOfKind("OPENAI_API_KEY", "secret", "OPENAI_API_KEY"),
            rowOfKind("fallback", "fallback_policy", "fallback"),
          ],
        },
        { personalHoldsSecrets: false },
      );

    function rowButtons(index: number): string[] {
      const rows = within(
        screen.getByTestId("move-sheet-moves"),
      ).getAllByTestId("move-sheet-moves-row");
      return within(rows[index])
        .queryAllByRole("button")
        .map((button) => button.textContent);
    }

    function openMoves(): void {
      fireEvent.click(
        within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
          name: "Show all 3",
        }),
      );
    }

    it("offers Leave on a variable and a secret, and nothing on a fallback policy", async () => {
      mount({ plans: [itemPlan()] });
      await settle();
      openMoves();

      expect(rowButtons(0)).toEqual(["Leave on this computer only"]);
      expect(rowButtons(1)).toEqual(["Leave on this computer only"]);
      expect(rowButtons(2)).toEqual([]);
    });

    it("moves a row left on this computer only under Stays, where its pressed button takes it back", async () => {
      const harness = mount({ plans: [itemPlan()] });
      await settle();
      openMoves();

      fireEvent.click(
        within(
          within(screen.getByTestId("move-sheet-moves")).getAllByTestId(
            "move-sheet-moves-row",
          )[0],
        ).getByRole("button", { name: "Leave on this computer only" }),
      );
      expect(screen.getByTestId("move-sheet-moves").textContent).not.toContain(
        "EDITOR",
      );
      const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
      const left = within(stays).getByTestId("move-sheet-left-here-row");
      expect(left.textContent).toContain("EDITOR");
      const pressed = within(left).getByRole("button", {
        name: "Leave on this computer only",
      });
      expect(pressed.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await waitFor(() =>
        expect(useMoveSheetStore.getState().target).toBeNull(),
      );
      expect(harness.stages).toEqual([
        {
          target: { kind: "personal", environmentId: ENVIRONMENT_ID },
          keyChoices: [{ key: "item:variable:EDITOR", choice: "stays" }],
          personal: null,
        },
      ]);
    });

    it("sends nothing for a row whose choice was taken back", async () => {
      const harness = mount({ plans: [itemPlan()] });
      await settle();
      openMoves();

      fireEvent.click(
        within(
          within(screen.getByTestId("move-sheet-moves")).getAllByTestId(
            "move-sheet-moves-row",
          )[0],
        ).getByRole("button", { name: "Leave on this computer only" }),
      );
      const stays = screen.getByTestId("move-sheet-staysOnThisComputer");
      fireEvent.click(
        within(stays).getByRole("button", {
          name: "Leave on this computer only",
        }),
      );
      expect(screen.queryByTestId("move-sheet-left-here-row")).toBeNull();
      expect(
        within(screen.getByTestId("move-sheet-moves")).getByRole("button", {
          name: "Show all 3",
        }),
      ).toBeTruthy();
      fireEvent.click(screen.getByTestId("move-sheet-accept"));
      await waitFor(() =>
        expect(useMoveSheetStore.getState().target).toBeNull(),
      );

      expect(harness.stages).toEqual([
        {
          target: { kind: "personal", environmentId: ENVIRONMENT_ID },
          keyChoices: [],
          personal: null,
        },
      ]);
    });
  });
});
