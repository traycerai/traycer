import { StoppedSandboxSendReceiptStrip } from "@/components/sandboxes/stopped-sandbox-send-receipts";
import {
  stoppedReceiptPicks,
  useStoppedSandboxSendReceiptStore,
  type StoppedSandboxSendReceipt,
} from "@/stores/sandboxes/stopped-sandbox-send-receipt-store";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toastFromAuthError } from "@/lib/auth-error-toast";
import type { ReactNode } from "react";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxLifecycleVerbFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { SandboxCard } from "@/components/hosts/sandbox-card";
import { SandboxDetailsDrawerHost } from "@/components/hosts/sandbox-details-drawer";
import { SandboxTileStateFrame } from "@/components/hosts/sandbox-tile-state-frame";
import { SandboxRowActions } from "@/components/settings/panels/sandbox-row-actions";
import {
  createFakeSandboxBinding,
  refusal,
  type FakeSandboxBinding,
} from "@/hooks/sandboxes/__tests__/sandbox-binding-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import type { SandboxPageConfiguration } from "@/lib/sandboxes/sandbox-row-lines";
import type { SandboxCreditSource } from "@traycer/protocol/host/sandbox-control";
import type { SandboxRowVerb } from "@/hooks/sandboxes/use-sandbox-operation";
import { useAuthStore } from "@/stores/auth/auth-store";
import { closeSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";

const mocks = vi.hoisted(() => ({
  binding: null as FakeSandboxBinding | null,
  entry: null as RemoteHostDirectoryEntry | null,
  configuration: { kind: "personal" } as SandboxPageConfiguration,
}));
// These cases are about the sandboxes-on behaviour: without it the rows read an
// empty list and the staging surface is withheld.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
  useRunnerHostOrNull: () => ({ signInUrl: "https://example.test" }),
}));
vi.mock("@/lib/host/fleet-refresh", () => ({ requestFleetRefresh: vi.fn() }));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/lib/auth-error-toast", () => ({ toastFromAuthError: vi.fn() }));
vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/host/use-composer-surface-host-pin", () => ({
  useComposerSurfaceHostKey: () => "landing:row-operation",
}));
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ close: vi.fn() }),
}));
vi.mock("@/components/composer/use-staged-sandbox-send", () => ({
  useStagedSandboxRunner: () => vi.fn(),
  startStagedTerminal: vi.fn(),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-session-report", () => ({
  useSandboxSessionReport: () => ({
    report: { kind: "unknown" },
    failed: false,
  }),
}));
vi.mock("@/components/host/host-restart-sessions", () => ({
  KnownHostSessionsList: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-configurations", () => ({
  useSandboxConfigurations: () => ({ configurations: [], complete: true }),
  sandboxConfigurationOf: () => ({ kind: "personal" }),
  useSandboxWakeString: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-costs-query", () => ({
  useSandboxCosts: () => ({ data: undefined }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: undefined }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-runway-warning", () => ({
  useSandboxRunwayWarning: () => ({ kind: "none" }),
}));
vi.mock("@/hooks/sandboxes/use-refresh-sandbox-costs", () => ({
  useRefreshSandboxCosts: () => undefined,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-egress-events", () => ({
  useSandboxEgressEvents: () => [],
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-grants-query", () => ({
  useSandboxGrants: () => ({ data: undefined }),
}));
vi.mock(
  "@/hooks/sandboxes/use-sandbox-repair-guest-configuration-mutation",
  () => ({
    useSandboxRepairGuestConfiguration: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useSandboxRepairGuestConfigurationOnHost: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useSandboxRepairGuestSetupOnHost: () => ({
      isPending: false,
      mutate: vi.fn(),
    }),
    useSandboxRetryApplyingSupported: () => false,
    useSandboxGuestSetupRepairSupported: () => false,
    useSandboxSettingsOperation: () => null,
  }),
);
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-sbx-1",
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => mocks.entry,
}));

beforeEach(() => {
  mocks.binding = createFakeSandboxBinding();
  mocks.entry = null;
  useStoppedSandboxSendReceiptStore.setState({ receipts: {}, strips: {} });
  mocks.configuration = { kind: "personal" };
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId: "u1", userName: "Ada", email: "ada@example.test" },
    contextMetadata: { userId: "u1", username: "ada" },
  });
});
afterEach(() => {
  cleanup();
  closeSandboxDetails();
  useAuthStore.setState({
    status: "signed-out",
    contextMetadata: null,
    profile: null,
  });
});

interface VerbCase {
  readonly verb: SandboxRowVerb;
  readonly label: string;
  readonly pending: string;
  readonly reference: string;
  readonly initial: HostSandboxState;
  readonly reached: HostSandboxState;
}
const SUSPEND_CASE: VerbCase = {
  verb: "suspend",
  label: "Suspend",
  pending: "Suspending · pending",
  reference: "SBX-0601",
  initial: "awake",
  reached: "suspended",
};
const CASES: readonly VerbCase[] = [
  {
    verb: "start",
    label: "Start",
    pending: "Starting · pending",
    reference: "SBX-0508",
    initial: "stopped",
    reached: "awake",
  },
  {
    verb: "resume",
    label: "Resume",
    pending: "Resuming · pending",
    reference: "SBX-0507",
    initial: "suspended",
    reached: "awake",
  },
  SUSPEND_CASE,
  {
    verb: "stop",
    label: "Stop",
    pending: "Stopping · pending",
    reference: "SBX-0701",
    initial: "awake",
    reached: "stopped",
  },
  {
    verb: "destroy",
    label: "Destroy",
    pending: "Destroying · pending",
    reference: "SBX-0801",
    initial: "awake",
    reached: "destroyed",
  },
];

function Rows(): ReactNode {
  const list = useSandboxList();
  return list.data?.sandboxes.map((summary) => (
    <section key={summary.id} aria-label={summary.displayName}>
      <SandboxRowActions
        summary={summary}
        configuration={mocks.configuration}
        unreachable={false}
        frozenNeedsOwnCredits={false}
        settingsFailed={false}
      />
    </section>
  ));
}

function setup(testCase: VerbCase) {
  const binding = mocks.binding;
  if (binding === null) throw new Error("Expected the signed-in binding");
  const answer = Promise.withResolvers<SandboxLifecycleVerbFetchResult>();
  binding.auth.runSandboxVerb.mockReturnValue(answer.promise);
  binding.auth.destroySandbox.mockReturnValue(answer.promise);
  const main = sandboxSummaryFixture({
    id: "sbx-build",
    displayName: "build-box",
    state: testCase.initial,
  });
  const other = sandboxSummaryFixture({
    id: "sbx-other",
    displayName: "other-box",
    hostId: "host-other",
  });
  binding.auth.listSandboxes.mockResolvedValue({
    kind: "ok",
    response: { sandboxes: [main, other] },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Rows />
      <SandboxDetailsDrawerHost />
    </QueryClientProvider>,
  );
  return { answer, binding, client, main, other };
}

async function press(testCase: VerbCase): Promise<HTMLElement> {
  const row = await screen.findByRole("region", { name: "build-box" });
  if (testCase.verb === "stop" || testCase.verb === "destroy") {
    await userEvent.click(
      within(row).getByRole("button", { name: "More actions for build-box" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: testCase.label }),
    );
  } else {
    await userEvent.click(
      within(row).getByRole("button", { name: testCase.label }),
    );
  }
  if (
    testCase.verb === "suspend" ||
    testCase.verb === "stop" ||
    testCase.verb === "destroy"
  ) {
    const dialog = screen.getByRole("dialog");
    if (testCase.verb === "destroy") {
      await userEvent.type(
        within(dialog).getByRole("textbox", {
          name: "Type the name to confirm",
        }),
        "build-box",
      );
    }
    await userEvent.click(
      within(dialog).getByRole("button", { name: testCase.label }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  return row;
}

describe("sandbox row operations", () => {
  it("keeps a stopped receipt and its draft when Start fails, then clears it after a successful Retry", async () => {
    const testCase = CASES.find((entry) => entry.verb === "start");
    if (testCase === undefined) throw new Error("Expected the Start case");
    const { answer, binding, client, main } = setup(testCase);
    await screen.findByRole("region", { name: "build-box" });
    useNewConversationModalStore.getState().setContent("receipt-epic", {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "keep this draft" }],
        },
      ],
    });
    const draftId =
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        "receipt-epic"
      ]?.draftId ?? null;
    const receipt: StoppedSandboxSendReceipt = {
      id: "receipt",
      kind: "stopped",
      sandboxId: main.id,
      name: main.displayName,
      confirmedAt: Date.now() + 60_000,
      userId: "u1",
      epicId: "receipt-epic",
      returned: {
        kind: "task",
        epicId: "receipt-epic",
        parentId: null,
        placement: null,
        draftId,
      },
      existingSendIds: new Set(),
      picks: stoppedReceiptPicks(
        "receipt-epic",
        useSurfaceHostSelectionStore.getState().selections,
        useStagedSandboxStore.getState().bySurface,
      ),
    };
    useStoppedSandboxSendReceiptStore.setState({ receipts: { receipt } });
    render(
      <QueryClientProvider client={client}>
        <StoppedSandboxSendReceiptStrip epicId="receipt-epic" tabId="tab" />
      </QueryClientProvider>,
    );
    const strip = screen.getByTestId("sandbox-stopped-line");
    await userEvent.click(within(strip).getByRole("button", { name: "Start" }));
    await act(async () => {
      answer.resolve({
        ...refusal(402, "insufficient_credit"),
        shortfallMc: 210,
        creditSource: "personal",
      });
      await answer.promise;
    });
    const alert = await within(strip).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't start build-box");
    expect(
      within(alert).getByRole("button", { name: "Add credits ↗" }),
    ).toBeDefined();
    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId[
        "receipt-epic"
      ]?.draftId,
    ).toBe(draftId);
    binding.auth.runSandboxVerb.mockResolvedValue({
      kind: "ok",
      settled: true,
      state: "awake",
    });
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.queryByTestId("sandbox-stopped-line")).toBeNull(),
    );
    expect(toastFromAuthError).not.toHaveBeenCalled();
  });

  it.each<{ source: SandboxCreditSource; pot: string }>([
    { source: "team-allowance", pot: "your pool-e2e-fixture allowance is" },
    { source: "team", pot: "your pool-e2e-fixture credits are" },
    { source: "personal", pot: "your credits are" },
  ])(
    "keeps a $source refusal and remedies on the row without a toast",
    async ({ source, pot }) => {
      mocks.configuration =
        source === "personal"
          ? { kind: "personal" }
          : {
              kind: "team",
              teamId: "team-a",
              teamName: "pool-e2e-fixture",
              environmentId: "team-env",
            };
      const testCase = CASES.find((entry) => entry.verb === "resume");
      if (testCase === undefined) throw new Error("Expected the Resume case");
      const { answer } = setup(testCase);
      const row = await press(testCase);
      await act(async () => {
        answer.resolve({
          kind: "refused",
          status: 402,
          code: "insufficient_credit",
          reason: "denied",
          shortfallMc: 210,
          newRateMcPerHour: 210,
          currentAwakeBurnMcPerHour: 0,
          message: null,
          creditSource: source,
        });
        await answer.promise;
      });
      const failure = await within(row).findByRole("alert");
      expect(failure.textContent).toContain(
        `Couldn't resume build-box · ${pot} short $0.21. $0.21 more wakes it for an hour.`,
      );
      expect(
        within(failure)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Add credits ↗", "Retry", "Details"]);
      expect(toastFromAuthError).not.toHaveBeenCalled();
    },
  );

  it("keeps an unknown credit source generic on a team resume refusal", async () => {
    mocks.configuration = {
      kind: "team",
      teamId: "team-a",
      teamName: "Acme",
      environmentId: "team-env",
    };
    const testCase = CASES.find((entry) => entry.verb === "resume");
    if (testCase === undefined) throw new Error("Expected the Resume case");
    const { answer } = setup(testCase);
    const row = await press(testCase);
    await act(async () => {
      answer.resolve({
        ...refusal(402, "insufficient_credit"),
        creditSource: null,
        shortfallMc: null,
      });
      await answer.promise;
    });
    const failure = await within(row).findByRole("alert");
    expect(failure.textContent).toContain(
      "Couldn't resume build-box · not enough credits to wake this sandbox for an hour.",
    );
    expect(
      within(failure)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Add credits ↗", "Retry", "Details"]);
    expect(toastFromAuthError).not.toHaveBeenCalled();
  });

  it("shows the Settings dialog's pending operation and its failure on the card too", async () => {
    const { answer, client, main } = setup(SUSPEND_CASE);
    render(
      <QueryClientProvider client={client}>
        <SandboxCard
          hostName={main.displayName}
          hostState="online"
          sandbox={{
            state: main.state,
            frozen: false,
            summary: main,
            teamOwned: false,
          }}
          onDestroyed={null}
        />
      </QueryClientProvider>,
    );
    const card = screen.getByTestId("sandbox-card");
    await press(SUSPEND_CASE);
    expect((await within(card).findByRole("status")).textContent).toBe(
      SUSPEND_CASE.pending,
    );
    expect(
      within(card)
        .getByRole("button", { name: SUSPEND_CASE.pending })
        .hasAttribute("disabled"),
    ).toBe(true);
    await userEvent.click(
      within(card).getByRole("button", { name: "Destroy" }),
    );
    const destroyDialog = screen.getByRole("dialog");
    await userEvent.type(
      within(destroyDialog).getByRole("textbox", {
        name: "Type the name to confirm",
      }),
      "build-box",
    );
    expect(
      within(destroyDialog)
        .getByRole("button", { name: "Destroy" })
        .hasAttribute("disabled"),
    ).toBe(false);
    await userEvent.click(
      within(destroyDialog).getByRole("button", { name: "Cancel" }),
    );
    await act(async () => {
      answer.resolve(refusal(409, "sandbox_busy"));
      await answer.promise;
    });
    const failure = await within(card).findByRole("alert");
    expect(failure.textContent).toContain(
      "Couldn't suspend build-box · SBX-0601",
    );
    await userEvent.click(
      within(failure).getByRole("button", { name: "Details" }),
    );
    expect(
      (await screen.findByRole("region", { name: "History" })).textContent,
    ).toContain("Failure code: sandbox_busy");
    await userEvent.keyboard("{Escape}");
    const retried = Promise.withResolvers<SandboxLifecycleVerbFetchResult>();
    mocks.binding?.auth.runSandboxVerb.mockReturnValue(retried.promise);
    await userEvent.click(
      within(failure).getByRole("button", { name: "Retry" }),
    );
    expect((await within(card).findByRole("status")).textContent).toBe(
      SUSPEND_CASE.pending,
    );
    expect(mocks.binding?.auth.runSandboxVerb).toHaveBeenCalledTimes(2);
    await act(async () => {
      retried.resolve({ kind: "ok", settled: true, state: "suspended" });
      await retried.promise;
    });
  });

  it("disables the tile's wake button while the Settings row wakes that sandbox", async () => {
    const testCase = CASES.find((entry) => entry.verb === "resume");
    if (testCase === undefined) throw new Error("Expected the Resume case");
    const { answer, client, main } = setup(testCase);
    mocks.entry = {
      ...sandboxHostEntry(main.hostId, null),
      sandbox: {
        state: "suspended",
        frozen: false,
        profile: "agent",
        ownerTeamName: null,
        ownerTeamId: null,
      },
    };
    render(
      <QueryClientProvider client={client}>
        <SandboxTileStateFrame chat={null}>
          <textarea aria-label="Tile body" />
        </SandboxTileStateFrame>
      </QueryClientProvider>,
    );
    const wake = await screen.findByTestId("sandbox-tile-overlay-wake");
    expect(wake.hasAttribute("disabled")).toBe(false);
    await press(testCase);
    await waitFor(() => expect(wake.hasAttribute("disabled")).toBe(true));
    expect(wake.textContent).toContain("Resume");
    await act(async () => {
      answer.resolve({ kind: "ok", settled: true, state: "awake" });
      await answer.promise;
    });
    await waitFor(() => expect(wake.hasAttribute("disabled")).toBe(false));
  });

  it("shows the same operation in another mounted view of that sandbox", async () => {
    const testCase = SUSPEND_CASE;
    const { answer, client, main } = setup(testCase);
    render(
      <QueryClientProvider client={client}>
        <section aria-label="Another view">
          <SandboxRowActions
            summary={main}
            configuration={mocks.configuration}
            unreachable={false}
            frozenNeedsOwnCredits={false}
            settingsFailed={false}
          />
        </section>
      </QueryClientProvider>,
    );
    await press(testCase);
    const otherView = screen.getByRole("region", { name: "Another view" });
    expect((await within(otherView).findByRole("status")).textContent).toBe(
      testCase.pending,
    );
    expect(
      within(otherView)
        .getByRole("button", { name: testCase.pending })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      answer.resolve({ kind: "ok", settled: true, state: "suspended" });
      await answer.promise;
    });
  });

  it("uses the refusal's mapped support reference before the verb's reference", async () => {
    const testCase = SUSPEND_CASE;
    const { answer } = setup(testCase);
    const row = await press(testCase);
    await act(async () => {
      answer.resolve(refusal(503, "provider-error"));
      await answer.promise;
    });
    expect((await within(row).findByRole("alert")).textContent).toContain(
      "Couldn't suspend build-box · SBX-0413",
    );
  });

  it("keeps a pending operation and its later refusal with the account that started it", async () => {
    const testCase = SUSPEND_CASE;
    const { answer } = setup(testCase);
    const row = await press(testCase);
    await within(row).findByRole("status");
    act(() =>
      useAuthStore.setState({
        contextMetadata: { userId: "u2", username: "bea" },
      }),
    );
    const currentRow = await screen.findByRole("region", { name: "build-box" });
    expect(within(currentRow).queryByRole("status")).toBeNull();
    await act(async () => {
      answer.resolve(refusal(409, "sandbox_busy"));
      await answer.promise;
    });
    expect(within(currentRow).queryByRole("alert")).toBeNull();
    expect(
      within(currentRow)
        .getByRole("button", { name: "Suspend" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each(CASES)(
    "shows $verb pending on its disabled button, leaves another sandbox alone, and settles on success",
    async (testCase) => {
      const { answer, binding, main, other } = setup(testCase);
      const row = await press(testCase);

      expect((await within(row).findByRole("status")).textContent).toBe(
        testCase.pending,
      );
      expect(
        within(row)
          .getByRole("button", { name: testCase.pending })
          .hasAttribute("disabled"),
      ).toBe(true);
      await userEvent.click(
        within(row).getByRole("button", { name: "More actions for build-box" }),
      );
      expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
      ).toEqual(["Details"]);
      await userEvent.keyboard("{Escape}");
      const otherRow = screen.getByRole("region", { name: "other-box" });
      expect(within(otherRow).queryByRole("status")).toBeNull();
      expect(
        within(otherRow)
          .getByRole("button", { name: "Suspend" })
          .hasAttribute("disabled"),
      ).toBe(false);

      binding.auth.listSandboxes.mockResolvedValue({
        kind: "ok",
        response: {
          sandboxes:
            testCase.verb === "destroy"
              ? [other]
              : [{ ...main, state: testCase.reached }, other],
        },
      });
      await act(async () => {
        answer.resolve({ kind: "ok", settled: true, state: testCase.reached });
        await answer.promise;
      });
      if (testCase.verb === "destroy") {
        await waitFor(() =>
          expect(
            screen.queryByRole("region", { name: "build-box" }),
          ).toBeNull(),
        );
      } else {
        const nextLabel = new Map<HostSandboxState, string>([
          ["awake", "Suspend"],
          ["stopped", "Start"],
          ["suspended", "Resume"],
        ]).get(testCase.reached);
        if (nextLabel === undefined)
          throw new Error("Expected a settled action");
        expect(
          (
            await within(row).findByRole("button", { name: nextLabel })
          ).hasAttribute("disabled"),
        ).toBe(false);
        expect(within(row).queryByRole("status")).toBeNull();
      }
    },
  );

  it.each(CASES)(
    "keeps $verb's typed refusal on the row and in Details, then Retry runs it again",
    async (testCase) => {
      const { answer, binding, client } = setup(testCase);
      const row = await press(testCase);
      await act(async () => {
        answer.resolve(refusal(409, "sandbox_busy"));
        await answer.promise;
      });
      const line = await within(row).findByRole("alert");
      const sentence = `Couldn't ${testCase.verb} build-box · ${testCase.reference}`;
      expect(line.textContent).toContain(sentence);
      // An identical list refresh must not erase the local outcome.
      await act(async () => {
        await client.invalidateQueries();
      });
      expect(within(row).getByRole("alert").textContent).toContain(sentence);
      expect(
        within(screen.getByRole("region", { name: "other-box" })).queryByRole(
          "alert",
        ),
      ).toBeNull();

      await userEvent.click(
        within(line).getByRole("button", { name: "Details" }),
      );
      const history = await screen.findByRole("region", { name: "History" });
      expect(history.textContent).toContain(sentence);
      expect(history.textContent).toContain(
        "It's in use (an agent turn, a running shell or an open tab), so it stays awake.",
      );
      expect(history.textContent).toContain("Failure code: sandbox_busy");
      expect(history.textContent).toContain(
        `Support reference: ${testCase.reference}`,
      );
      await userEvent.keyboard("{Escape}");

      const retry = Promise.withResolvers<SandboxLifecycleVerbFetchResult>();
      binding.auth.runSandboxVerb.mockReturnValue(retry.promise);
      binding.auth.destroySandbox.mockReturnValue(retry.promise);
      await userEvent.click(
        within(line).getByRole("button", { name: "Retry" }),
      );
      expect((await within(row).findByRole("status")).textContent).toBe(
        testCase.pending,
      );
      expect(within(row).queryByRole("alert")).toBeNull();
      if (testCase.verb === "destroy") {
        expect(binding.auth.destroySandbox.mock.calls).toEqual([
          ["sbx-build", false],
          ["sbx-build", false],
        ]);
      } else {
        expect(
          binding.auth.runSandboxVerb.mock.calls.map(([id, verb]) => [
            id,
            verb,
          ]),
        ).toEqual([
          ["sbx-build", testCase.verb],
          ["sbx-build", testCase.verb],
        ]);
      }
      await act(async () => {
        retry.resolve({ kind: "ok", settled: true, state: testCase.reached });
        await retry.promise;
      });
      await waitFor(() => expect(within(row).queryByRole("status")).toBeNull());
      expect(within(row).queryByRole("alert")).toBeNull();
    },
  );
});
