import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentTransportAnswer } from "@traycer-clients/shared/environment/environment-cloud";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { EnvironmentSheetsHost } from "@/components/settings/move/environment-sheets-host";
import {
  PersonalPageFrame,
  PersonalPageHeaderStatus,
} from "@/components/settings/personal/personal-page-frame";
import { AuthService } from "@/lib/auth/auth-service";
import { authQueryKeys } from "@/lib/query-keys";
import { environmentMutationKeys } from "@/lib/query-keys/environment-mutation-keys";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  authnAnswer,
  authSessionForUser,
  mountTeamPage,
  poolSource,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

const ENVIRONMENT_ID = "env-a";
const VIEWER_ID = "user-1";
const REVIEW_PATH = `/api/v3/environments/${ENVIRONMENT_ID}/review`;
const MEMBERS_PATH = `/api/v3/environments/${ENVIRONMENT_ID}/members`;

type TeamRole = "admin" | "editor" | "viewer";

interface HeldInput {
  readonly id: string;
  readonly kind: string;
  readonly key: string;
  readonly proposed?: unknown;
  readonly current?: unknown;
  readonly heldRevision?: number;
  readonly liveRevision?: number | null;
  readonly op?: "put" | "delete";
}

function held(input: HeldInput): Record<string, unknown> {
  const op = input.op ?? "put";
  const proposed = input.proposed ?? { value: "proposed" };
  const liveRevision =
    input.liveRevision === undefined ? 3 : input.liveRevision;
  return {
    type: "held",
    heldId: input.id,
    revision: input.heldRevision ?? 8,
    kind: input.kind,
    key: input.key,
    os: null,
    hostId: "host-proposer",
    sharingGeneration: null,
    hostName: "Old laptop",
    heldAt: 1,
    op,
    value: op === "delete" ? null : proposed,
    live:
      liveRevision === null
        ? null
        : {
            revision: liveRevision,
            value: input.current ?? proposed,
          },
  };
}

interface TeamReviewHarness {
  readonly harness: TeamPageHarness;
  readonly setRows: (rows: readonly Record<string, unknown>[]) => void;
}

function createReviewHarness(
  initialRole: TeamRole,
  initialRows: readonly Record<string, unknown>[],
): TeamReviewHarness {
  const role = initialRole;
  let rows = [...initialRows];
  const handlers: MockHandlerMap<HostRpcRegistry> = {
    "environment.list": () => ({
      environments: [
        {
          environmentId: ENVIRONMENT_ID,
          ownerKind: "organization",
          ownerId: "team-a",
          roomId: "room-a",
          label: "Acme",
          effectiveRole: role,
          kind: "team",
          hostCount: 0,
          providerHandle: "acme",
        },
      ],
    }),
    "environment.host.list": () => ({ hosts: [] }),
    "environment.members": () => ({
      members: [],
      nextCursor: null,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    }),
    "environment.configuration.revision": () => ({ revision: "1" }),
    "environment.configuration.items": () => ({ items: [] }),
  };
  const harness = mountTeamPage(poolSource(initialRole), handlers);
  harness.auth.environmentCloud = AuthService.prototype.environmentCloud.bind(
    harness.auth,
  );
  harness.auth.applyExternalSession(
    authSessionForUser(VIEWER_ID, "user-1-token"),
  );
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: VIEWER_ID,
      userName: "User One",
      email: "user-1@example.com",
    },
    contextMetadata: { userId: VIEWER_ID, username: "user-1" },
    shareableTeams: [{ teamId: "team-a", slug: "acme", avatarUrl: null }],
  });
  useSettingsEnvironmentPickStore.getState().setPick({
    kind: "team",
    environmentId: ENVIRONMENT_ID,
  });
  harness.queryClient.setQueryData(
    authQueryKeys.registeredHosts(harness.auth, VIEWER_ID),
    { hosts: [] },
  );
  harness.cloudResponses.set(`GET ${REVIEW_PATH}`, (request) => {
    if (new URL(request.url).searchParams.get("include") !== "operation") {
      return authnAnswer(400, { error: "operation view required" });
    }
    return authnAnswer(200, { review: { hosts: [], needsYou: rows } });
  });
  return {
    harness,
    setRows: (nextRows) => {
      rows = [...nextRows];
    },
  };
}

function renderTeamPage(harness: TeamPageHarness): void {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  render(
    <harness.Wrapper>
      <RunnerHostProvider runnerHost={runnerHost}>
        <>
          <PersonalPageFrame section="secrets">
            <PersonalPageHeaderStatus />
            <p>Team settings page</p>
          </PersonalPageFrame>
          <EnvironmentSheetsHost />
        </>
      </RunnerHostProvider>
    </harness.Wrapper>,
  );
}

async function reviewButton(): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId("personal-review-row");
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Team Review needs a public review notice row");
  }
  return within(row).findByRole("button", { name: "Review" });
}

async function openReview(): Promise<HTMLElement> {
  fireEvent.click(await reviewButton());
  return screen.findByRole("dialog");
}

function operationReads(harness: TeamPageHarness) {
  return harness.cloudRequests.filter(
    (request) =>
      request.method === "GET" && new URL(request.url).pathname === REVIEW_PATH,
  );
}

function choiceRequests(harness: TeamPageHarness) {
  return harness.cloudRequests.filter(
    (request) =>
      request.method === "POST" &&
      new URL(request.url).pathname.includes("/review/held/"),
  );
}

function choicePath(id: string, verb: "apply" | "discard"): string {
  return `${REVIEW_PATH}/held/${id}/${verb}`;
}

function holdNextReviewMutation(
  harness: TeamPageHarness,
  beforeYield: (variables: unknown) => void,
): {
  readonly started: Promise<void>;
  readonly settled: Promise<void>;
  readonly release: () => void;
} {
  let markStarted: () => void = () => undefined;
  let markSettled: () => void = () => undefined;
  let releaseGate: () => void = () => undefined;
  let held = true;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  harness.queryClient.setMutationDefaults(
    environmentMutationKeys.teamReviewApplyChoice(ENVIRONMENT_ID, VIEWER_ID),
    {
      onMutate: async (variables) => {
        if (!held) return;
        held = false;
        beforeYield(variables);
        markStarted();
        await gate;
      },
      onSettled: () => markSettled(),
    },
  );
  return { started, settled, release: () => releaseGate() };
}

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.getState().setPick(null);
  useRetrospectiveSheetStore.setState({
    target: null,
    open: false,
    checkedHostIds: new Set(),
    heldToastDismissed: false,
    reviewOpening: 0,
  });
});

describe("Team Review through the addressed page", () => {
  it("opens from a no-host Team row and excludes Skills and the Guide", async () => {
    const rows = [
      held({
        id: "variable-1",
        kind: "variable",
        key: "NODE_ENV",
        proposed: { value: "production" },
      }),
      held({ id: "skill-1", kind: "skill", key: "skill-a", proposed: {} }),
      held({
        id: "guide-1",
        kind: "agent_selection_guide",
        key: "guide-a",
        proposed: {},
      }),
    ];
    const { harness } = createReviewHarness("editor", rows);
    renderTeamPage(harness);

    const reviewRows = await screen.findAllByTestId("personal-review-row");
    const reviewRow = reviewRows[0];
    if (reviewRow === undefined) {
      throw new Error("Team Review needs a public review notice row");
    }
    expect(screen.getAllByTestId("personal-review-link")).toHaveLength(1);
    expect(reviewRow.textContent).toContain("NODE_ENV");
    expect(screen.queryByText("skill-a")).toBeNull();
    expect(screen.queryByText("guide-a")).toBeNull();
    expect(operationReads(harness).length).toBeGreaterThan(0);
    expect(
      new URL(
        operationReads(harness)[0]?.url ?? "https://invalid",
      ).searchParams.get("include"),
    ).toBe("operation");

    fireEvent.click(within(reviewRow).getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Review" }),
    ).toBeTruthy();
    expect(within(dialog).getByText("Acme")).toBeTruthy();
    expect(within(dialog).getByText("Commands on hold")).toBeTruthy();
    expect(
      within(dialog).getByTestId("retrospective-held-variable-1"),
    ).toBeTruthy();
    expect(
      within(dialog).queryByTestId("retrospective-held-skill-1"),
    ).toBeNull();
    expect(
      within(dialog).queryByTestId("retrospective-held-guide-1"),
    ).toBeNull();
    expect(
      within(dialog).queryByText(/What an earlier version shared/),
    ).toBeNull();
    expect(within(dialog).queryByText(/Move to Personal/)).toBeNull();
    expect(useRetrospectiveSheetStore.getState().target).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      environmentName: "Acme",
      viewerId: VIEWER_ID,
    });
    expect(
      harness.messenger.calls.some(
        (call) => call.method === "environment.review",
      ),
    ).toBe(false);
    expect(harness.messenger.calls.length).toBe(0);
  });

  it.each(["admin", "editor"] as const)(
    "gives a settled %s the two review verbs",
    async (role) => {
      const { harness } = createReviewHarness(role, [
        held({ id: "hold-1", kind: "variable", key: "NODE_ENV" }),
      ]);
      renderTeamPage(harness);
      await openReview();

      await waitFor(() => {
        expect(
          screen.getByTestId("retrospective-held-hold-1-approve"),
        ).toBeTruthy();
        expect(
          screen.getByTestId("retrospective-held-hold-1-discard"),
        ).toBeTruthy();
      });
    },
  );

  it.each([
    ["Viewer", "valid"],
    ["unrecognized", "unknown"],
    ["refused", "refused"],
  ] as const)(
    "keeps Apply and Discard unavailable for a %s role answer",
    async (_label, answerKind) => {
      const { harness } = createReviewHarness(
        answerKind === "valid" ? "viewer" : "admin",
        [held({ id: "hold-1", kind: "variable", key: "NODE_ENV" })],
      );
      if (answerKind === "unknown") {
        harness.cloudResponses.set(`GET ${MEMBERS_PATH}`, () =>
          authnAnswer(200, { viewer: { effectiveRole: "maintainer" } }),
        );
      }
      if (answerKind === "refused") {
        harness.cloudResponses.set(`GET ${MEMBERS_PATH}`, () =>
          authnAnswer(503, { error: "temporarily unavailable" }),
        );
      }
      renderTeamPage(harness);
      const dialog = await openReview();
      await within(dialog).findByTestId("retrospective-held-hold-1");

      expect(
        within(dialog).queryByTestId("retrospective-held-hold-1-approve"),
      ).toBeNull();
      expect(
        within(dialog).queryByTestId("retrospective-held-hold-1-discard"),
      ).toBeNull();
      expect(choiceRequests(harness)).toEqual([]);
    },
  );

  it("waits for the refreshed role after focus before restoring a cached Admin's verbs", async () => {
    let holdDirectory = false;
    let resolveDirectory: ((role: TeamRole) => void) | null = null;
    let announceDirectoryRead: (() => void) | null = null;
    const directoryReadStarted = new Promise<void>((resolve) => {
      announceDirectoryRead = resolve;
    });
    const handlers: MockHandlerMap<HostRpcRegistry> = {
      "environment.list": () => {
        if (!holdDirectory) {
          return {
            environments: [
              {
                environmentId: ENVIRONMENT_ID,
                ownerKind: "organization",
                ownerId: "team-a",
                roomId: "room-a",
                label: "Acme",
                effectiveRole: "admin",
                kind: "team",
                hostCount: 0,
                providerHandle: "acme",
              },
            ],
          };
        }
        announceDirectoryRead?.();
        return new Promise((resolve) => {
          resolveDirectory = (role) =>
            resolve({
              environments: [
                {
                  environmentId: ENVIRONMENT_ID,
                  ownerKind: "organization",
                  ownerId: "team-a",
                  roomId: "room-a",
                  label: "Acme",
                  effectiveRole: role,
                  kind: "team",
                  hostCount: 0,
                  providerHandle: "acme",
                },
              ],
            });
        });
      },
      "environment.host.list": () => ({ hosts: [] }),
      "environment.members": () => ({
        members: [],
        nextCursor: null,
        legacyRoleNoticeSeenAt: null,
        legacyMembers: [],
      }),
      "environment.configuration.revision": () => ({ revision: "1" }),
      "environment.configuration.items": () => ({ items: [] }),
    };
    const harness = mountTeamPage(poolSource("admin"), handlers);
    harness.auth.applyExternalSession(
      authSessionForUser(VIEWER_ID, "user-1-token"),
    );
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: VIEWER_ID,
        userName: "User One",
        email: "user-1@example.com",
      },
      contextMetadata: { userId: VIEWER_ID, username: "user-1" },
      shareableTeams: [{ teamId: "team-a", slug: "acme", avatarUrl: null }],
    });
    useSettingsEnvironmentPickStore.getState().setPick({
      kind: "team",
      environmentId: ENVIRONMENT_ID,
    });
    harness.queryClient.setQueryData(
      authQueryKeys.registeredHosts(harness.auth, VIEWER_ID),
      { hosts: [] },
    );
    let reviewRows = [
      held({ id: "hold-1", kind: "variable", key: "NODE_ENV" }),
    ];
    harness.cloudResponses.set(`GET ${REVIEW_PATH}`, () =>
      authnAnswer(200, { review: { hosts: [], needsYou: reviewRows } }),
    );
    renderTeamPage(harness);
    const dialog = await openReview();
    await waitFor(() => {
      expect(
        within(dialog).getByTestId("retrospective-held-hold-1-approve"),
      ).toBeTruthy();
    });

    const initialReviewReadCount = operationReads(harness).length;
    reviewRows = [
      held({ id: "focus-refresh", kind: "variable", key: "FOCUSED_SETTING" }),
    ];
    holdDirectory = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await directoryReadStarted;
    await waitFor(() => {
      expect(operationReads(harness).length).toBeGreaterThan(
        initialReviewReadCount,
      );
    });
    await within(dialog).findByTestId("retrospective-held-focus-refresh");
    await waitFor(() => {
      expect(
        within(dialog).queryByTestId("retrospective-held-hold-1"),
      ).toBeNull();
    });
    expect(
      within(dialog).queryByTestId("retrospective-held-focus-refresh-approve"),
    ).toBeNull();
    expect(
      within(dialog).queryByTestId("retrospective-held-focus-refresh-discard"),
    ).toBeNull();
    expect(choiceRequests(harness)).toEqual([]);

    act(() => {
      resolveDirectory?.("viewer");
    });
    await waitFor(() => {
      expect(
        within(dialog).queryByTestId("retrospective-held-hold-1-approve"),
      ).toBeNull();
      expect(
        within(dialog).queryByTestId("retrospective-held-hold-1-discard"),
      ).toBeNull();
    });
  });

  it("serializes Apply and Discard with only the revisions the person saw", async () => {
    const applyRow = held({
      id: "hold-apply",
      kind: "variable",
      key: "NEW_SETTING",
      heldRevision: 11,
      liveRevision: null,
      proposed: { value: "new" },
    });
    const discardRow = held({
      id: "hold-discard",
      kind: "variable",
      key: "OLD_SETTING",
      heldRevision: 12,
      liveRevision: 5,
      proposed: { value: "proposed" },
      current: { value: "current" },
    });
    const scenario = createReviewHarness("admin", [applyRow, discardRow]);
    const { harness } = scenario;
    harness.cloudResponses.set(
      `POST ${choicePath("hold-apply", "apply")}`,
      () => {
        scenario.setRows([discardRow]);
        return authnAnswer(200, {});
      },
    );
    harness.cloudResponses.set(
      `POST ${choicePath("hold-discard", "discard")}`,
      () => {
        scenario.setRows([]);
        return authnAnswer(200, {});
      },
    );
    renderTeamPage(harness);
    const dialog = await openReview();
    await within(dialog).findByTestId("retrospective-held-hold-apply-approve");
    await within(dialog).findByTestId(
      "retrospective-held-hold-discard-discard",
    );
    expect(
      within(dialog).getByRole("heading", { name: "Current" }),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByTestId("retrospective-held-hold-apply-approve"),
    );
    await waitFor(() => expect(choiceRequests(harness)).toHaveLength(1));
    await waitFor(() => {
      expect(
        within(dialog).queryByTestId("retrospective-held-hold-apply"),
      ).toBeNull();
    });

    fireEvent.click(
      within(dialog).getByTestId("retrospective-held-hold-discard-discard"),
    );
    await waitFor(() => expect(choiceRequests(harness)).toHaveLength(2));
    await waitFor(() => {
      expect(
        within(dialog).queryByTestId("retrospective-held-hold-discard"),
      ).toBeNull();
    });
    expect(
      choiceRequests(harness).map((request) => ({
        path: new URL(request.url).pathname,
        body: request.body,
      })),
    ).toEqual([
      {
        path: choicePath("hold-apply", "apply"),
        body: { revision: 11, expectedLiveRevision: null },
      },
      {
        path: choicePath("hold-discard", "discard"),
        body: { revision: 12 },
      },
    ]);
  });

  it.each([
    ["gone", 404],
    ["forbidden", 403],
  ] as const)(
    "keeps the Team row until the server answers with %s",
    async (outcome, status) => {
      const holdId = `hold-${outcome}`;
      const row = held({
        id: holdId,
        kind: "variable",
        key: "NODE_ENV",
        heldRevision: 13,
        liveRevision: 5,
      });
      const scenario = createReviewHarness("admin", [row]);
      let resolveChoiceAnswer:
        | ((answer: EnvironmentTransportAnswer) => void)
        | null = null;
      const answer = new Promise<EnvironmentTransportAnswer>((resolve) => {
        resolveChoiceAnswer = resolve;
      });
      scenario.harness.cloudResponses.set(
        `POST ${choicePath(holdId, "apply")}`,
        () => answer,
      );
      renderTeamPage(scenario.harness);
      const dialog = await openReview();
      const rowTestId = `retrospective-held-${holdId}`;
      await within(dialog).findByTestId(`${rowTestId}-approve`);
      const readsBeforeChoice = operationReads(scenario.harness).length;

      fireEvent.click(within(dialog).getByTestId(`${rowTestId}-approve`));
      await waitFor(() =>
        expect(choiceRequests(scenario.harness)).toHaveLength(1),
      );
      expect(within(dialog).getByTestId(rowTestId)).toBeTruthy();

      act(() => {
        if (resolveChoiceAnswer === null) {
          throw new Error("the review answer was not held");
        }
        if (outcome === "gone") scenario.setRows([]);
        resolveChoiceAnswer(authnAnswer(status, { error: outcome }));
      });
      await waitFor(() => {
        expect(operationReads(scenario.harness).length).toBeGreaterThan(
          readsBeforeChoice,
        );
      });

      if (outcome === "gone") {
        await waitFor(() =>
          expect(within(dialog).queryByTestId(rowTestId)).toBeNull(),
        );
      } else {
        expect(
          await within(dialog).findByText(
            "You no longer have access to change these settings.",
          ),
        ).toBeTruthy();
        expect(within(dialog).getByTestId(rowTestId)).toBeTruthy();
      }
    },
  );

  it("keeps the pressed choice when onMutate changes the public variables before dispatch", async () => {
    const row = held({
      id: "hold-press",
      kind: "variable",
      key: "NODE_ENV",
      heldRevision: 14,
      liveRevision: 6,
      proposed: { value: "production" },
      current: { value: "development" },
    });
    const { harness, setRows } = createReviewHarness("admin", [row]);
    const gate = holdNextReviewMutation(harness, (variables) => {
      if (typeof variables !== "object" || variables === null) {
        throw new Error("the public review choice was not an object");
      }
      expect(Reflect.get(variables, "heldId")).toBe("hold-press");
      expect(Reflect.get(variables, "choice")).toBe("approve");
      Reflect.set(variables, "choice", "discard");
    });
    harness.cloudResponses.set(
      `POST ${choicePath("hold-press", "apply")}`,
      () => {
        setRows([]);
        return authnAnswer(200, {});
      },
    );
    renderTeamPage(harness);
    const dialog = await openReview();
    const reviewRow = await within(dialog).findByTestId(
      "retrospective-held-hold-press",
    );
    const approve = await within(reviewRow).findByRole("button", {
      name: "Approve",
    });

    fireEvent.click(approve);
    await gate.started;
    expect(choiceRequests(harness)).toEqual([]);
    await act(async () => {
      gate.release();
      await gate.settled;
    });

    expect(
      choiceRequests(harness).map((request) => ({
        path: new URL(request.url).pathname,
        body: request.body,
      })),
    ).toEqual([
      {
        path: choicePath("hold-press", "apply"),
        body: { revision: 14, expectedLiveRevision: 6 },
      },
    ]);
  });

  it("shows the newer masked Current value and revision after a conflict, then uses them only on a fresh press", async () => {
    const first = held({
      id: "hold-agent",
      kind: "agent_definition",
      key: "bootstrap",
      heldRevision: 8,
      liveRevision: 3,
      proposed: { text: "Proposed API_KEY=PROPOSED_SECRET" },
      current: { text: "Current API_KEY=OLD_SECRET" },
    });
    const second = held({
      id: "hold-agent",
      kind: "agent_definition",
      key: "bootstrap",
      heldRevision: 9,
      liveRevision: 4,
      proposed: { text: "Proposed API_KEY=PROPOSED_SECRET" },
      current: { text: "Newer API_KEY=LIVE_SECRET" },
    });
    const scenario = createReviewHarness("editor", [first]);
    let writes = 0;
    scenario.harness.cloudResponses.set(
      `POST ${choicePath("hold-agent", "apply")}`,
      () => {
        writes += 1;
        if (writes === 1) {
          scenario.setRows([second]);
          return authnAnswer(409, { code: "revision_conflict", current: null });
        }
        scenario.setRows([]);
        return authnAnswer(200, {});
      },
    );
    renderTeamPage(scenario.harness);
    const dialog = await openReview();
    const row = await within(dialog).findByTestId(
      "retrospective-held-hold-agent",
    );

    const initialApprove = await within(row).findByRole("button", {
      name: "Approve",
    });
    fireEvent.click(initialApprove);
    await waitFor(() =>
      expect(choiceRequests(scenario.harness)).toHaveLength(1),
    );
    await waitFor(() => {
      expect(
        within(row).getByRole("heading", { name: "Current · 4" }),
      ).toBeTruthy();
      expect(
        within(row).getByTestId("retrospective-held-hold-agent-discard"),
      ).toBeTruthy();
    });
    const textareas = within(row).getAllByRole("textbox", {
      name: "bootstrap text",
    });
    const proposedText = textareas[0];
    const currentText = textareas[1];
    if (
      !(proposedText instanceof HTMLTextAreaElement) ||
      !(currentText instanceof HTMLTextAreaElement)
    ) {
      throw new Error("agent text was not rendered as a read-only textarea");
    }
    expect(proposedText.value).toBe("Proposed API_KEY=•••");
    expect(currentText.value).toBe("Newer API_KEY=•••");
    expect(`${proposedText.value} ${currentText.value}`).not.toContain(
      "LIVE_SECRET",
    );
    expect(
      choiceRequests(scenario.harness).map((request) => ({
        path: new URL(request.url).pathname,
        body: request.body,
      })),
    ).toEqual([
      {
        path: choicePath("hold-agent", "apply"),
        body: { revision: 8, expectedLiveRevision: 3 },
      },
    ]);

    const refreshedApprove = await within(row).findByRole("button", {
      name: "Approve",
    });
    expect(refreshedApprove).toBeEnabled();
    fireEvent.click(refreshedApprove);
    await waitFor(() =>
      expect(choiceRequests(scenario.harness)).toHaveLength(2),
    );
    expect(
      choiceRequests(scenario.harness).map((request) => request.body),
    ).toEqual([
      { revision: 8, expectedLiveRevision: 3 },
      { revision: 9, expectedLiveRevision: 4 },
    ]);
  });

  it("renders the stored modern MCP, pack, and fallback values without a host catalogue", async () => {
    const rows = [
      held({
        id: "mcp-modern",
        kind: "mcp_server",
        key: "search-server",
        proposed: {
          mcpServerId: "server-new",
          toolToggles: { claude: { search: false, read: true } },
          offFor: ["cursor"],
        },
        current: {
          mcpServerId: "server-old",
          toolToggles: { claude: { search: true, read: false } },
          offFor: [],
        },
      }),
      held({
        id: "pack-policy",
        kind: "pack_policy",
        key: "claude-pack",
        proposed: { pinnedVersion: "1.3.0", autoDownload: true },
        current: { pinnedVersion: "1.2.0", autoDownload: false },
      }),
      held({
        id: "managed-profile",
        kind: "managed_profile",
        key: "claude:profile-1",
        proposed: {
          name: "Work A",
          color: null,
          harnessId: "claude",
          accountIdentity: "work-a@example.test",
          needsLink: false,
          enabled: true,
        },
        current: {
          name: "Work B",
          color: null,
          harnessId: "claude",
          accountIdentity: "work-b@example.test",
          needsLink: false,
          enabled: false,
        },
      }),
      held({
        id: "mcp-stdio",
        kind: "mcp_server",
        key: "legacy-server",
        proposed: {
          definition: {
            transport: "stdio",
            command: "npx",
            args: ["--api-key", "STDIO_SECRET"],
          },
          toolToggles: { claude: { search: false } },
        },
        current: {
          definition: {
            transport: "stdio",
            command: "node",
            args: ["./server"],
          },
          toolToggles: { claude: { search: true } },
        },
      }),
      held({
        id: "fallback-policy",
        kind: "fallback_policy",
        key: "fallback",
        proposed: {
          document: {
            enabled: true,
            ladder: ["profile", "tier", "wait", "notify"],
            graceWindowSeconds: 15,
            maxWaitMinutes: 360,
            returnToPreferred: "prompt",
            tierGroups: [
              {
                id: "fast",
                candidates: [
                  {
                    harnessId: "claude",
                    modelFamily: "sonnet*",
                    reasoningEffort: null,
                  },
                ],
              },
            ],
            defaultTierGroupId: "fast",
          },
        },
        current: {
          document: {
            enabled: false,
            ladder: ["profile", "tier", "wait", "notify"],
            graceWindowSeconds: 15,
            maxWaitMinutes: 360,
            returnToPreferred: "prompt",
            tierGroups: [
              {
                id: "fast",
                candidates: [
                  {
                    harnessId: "claude",
                    modelFamily: "sonnet*",
                    reasoningEffort: null,
                  },
                ],
              },
            ],
            defaultTierGroupId: "fast",
          },
        },
      }),
    ];
    const { harness } = createReviewHarness("admin", rows);
    renderTeamPage(harness);
    const dialog = await openReview();
    const mcp = await within(dialog).findByTestId(
      "retrospective-held-mcp-modern",
    );
    expect(mcp.textContent).toContain("server-new");
    expect(mcp.textContent).toContain("server-old");
    expect(mcp.textContent).toContain("Off: Cursor");
    expect(
      within(mcp)
        .getAllByRole("switch")
        .map((toggle) => ({
          name: toggle.getAttribute("aria-label"),
          checked: toggle.getAttribute("aria-checked"),
        })),
    ).toEqual([
      { name: "Claude Code search", checked: "false" },
      { name: "Claude Code read", checked: "true" },
      { name: "Claude Code search", checked: "true" },
      { name: "Claude Code read", checked: "false" },
    ]);

    const pack = within(dialog).getByTestId("retrospective-held-pack-policy");
    expect(pack.textContent).toContain(
      "claude-pack: 1.3.0 · Downloads automatically",
    );
    expect(pack.textContent).toContain("claude-pack: 1.2.0 · Manual download");
    const profile = within(dialog).getByTestId(
      "retrospective-held-managed-profile",
    );
    const profileNames = within(profile).getAllByRole("textbox", {
      name: "Profile name",
    });
    const proposedName = profileNames[0];
    const currentName = profileNames[1];
    if (
      !(proposedName instanceof HTMLInputElement) ||
      !(currentName instanceof HTMLInputElement)
    ) {
      throw new Error(
        "managed profile names were not rendered as read-only inputs",
      );
    }
    expect(proposedName.value).toBe("Work A");
    expect(currentName.value).toBe("Work B");
    expect(within(profile).queryByText("Needs a sign-in")).toBeNull();
    expect(within(profile).queryByRole("switch")).toBeNull();
    expect(profile.textContent).toContain("Claude Code · On");
    expect(profile.textContent).toContain("Claude Code · Off");
    expect(profile.textContent).toContain("work-a@example.test");
    expect(profile.textContent).toContain("work-b@example.test");
    const legacyMcp = within(dialog).getByTestId(
      "retrospective-held-mcp-stdio",
    );
    expect(legacyMcp.textContent).toContain("npx --api-key •••");
    expect(legacyMcp.textContent).not.toContain("STDIO_SECRET");
    const fallback = within(dialog).getByTestId(
      "retrospective-held-fallback-policy",
    );
    expect(fallback.textContent).toContain("Route automatically: On");
    expect(fallback.textContent).toContain("Route automatically: Off");
    expect(
      harness.messenger.calls.some(
        (call) => call.method === "environment.configuration.mcpServers.list",
      ),
    ).toBe(false);
  });

  it("renders deletes as Remove and withholds actions for unreadable held values", async () => {
    const rows = [
      held({
        id: "delete-old",
        kind: "variable",
        key: "OLD_SETTING",
        op: "delete",
        liveRevision: 7,
        current: { value: "still-current" },
      }),
      held({
        id: "unreadable-profile",
        kind: "managed_profile",
        key: "claude:profile-1",
        proposed: "not-a-profile-object",
        current: {
          name: "Current profile",
          color: null,
          harnessId: "claude",
          accountIdentity: "work@example.test",
          needsLink: false,
          enabled: true,
        },
      }),
    ];
    const { harness } = createReviewHarness("admin", rows);
    renderTeamPage(harness);
    const dialog = await openReview();
    const deletion = await within(dialog).findByTestId(
      "retrospective-held-delete-old",
    );
    expect(deletion.textContent).toContain("Remove OLD_SETTING");
    expect(
      within(deletion).getByRole("heading", { name: "Current · 7" }),
    ).toBeTruthy();
    const unreadable = within(dialog).getByTestId(
      "retrospective-held-unreadable-profile",
    );
    expect(
      within(unreadable).getByText("Couldn't read these settings."),
    ).toBeTruthy();
    expect(
      within(unreadable).queryByTestId(
        "retrospective-held-unreadable-profile-approve",
      ),
    ).toBeNull();
    expect(
      within(unreadable).queryByTestId(
        "retrospective-held-unreadable-profile-discard",
      ),
    ).toBeNull();
  });

  it("does not send a captured Team choice after the person's sign-in changes", async () => {
    const row = held({
      id: "hold-account",
      kind: "variable",
      key: "NODE_ENV",
      heldRevision: 14,
      liveRevision: 6,
    });
    const { harness } = createReviewHarness("admin", [row]);
    const gate = holdNextReviewMutation(harness, () => undefined);
    harness.cloudResponses.set(
      `POST ${choicePath("hold-account", "apply")}`,
      () => authnAnswer(200, {}),
    );
    renderTeamPage(harness);
    const dialog = await openReview();
    const reviewRow = await within(dialog).findByTestId(
      "retrospective-held-hold-account",
    );
    const approve = await within(reviewRow).findByRole("button", {
      name: "Approve",
    });

    fireEvent.click(approve);
    await gate.started;
    act(() => {
      harness.auth.applyExternalSession(
        authSessionForUser("user-2", "user-2-token"),
      );
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: "user-2",
          userName: "User Two",
          email: "user-2@example.com",
        },
        contextMetadata: { userId: "user-2", username: "user-2" },
        shareableTeams: [],
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      gate.release();
      await gate.settled;
    });

    expect(choiceRequests(harness)).toEqual([]);
  });

  it("keeps an open Team Review addressed to its team after navigating to Personal", async () => {
    const row = held({
      id: "hold-target",
      kind: "variable",
      key: "NODE_ENV",
      heldRevision: 15,
      liveRevision: 7,
    });
    const { harness, setRows } = createReviewHarness("admin", [row]);
    const gate = holdNextReviewMutation(harness, () => undefined);
    harness.cloudResponses.set(
      `POST ${choicePath("hold-target", "apply")}`,
      () => {
        setRows([]);
        return authnAnswer(200, {});
      },
    );
    renderTeamPage(harness);
    const dialog = await openReview();
    await within(dialog).findByTestId("retrospective-held-hold-target-approve");

    fireEvent.click(
      within(dialog).getByTestId("retrospective-held-hold-target-approve"),
    );
    await gate.started;
    act(() =>
      useSettingsEnvironmentPickStore.getState().setPick({ kind: "personal" }),
    );
    expect(useRetrospectiveSheetStore.getState().target).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      viewerId: VIEWER_ID,
    });
    expect(within(dialog).getByText("Acme")).toBeTruthy();

    await act(async () => {
      gate.release();
      await gate.settled;
    });
    expect(
      choiceRequests(harness).map((request) => new URL(request.url).pathname),
    ).toEqual([choicePath("hold-target", "apply")]);
  });

  it("does not send an old press after the same person signs out and back in", async () => {
    const row = held({
      id: "hold-reentry",
      kind: "variable",
      key: "NODE_ENV",
      heldRevision: 16,
      liveRevision: 8,
    });
    const { harness } = createReviewHarness("admin", [row]);
    const gate = holdNextReviewMutation(harness, () => undefined);
    renderTeamPage(harness);
    const dialog = await openReview();
    const reviewRow = await within(dialog).findByTestId(
      "retrospective-held-hold-reentry",
    );
    const approve = await within(reviewRow).findByRole("button", {
      name: "Approve",
    });

    fireEvent.click(approve);
    await gate.started;
    act(() => {
      harness.auth.applyExternalSession({ status: "signed-out" });
      useAuthStore.setState({
        status: "signed-out",
        profile: null,
        contextMetadata: null,
        shareableTeams: [],
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => {
      harness.auth.applyExternalSession(
        authSessionForUser(VIEWER_ID, "user-1-reentry-token"),
      );
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: VIEWER_ID,
          userName: "User One",
          email: "user-1@example.com",
        },
        contextMetadata: { userId: VIEWER_ID, username: "user-1" },
        shareableTeams: [{ teamId: "team-a", slug: "acme", avatarUrl: null }],
      });
    });

    await act(async () => {
      gate.release();
      await gate.settled;
    });
    expect(choiceRequests(harness)).toEqual([]);
  });

  it("keeps a captured press valid across an ordinary same-person bearer rotation", async () => {
    const row = held({
      id: "hold-rotation",
      kind: "variable",
      key: "NODE_ENV",
      heldRevision: 17,
      liveRevision: 9,
    });
    const { harness, setRows } = createReviewHarness("admin", [row]);
    const gate = holdNextReviewMutation(harness, () => undefined);
    harness.cloudResponses.set(
      `POST ${choicePath("hold-rotation", "apply")}`,
      () => {
        setRows([]);
        return authnAnswer(200, {});
      },
    );
    renderTeamPage(harness);
    const dialog = await openReview();
    await within(dialog).findByTestId(
      "retrospective-held-hold-rotation-approve",
    );

    fireEvent.click(
      within(dialog).getByTestId("retrospective-held-hold-rotation-approve"),
    );
    await gate.started;
    act(() => {
      harness.auth.applyExternalSession(
        authSessionForUser(VIEWER_ID, "user-1-rotated-token"),
      );
    });

    await act(async () => {
      gate.release();
      await gate.settled;
    });
    expect(
      choiceRequests(harness).map((request) => new URL(request.url).pathname),
    ).toEqual([choicePath("hold-rotation", "apply")]);
  });
});
