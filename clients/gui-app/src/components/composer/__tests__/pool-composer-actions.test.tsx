import {
  mountTestSelectionAuthority,
  type SelectionAuthorityFixture,
} from "@/lib/host/test-support/selection-authority-fixture";
import { RETURN_TO_TARGET_STABILITY_MS } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type {
  SandboxCatalogue,
  SandboxCreateRequest,
} from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { SandboxCreateFetchResult } from "@traycer-clients/shared/host-client/sandbox-control";
import type { TeamEnvironmentFetchResult } from "@traycer-clients/shared/host-client/sandbox-secrets";
import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";
import {
  attachTaskEnvironmentViaHttp,
  type TaskEnvironmentAttachmentRequest,
} from "@traycer-clients/shared/host-client/task-environment-attachment";
import type { ActivationOutcome } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import {
  teamSubscription,
  userSubscription,
  userWith,
} from "@/lib/sandboxes/__tests__/auth-user-fixture";
import { readinessCatalogue } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";
import type { SandboxConfigurationDefaults } from "@/lib/sandboxes/sandbox-stage-model";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { sandboxHostEntry } from "@/lib/sandboxes/__tests__/sandbox-host-directory-fixture";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

const NEW_HOST_ID = "sandbox-under-test";
const SANDBOX_ID = "sbx_under_test";
const PERSONAL_SANDBOX = {
  hostId: NEW_HOST_ID,
  kind: "sandbox",
  teamOwned: false,
} as const;
const TEAM_SANDBOX = { ...PERSONAL_SANDBOX, teamOwned: true };
const COMPETING_COMPUTER = {
  hostId: "other-computer",
  kind: "remote",
  teamOwned: false,
} as const;
let authority: SelectionAuthorityFixture;

const harness = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    createInput: null as SandboxCreateRequest | null,
    user: null as AuthenticatedUser | null,
    catalogue: null as SandboxCatalogue | null,
    entry: null as HostDirectoryEntry | null,
    directoryListeners: new Set<() => void>(),
    activate:
      vi.fn<
        (
          option: HostScopeOption,
          report: (show: () => void) => void,
        ) => Promise<ActivationOutcome>
      >(),
    openTeam: vi.fn<(hostId: string) => { readonly close: () => void }>(),
    closeTeam: vi.fn(),
    place: vi.fn(),
    controlUnavailable: null as string | null,
    originCurrent: true,
    originGeneration: 0,
    defaults: vi.fn<(key: string) => SandboxConfigurationDefaults | null>(),
    openSettings: vi.fn(),
    listEnvironments: vi.fn(),
    getTeamEnvironment:
      vi.fn<(teamId: string) => Promise<TeamEnvironmentFetchResult>>(),
    attachmentTransport:
      vi.fn<
        () => Promise<{ readonly status: number; readonly text: string | null }>
      >(),
    attachmentMutation: null as null | {
      readonly mutateAsync: (input: {
        readonly epicId: string;
        readonly teamId: string;
        readonly operation: EnvironmentCloud;
      }) => Promise<{ readonly environmentId: string }>;
    },
    createSandbox:
      vi.fn<
        (input: SandboxCreateRequest) => Promise<SandboxCreateFetchResult>
      >(),
    toastError: vi.fn(),
    placement: null as {
      readonly resolvedHostId: string | null;
      readonly pin: { readonly setSelection: (hostId: string) => void };
    } | null,
  };
});

vi.mock("@/lib/host", () => {
  const auth = {
    sandboxControlUnavailableReason: () => harness.controlUnavailable,
    environmentCloud: () => {
      const originGeneration = harness.originGeneration;
      return {
        onOriginSignIn: () =>
          harness.originCurrent &&
          harness.originGeneration === originGeneration,
      };
    },
    createSandbox: harness.createSandbox,
    listEnvironments: harness.listEnvironments,
    getTeamEnvironment: harness.getTeamEnvironment,
    attachTaskEnvironment: (request: TaskEnvironmentAttachmentRequest) =>
      attachTaskEnvironmentViaHttp(
        "https://cloud.invalid",
        "fixture-token",
        null,
        harness.attachmentTransport,
        request,
      ),
  };
  const directory = {
    knownHostIds: () => [],
    refresh: vi.fn(),
    findById: (hostId: string) =>
      harness.entry?.hostId === hostId ? harness.entry : null,
    onChange: (listener: () => void) => {
      harness.directoryListeners.add(listener);
      return { dispose: () => harness.directoryListeners.delete(listener) };
    },
  };
  return { useHostBinding: () => ({ auth, directory }) };
});
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: harness.openSettings }),
}));
vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: harness.user }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({ data: harness.catalogue, isError: false }),
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", () => ({
  useSandboxDefaultsLookup: () => harness.defaults,
}));
vi.mock("@/hooks/sandboxes/use-team-bundle-balances", () => ({
  useTeamBundleBalances: () => () => 0,
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useMakeActiveHost: () => ({ makeActiveWithWakeNotice: harness.activate }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "origin-computer",
}));
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useEpicConversationPlacement: () => ({
    target: { resolvedHostId: harness.placement?.resolvedHostId ?? null },
    pin: harness.placement?.pin,
  }),
}));
vi.mock("@/hooks/host/use-pool-computer-unavailable", () => ({
  usePoolComputerUnavailable: () => true,
}));
vi.mock("@/hooks/epic/use-epic-attach-environment-mutation", async () => {
  const actual = await vi.importActual<
    typeof import("@/hooks/epic/use-epic-attach-environment-mutation")
  >("@/hooks/epic/use-epic-attach-environment-mutation");
  return {
    ...actual,
    useEpicAttachEnvironment: (
      ...args: Parameters<typeof actual.useEpicAttachEnvironment>
    ) => {
      if (harness.attachmentMutation !== null)
        return harness.attachmentMutation;
      return actual.useEpicAttachEnvironment(...args);
    },
  };
});
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => harness.openTeam,
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: { error: harness.toastError },
}));

import { PoolComposerActions } from "@/components/composer/pool-composer-actions";
import { NewConversationModalBody } from "@/components/epic-canvas/sidebar/new-conversation-modal";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

function testUser(): AuthenticatedUser {
  return userWith(
    userSubscription({
      totalPlanCredits: 100,
      consumedFromPlan: 0,
      bonusCredits: 0,
      consumedFromBonus: 0,
      bundleRemaining: 100,
    }),
    [teamSubscription(100)],
  );
}

function renderActions(epicId: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PoolComposerActions
        epicId={epicId}
        surfaceKey={epicId === null ? "landing-test" : `task:${epicId}`}
        place={harness.place}
        watchPlacement={null}
      />
    </QueryClientProvider>,
  );
}

function renderTaskModalActions(epicId: string, tabId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NewConversationModalBody
        epicId={epicId}
        tabId={tabId}
        placement={null}
        parentId={null}
        hostId={null}
        dismissPickerRef={{ current: null }}
        onSubmitted={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function openModalRequest(
  epicId: string,
  tabId: string,
  parentId: string | null,
): void {
  useNewConversationModalOpenStore.getState().open({
    epicId,
    tabId,
    placement: null,
    parentId,
    hostId: null,
  });
}

function fakeModalTaskAttachment(): void {
  harness.attachmentMutation = {
    mutateAsync: () => Promise.resolve({ environmentId: "team-env" }),
  };
}

beforeEach(() => {
  authority = mountTestSelectionAuthority({ hosts: [] });
  useAddHostDialogStore.getState().closeDialog();
  harness.events.length = 0;
  harness.createInput = null;
  harness.entry = null;
  harness.directoryListeners.clear();
  harness.activate.mockReset();
  harness.activate.mockResolvedValue("saved");
  harness.openTeam.mockReset();
  harness.openTeam.mockReturnValue({ close: harness.closeTeam });
  harness.closeTeam.mockClear();
  harness.place.mockClear();
  harness.user = testUser();
  harness.catalogue = readinessCatalogue({
    warm: 0,
    coldCreateMeasuredMs: 60_000,
  });
  harness.controlUnavailable = null;
  harness.originCurrent = true;
  harness.originGeneration = 0;
  harness.defaults.mockReset();
  harness.defaults.mockReturnValue(null);
  harness.openSettings.mockReset();
  harness.listEnvironments.mockReset();
  harness.listEnvironments.mockImplementation(() => {
    harness.events.push("list");
    return Promise.resolve({
      kind: "ok",
      list: {
        environments: [
          {
            environmentId: "team-env",
            ownerKind: "organization",
            ownerId: "team-1",
          },
        ],
      },
    });
  });
  harness.getTeamEnvironment.mockReset();
  harness.getTeamEnvironment.mockResolvedValue({
    kind: "ok",
    environmentId: "team-env",
  });
  harness.attachmentTransport.mockReset();
  harness.attachmentTransport.mockImplementation(() => {
    harness.events.push("attach");
    return Promise.resolve({
      status: 200,
      text: JSON.stringify({ attached: true }),
    });
  });
  harness.createSandbox.mockReset();
  harness.createSandbox.mockImplementation((input: SandboxCreateRequest) => {
    harness.events.push("create");
    harness.createInput = input;
    return Promise.resolve({ kind: "network-error", detail: "offline" });
  });
  harness.toastError.mockReset();
  harness.attachmentMutation = null;
  harness.placement = {
    resolvedHostId: "origin-computer",
    pin: { setSelection: harness.place },
  };
  useNewConversationModalOpenStore.getState().close();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSelectionAuthorityStore.getState().reset();
  useAddHostDialogStore.getState().closeDialog();
  useNewConversationModalOpenStore.getState().close();
  useEpicCanvasStore.getState().discardTabState("pool-start-tab");
  useEpicCanvasStore.getState().discardTabState("pool-origin-tab");
});

function acceptCreate(wakeBudgetMs: number | undefined): void {
  harness.createSandbox.mockImplementationOnce((input) => {
    harness.events.push("create");
    harness.createInput = input;
    return Promise.resolve({
      kind: "ok",
      accepted: {
        sandboxId: SANDBOX_ID,
        hostId: NEW_HOST_ID,
        sandbox: sandboxSummaryFixture({
          id: SANDBOX_ID,
          hostId: NEW_HOST_ID,
          state: "creating",
          ...(wakeBudgetMs === undefined ? {} : { wakeBudgetMs }),
        }),
      },
    });
  });
}

function publishSandbox(entry: HostDirectoryEntry): void {
  harness.entry = entry;
  harness.directoryListeners.forEach((listener) => listener());
}

async function personalSandboxReady(): Promise<void> {
  authority.publishFleet([PERSONAL_SANDBOX], null);
  authority.connectComputer(NEW_HOST_ID);
  await authority.activate(NEW_HOST_ID);
}

function teamSandboxReady(otherComputerIsReady: boolean): void {
  authority.publishFleet(
    otherComputerIsReady ? [TEAM_SANDBOX, COMPETING_COMPUTER] : [TEAM_SANDBOX],
    null,
  );
  if (otherComputerIsReady) authority.connectComputer("other-computer");
  authority.connectComputer(NEW_HOST_ID);
}

async function advanceClock(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function changeFixture(update: () => void): Promise<void> {
  return act(() => Promise.resolve().then(update));
}

async function pressStart(): Promise<HTMLElement> {
  const button = screen.getByRole("button", { name: "Start a sandbox" });
  await changeFixture(() => {
    fireEvent.click(button);
  });
  return button;
}

async function pressTeam(): Promise<void> {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Host: none selected" }),
    { button: 0 },
  );
  const teamRow = await screen.findByRole("menuitem", {
    name: /New .* sandbox .* needs credits/i,
  });
  expect(teamRow.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(teamRow);
}

describe("PoolComposerActions", () => {
  it("creates Personal from the real split-button control without attaching a task", async () => {
    renderActions("epic-personal");

    await pressStart();

    expect(harness.events).toEqual(["create"]);
    expect(harness.createInput).toMatchObject({
      environmentId: null,
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      region: "us-east",
    });
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't verify your balance.",
    );
    expect(harness.activate).not.toHaveBeenCalled();
  });

  it("uses valid saved Personal defaults from the real Start a sandbox button", async () => {
    harness.defaults.mockImplementation((key) =>
      key === "personal"
        ? {
            os: "linux",
            cpus: 4,
            memoryMb: 8192,
            diskMb: 30720,
            idleMinutes: 14,
            restingMinutes: null,
          }
        : null,
    );
    renderActions("epic-team");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Host: none selected" }),
      { button: 0 },
    );
    const quotedPersonal = await screen.findByRole("menuitem", {
      name: /New Personal sandbox/,
    });
    expect(quotedPersonal.textContent).toContain("Linux · 4 vCPU · 8 GB");
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await pressStart();

    expect(harness.createInput).toMatchObject({
      environmentId: null,
      os: "linux",
      cpus: 4,
      memoryMb: 8192,
      diskMb: 30720,
      region: "us-east",
      idleMinutes: 14,
      destroyAfterRestingMinutes: 0,
    });
    expect(harness.events).toEqual(["create"]);
  });

  it("falls back to the catalogue shape when saved Personal defaults are no longer offered", async () => {
    harness.defaults.mockImplementation((key) =>
      key === "personal"
        ? {
            os: "linux",
            cpus: 128,
            memoryMb: 131072,
            diskMb: 204800,
            idleMinutes: 17,
            restingMinutes: null,
          }
        : null,
    );
    renderActions("epic-team");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Host: none selected" }),
      { button: 0 },
    );
    const cataloguePersonal = await screen.findByRole("menuitem", {
      name: /New Personal sandbox/,
    });
    expect(cataloguePersonal.textContent).toContain("Linux · 2 vCPU · 4 GB");
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await pressStart();

    expect(harness.createInput).toMatchObject({
      environmentId: null,
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      diskMb: null,
      region: "us-east",
      idleMinutes: 17,
      destroyAfterRestingMinutes: 0,
    });
    expect(harness.events).toEqual(["create"]);
  });

  it("opens the existing host choices from the approved Host: none selected trigger", async () => {
    renderActions("epic-team");

    const trigger = screen.getByRole("button", {
      name: "Host: none selected",
    });
    fireEvent.pointerDown(trigger, { button: 0 });

    expect(
      await screen.findByRole("menuitem", { name: /New Personal sandbox/ }),
    ).toBeTruthy();
    expect(screen.getByRole("menu").classList.contains("min-w-0")).toBe(true);
    expect(screen.getByRole("menu").classList.contains("min-w-32")).toBe(false);
  });

  it("keeps a pending create in progress when the same composer closes and reopens", async () => {
    const create = Promise.withResolvers<SandboxCreateFetchResult>();
    harness.createSandbox.mockReturnValueOnce(create.promise);
    const first = renderActions("epic-new-chat");

    await pressStart();
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);
    first.unmount();

    const reopened = renderActions("epic-new-chat");
    const start = screen.getByRole("button", { name: "Start a sandbox" });
    expect(start.matches(":disabled")).toBe(true);
    fireEvent.click(start);
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);

    await changeFixture(() =>
      create.resolve({ kind: "network-error", detail: "offline" }),
    );
    await waitFor(() => expect(start.matches(":disabled")).toBe(false));
    reopened.unmount();
  });

  it("lets a new sign-in start the same surface while the old create is unanswered", async () => {
    const oldCreate = Promise.withResolvers<SandboxCreateFetchResult>();
    const newCreate = Promise.withResolvers<SandboxCreateFetchResult>();
    harness.createSandbox
      .mockReturnValueOnce(oldCreate.promise)
      .mockReturnValueOnce(newCreate.promise);
    const first = renderActions("epic-personal");

    await pressStart();
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);
    first.unmount();

    harness.originCurrent = false;
    harness.originGeneration += 1;
    harness.originCurrent = true;
    const reopened = renderActions("epic-personal");
    const start = screen.getByRole("button", { name: "Start a sandbox" });
    expect(start.matches(":disabled")).toBe(false);
    fireEvent.click(start);
    expect(harness.createSandbox).toHaveBeenCalledTimes(2);

    await changeFixture(() =>
      oldCreate.resolve({ kind: "network-error", detail: "old account" }),
    );
    expect(start.matches(":disabled")).toBe(true);
    expect(harness.toastError).not.toHaveBeenCalled();

    await changeFixture(() =>
      newCreate.resolve({ kind: "network-error", detail: "offline" }),
    );
    await waitFor(() => expect(start.matches(":disabled")).toBe(false));
    expect(harness.toastError).toHaveBeenCalledTimes(1);
    reopened.unmount();
  });

  it("keeps an accepted Personal start pending across reopen until its listed sandbox serves", async () => {
    vi.useFakeTimers();
    acceptCreate(undefined);
    const first = renderActions("epic-new-chat");

    await pressStart();
    await advanceClock(0);
    expect(harness.directoryListeners.size).toBe(1);
    first.unmount();

    const reopened = renderActions("epic-new-chat");
    const start = screen.getByRole("button", { name: "Start a sandbox" });
    expect(start.matches(":disabled")).toBe(true);
    fireEvent.click(start);
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);

    await changeFixture(() =>
      publishSandbox(sandboxHostEntry(NEW_HOST_ID, null)),
    );
    await advanceClock(0);
    expect(harness.activate).toHaveBeenCalledTimes(1);
    await act(personalSandboxReady);
    await advanceClock(0);
    expect(start.matches(":disabled")).toBe(false);
    expect(harness.toastError).not.toHaveBeenCalled();
    reopened.unmount();
  });

  it("settles one Personal create and wake notice after its composer closes during activation", async () => {
    vi.useFakeTimers();
    acceptCreate(undefined);
    const activation = Promise.withResolvers<ActivationOutcome>();
    harness.activate.mockReturnValue(activation.promise);
    const first = renderActions("epic-personal-close");

    await pressStart();
    await advanceClock(0);
    await changeFixture(() =>
      publishSandbox(sandboxHostEntry(NEW_HOST_ID, null)),
    );
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);
    expect(harness.activate).toHaveBeenCalledTimes(1);
    first.unmount();

    const reopened = renderActions("epic-personal-close");
    const start = screen.getByRole("button", { name: "Start a sandbox" });
    expect(start.matches(":disabled")).toBe(true);
    fireEvent.click(start);
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);

    await changeFixture(() => activation.resolve("declined"));
    await advanceClock(0);

    expect(harness.createSandbox).toHaveBeenCalledTimes(1);
    expect(harness.activate).toHaveBeenCalledTimes(1);
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't wake this sandbox",
      { description: "Try again in a moment." },
    );
    reopened.unmount();
  });

  it("lets a different task start independently while another task's create is pending", async () => {
    const create = Promise.withResolvers<SandboxCreateFetchResult>();
    harness.createSandbox.mockReturnValueOnce(create.promise);
    const first = renderActions("epic-one");

    fireEvent.click(first.getByRole("button", { name: "Start a sandbox" }));
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);

    const second = renderActions("epic-two");
    fireEvent.click(
      within(second.container).getByRole("button", {
        name: "Start a sandbox",
      }),
    );
    await waitFor(() => expect(harness.createSandbox).toHaveBeenCalledTimes(2));

    await changeFixture(() =>
      create.resolve({ kind: "network-error", detail: "offline" }),
    );
    first.unmount();
    second.unmount();
  });

  it.each([
    {
      status: 402,
      code: "insufficient_credit",
      copy: /Not enough credits to start this sandbox/,
    },
    {
      status: 403,
      code: "create_principal_mismatch",
      copy: /can't be created for the selected owner/,
    },
    {
      status: 503,
      code: "provider_unavailable",
      copy: /Sandboxes are unavailable right now/,
    },
    { status: 400, code: "shape_not_offered", copy: /US East doesn't offer/ },
    {
      status: 502,
      code: "provider_failed",
      copy: /Couldn't complete the sandbox action/,
    },
  ])(
    "presents the create refusal once for status $status and leaves the existing pick",
    async ({ status, code, copy }) => {
      authority = mountTestSelectionAuthority({
        hosts: [
          { hostId: "current-computer", kind: "remote", teamOwned: false },
        ],
        savedPick: "current-computer",
        readyComputers: ["current-computer"],
      });
      authority.goCold("current-computer");
      harness.createSandbox.mockResolvedValueOnce({
        kind: "refused",
        status,
        code,
        reason: null,
        shortfallMc: null,
        newRateMcPerHour: null,
        currentAwakeBurnMcPerHour: null,
        message: null,
      });
      renderActions("epic-personal");
      await pressStart();

      expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(copy),
      );
      expect(harness.activate).not.toHaveBeenCalled();
      expect(useSelectionAuthorityStore.getState().preferredHostId).toBe(
        "current-computer",
      );
    },
  );

  it("quotes the saved team shape and sends the same shape on the low-credit row", async () => {
    harness.defaults.mockImplementation((key) =>
      key === "team-1"
        ? {
            os: "linux",
            cpus: 4,
            memoryMb: 8192,
            diskMb: 30720,
            idleMinutes: 14,
            restingMinutes: null,
          }
        : null,
    );
    renderActions("epic-team");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Host: none selected" }),
      { button: 0 },
    );
    const row = await screen.findByRole("menuitem", {
      name: /New .* sandbox .* needs credits/i,
    });
    expect(row.textContent).toMatch(/4 vCPU.*8 GB.*from/);
    fireEvent.click(row);

    await waitFor(() =>
      expect(harness.createInput).toMatchObject({
        environmentId: "team-env",
        os: "linux",
        cpus: 4,
        memoryMb: 8192,
        diskMb: 30720,
        region: "us-east",
        idleMinutes: 14,
        destroyAfterRestingMinutes: 0,
      }),
    );
  });

  it.each([
    { acceptedBudget: undefined, deadline: 120_000 },
    { acceptedBudget: 185_000, deadline: 185_000 },
  ])(
    "never asks Activate for an unlisted sandbox, even at the $deadline ms deadline",
    async ({ acceptedBudget, deadline }) => {
      vi.useFakeTimers();
      acceptCreate(acceptedBudget);
      renderActions(null);
      const button = await pressStart();

      await advanceClock(deadline - 1);
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(harness.toastError).not.toHaveBeenCalled();
      await advanceClock(1);

      expect(harness.activate).not.toHaveBeenCalled();
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
        "Couldn't wake this sandbox",
        { description: "Try again in a moment." },
      );
    },
  );

  it("holds Personal until that sandbox serves the app over its own ready session", async () => {
    vi.useFakeTimers();
    acceptCreate(undefined);
    renderActions("epic-personal");
    const button = await pressStart();

    await changeFixture(() =>
      publishSandbox(sandboxHostEntry(NEW_HOST_ID, null)),
    );
    await advanceClock(0);
    expect(harness.activate).toHaveBeenCalledTimes(1);
    expect(harness.activate.mock.calls[0][0].hostId).toBe(NEW_HOST_ID);

    await act(async () => {
      authority.publishFleet([PERSONAL_SANDBOX, COMPETING_COMPUTER], null);
      await authority.activate(NEW_HOST_ID);
    });
    expect(button.hasAttribute("disabled")).toBe(true);

    await changeFixture(() => {
      authority.goCold(NEW_HOST_ID);
      authority.connectComputer("other-computer");
    });
    expect(useSelectionAuthorityStore.getState().servingPeer).toEqual({
      kind: "computer",
      hostId: "other-computer",
    });
    expect(button.hasAttribute("disabled")).toBe(true);

    await changeFixture(() => {
      authority.connectComputer(NEW_HOST_ID);
      authority.advance(RETURN_TO_TARGET_STABILITY_MS);
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(harness.activate).toHaveBeenCalledTimes(1);
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it("shows one wake failure when another computer serves but the sandbox misses the deadline", async () => {
    vi.useFakeTimers();
    acceptCreate(undefined);
    renderActions("epic-personal");
    const button = await pressStart();

    await changeFixture(() =>
      publishSandbox(sandboxHostEntry(NEW_HOST_ID, null)),
    );
    await advanceClock(0);
    expect(harness.activate).toHaveBeenCalledTimes(1);

    await act(async () => {
      authority.publishFleet([PERSONAL_SANDBOX, COMPETING_COMPUTER], null);
      await authority.activate(NEW_HOST_ID);
      authority.goCold(NEW_HOST_ID);
      authority.connectComputer("other-computer");
    });
    expect(button.hasAttribute("disabled")).toBe(true);

    await advanceClock(120_000);

    expect(button.hasAttribute("disabled")).toBe(false);
    expect(harness.activate).toHaveBeenCalledTimes(1);
    expect(useSelectionAuthorityStore.getState().servingPeer).toEqual({
      kind: "computer",
      hostId: "other-computer",
    });
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't wake this sandbox",
      { description: "Try again in a moment." },
    );
  });

  it.each([
    { result: "declined", ready: false, wantedWakeErrors: 1 },
    { result: "reported", ready: false, wantedWakeErrors: 0 },
    { result: "saved", ready: false, wantedWakeErrors: 1 },
    { result: "saved", ready: true, wantedWakeErrors: 0 },
  ] as const)(
    "settles an unanswered activation only after its $result reply, ready=$ready",
    async ({ result, ready, wantedWakeErrors }) => {
      vi.useFakeTimers();
      acceptCreate(undefined);
      const activation = Promise.withResolvers<ActivationOutcome>();
      harness.activate.mockReturnValue(activation.promise);
      publishSandbox(sandboxHostEntry(NEW_HOST_ID, null));
      renderActions("epic-personal");
      const button = await pressStart();
      expect(harness.activate).toHaveBeenCalledTimes(1);

      await advanceClock(120_000);
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(harness.toastError).not.toHaveBeenCalled();
      await act(async () => {
        if (ready) await personalSandboxReady();
        activation.resolve(result);
      });

      expect(button.hasAttribute("disabled")).toBe(false);
      expect(harness.toastError).toHaveBeenCalledTimes(wantedWakeErrors);
    },
  );

  it("keeps a later computer pick when the superseded Personal sandbox misses its deadline", async () => {
    vi.useFakeTimers();
    acceptCreate(undefined);
    renderActions("epic-personal");

    await pressStart();
    await changeFixture(() =>
      publishSandbox(sandboxHostEntry(NEW_HOST_ID, null)),
    );
    expect(harness.activate).toHaveBeenCalledTimes(1);

    await act(async () => {
      authority.publishFleet(
        [
          PERSONAL_SANDBOX,
          { hostId: "later-computer", kind: "remote", teamOwned: false },
        ],
        null,
      );
      await authority.activate(NEW_HOST_ID);
      authority.connectComputer("later-computer");
      await authority.activate("later-computer");
    });
    await advanceClock(120_000);

    expect(harness.activate).toHaveBeenCalledTimes(1);
    expect(useSelectionAuthorityStore.getState().preferredHostId).toBe(
      "later-computer",
    );
    expect(useSelectionAuthorityStore.getState().servingPeer).toEqual({
      kind: "computer",
      hostId: "later-computer",
    });
    expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't wake this sandbox",
      { description: "Try again in a moment." },
    );
  });

  it.each([true, false])(
    "uses one notice when the helper's wake refusal precedes the deadline: %s",
    async (early) => {
      vi.useFakeTimers();
      acceptCreate(undefined);
      renderActions(null);
      const button = await pressStart();
      const entry = sandboxHostEntry(NEW_HOST_ID, null);
      if (entry.sandbox === null)
        throw new Error("Expected a sandbox directory row");
      const stopped = {
        ...entry,
        sandbox: { ...entry.sandbox, state: "stopped" as const },
      };
      await changeFixture(() => publishSandbox(stopped));
      const showWakeRefusal = vi.fn();
      const report = harness.activate.mock.calls[0][1];
      if (early) await changeFixture(() => report(showWakeRefusal));
      await advanceClock(120_000);
      if (!early) await changeFixture(() => report(showWakeRefusal));

      expect(button.hasAttribute("disabled")).toBe(false);
      expect(showWakeRefusal).toHaveBeenCalledTimes(early ? 1 : 0);
      expect(harness.toastError).toHaveBeenCalledTimes(early ? 0 : 1);
    },
  );

  it("pins a ready team sandbox while another computer keeps serving", async () => {
    acceptCreate(undefined);
    publishSandbox(sandboxHostEntry(NEW_HOST_ID, { id: "team", name: "Acme" }));
    renderActions("epic-team");
    await pressTeam();
    await waitFor(() =>
      expect(harness.openTeam).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID),
    );
    expect(harness.place).not.toHaveBeenCalled();

    await changeFixture(() => teamSandboxReady(true));

    expect(harness.place).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID);
    expect(harness.activate).not.toHaveBeenCalled();
    expect(harness.closeTeam).toHaveBeenCalledTimes(1);
    expect(useSelectionAuthorityStore.getState().servingPeer).toEqual({
      kind: "computer",
      hostId: "other-computer",
    });
  });

  it("keeps a Team start pending through modal close and reopen, then pins its ready host once", async () => {
    const epicId = "pool-team-modal";
    const tabId = "pool-start-tab";
    acceptCreate(undefined);
    fakeModalTaskAttachment();
    useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, "Task");
    openModalRequest(epicId, tabId, null);
    const first = renderTaskModalActions(epicId, tabId);

    await pressTeam();
    await waitFor(() => expect(harness.createSandbox).toHaveBeenCalledTimes(1));
    expect(harness.createInput).toMatchObject({ environmentId: "team-env" });
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);
    first.unmount();
    useNewConversationModalOpenStore.getState().close();

    openModalRequest(epicId, tabId, null);
    const reopened = renderTaskModalActions(epicId, tabId);
    const start = screen.getByRole("button", { name: "Start a sandbox" });
    expect(start.matches(":disabled")).toBe(true);
    fireEvent.click(start);
    expect(harness.createSandbox).toHaveBeenCalledTimes(1);

    await changeFixture(() =>
      publishSandbox(
        sandboxHostEntry(NEW_HOST_ID, { id: "team", name: "Acme" }),
      ),
    );
    await waitFor(() =>
      expect(harness.openTeam).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID),
    );
    await changeFixture(() => teamSandboxReady(false));
    await waitFor(() =>
      expect(harness.place).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID),
    );

    expect(harness.createSandbox).toHaveBeenCalledTimes(1);
    expect(harness.closeTeam).toHaveBeenCalledTimes(1);
    expect(start.matches(":disabled")).toBe(false);
    expect(harness.toastError).not.toHaveBeenCalled();
    reopened.unmount();
  });

  it.each(["origin record removed", "another modal row opened"] as const)(
    "does not pin the Team host when the $scenario before it becomes ready",
    async (scenario) => {
      const epicId = "pool-team-origin";
      const tabId = "pool-origin-tab";
      acceptCreate(undefined);
      fakeModalTaskAttachment();
      useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, "Task");
      openModalRequest(epicId, tabId, null);
      const view = renderTaskModalActions(epicId, tabId);

      await pressTeam();
      await waitFor(() =>
        expect(harness.createSandbox).toHaveBeenCalledTimes(1),
      );
      expect(harness.createInput).toMatchObject({ environmentId: "team-env" });
      await changeFixture(() =>
        publishSandbox(
          sandboxHostEntry(NEW_HOST_ID, { id: "team", name: "Acme" }),
        ),
      );
      await waitFor(() =>
        expect(harness.openTeam).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID),
      );

      if (scenario === "origin record removed") {
        useEpicCanvasStore.getState().discardTabState(tabId);
      } else {
        openModalRequest(epicId, tabId, "another-chat");
      }
      await changeFixture(() => teamSandboxReady(false));
      await waitFor(() => expect(harness.closeTeam).toHaveBeenCalledTimes(1));

      expect(harness.place).not.toHaveBeenCalled();
      expect(harness.createSandbox).toHaveBeenCalledTimes(1);
      expect(harness.toastError).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  it("attaches a task in cloud before creating the selectable low-credit Team sandbox row", async () => {
    renderActions("epic-team");
    await pressTeam();
    await waitFor(() =>
      expect(harness.events).toEqual(["list", "attach", "create"]),
    );
    expect(harness.createInput).toMatchObject({ environmentId: "team-env" });
    await waitFor(() => expect(harness.toastError).toHaveBeenCalledTimes(1));
  });

  it("pins a Team sandbox for a new task, then keeps the primary action Personal", async () => {
    acceptCreate(undefined);
    renderActions(null);
    await pressTeam();

    await waitFor(() => expect(harness.createSandbox).toHaveBeenCalledTimes(1));
    expect(harness.getTeamEnvironment).toHaveBeenCalledExactlyOnceWith(
      "team-1",
    );
    expect(harness.listEnvironments).not.toHaveBeenCalled();
    expect(harness.attachmentTransport).not.toHaveBeenCalled();
    expect(harness.createInput).toMatchObject({ environmentId: "team-env" });

    await changeFixture(() =>
      publishSandbox(
        sandboxHostEntry(NEW_HOST_ID, { id: "team-1", name: "Acme" }),
      ),
    );
    await waitFor(() =>
      expect(harness.openTeam).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID),
    );
    await changeFixture(() => teamSandboxReady(true));

    await waitFor(() =>
      expect(harness.place).toHaveBeenCalledExactlyOnceWith(NEW_HOST_ID),
    );
    expect(harness.activate).not.toHaveBeenCalled();
    expect(useSelectionAuthorityStore.getState().servingPeer).toEqual({
      kind: "computer",
      hostId: "other-computer",
    });

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start a sandbox" })
          .matches(":disabled"),
      ).toBe(false),
    );
    await pressStart();
    expect(harness.createSandbox).toHaveBeenCalledTimes(2);
    expect(harness.createInput).toMatchObject({
      environmentId: null,
      os: "linux",
      cpus: 2,
      memoryMb: 4096,
      createdByTaskId: null,
    });
    expect(harness.attachmentTransport).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: "the paid-plan owner attaches an unattached task",
      status: 200,
      text: JSON.stringify({ attached: true }),
      createExpected: true,
      refusal: null,
    },
    {
      scenario: "a paid-plan editor cannot attach another owner's task",
      status: 403,
      text: JSON.stringify({ error: "This viewer cannot change grants" }),
      createExpected: false,
      refusal: "Ask the task's owner to continue it on a team host.",
    },
    {
      scenario: "an editor can use an already attached paid-plan task",
      status: 200,
      text: JSON.stringify({ attached: true }),
      createExpected: true,
      refusal: null,
    },
    {
      scenario: "a paid-plan team can use a task it owns",
      status: 200,
      text: JSON.stringify({ attached: true }),
      createExpected: true,
      refusal: null,
    },
    {
      scenario:
        "the owner of an unattached task is refused without a paid plan",
      status: 403,
      text: JSON.stringify({
        error: "Sharing with this team requires a paid team plan",
      }),
      createExpected: false,
      refusal: "This team needs the Sync plan before it can share tasks.",
    },
    {
      scenario:
        "an already attached task is refused when the team has no paid plan",
      status: 403,
      text: JSON.stringify({
        error: "Sharing with this team requires a paid team plan",
      }),
      createExpected: false,
      refusal: "This team needs the Sync plan before it can share tasks.",
    },
    {
      scenario:
        "a task owned by the team is refused when the team has no paid plan",
      status: 403,
      text: JSON.stringify({
        error: "Sharing with this team requires a paid team plan",
      }),
      createExpected: false,
      refusal: "This team needs the Sync plan before it can share tasks.",
    },
    {
      scenario: "a malformed paid-plan refusal uses the existing owner message",
      status: 403,
      text: "invalid JSON",
      createExpected: false,
      refusal: "Ask the task's owner to continue it on a team host.",
    },
    {
      scenario:
        "an unavailable attach service uses the existing generic message",
      status: 503,
      text: null,
      createExpected: false,
      refusal: "Couldn't complete the sandbox action.",
    },
  ])(
    "routes the real Team row through the cloud attach for $scenario",
    async ({ status, text, createExpected, refusal }) => {
      harness.attachmentTransport.mockImplementationOnce(() => {
        harness.events.push("attach");
        return Promise.resolve({ status, text });
      });
      renderActions("epic-team");
      await pressTeam();

      if (createExpected) {
        await waitFor(() =>
          expect(harness.events).toEqual(["list", "attach", "create"]),
        );
        expect(harness.createInput).toMatchObject({
          environmentId: "team-env",
        });
      } else {
        if (refusal === null) throw new Error("Expected a refusal message");
        await waitFor(() =>
          expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(refusal),
        );
        expect(harness.events).toEqual(["list", "attach"]);
        expect(harness.createSandbox).not.toHaveBeenCalled();
      }

      expect(harness.activate).not.toHaveBeenCalled();
      const start = screen.getByRole("button", { name: "Start a sandbox" });
      const connect = screen.getByRole("button", {
        name: "Connect a computer",
      });
      expect(start.matches(":disabled")).toBe(false);
      expect(connect).toBeTruthy();
    },
  );

  it("does not use a landing environment read after the sign-in changes", async () => {
    const environmentRead = Promise.withResolvers<TeamEnvironmentFetchResult>();
    harness.getTeamEnvironment.mockReturnValueOnce(environmentRead.promise);
    renderActions(null);
    await pressTeam();
    await waitFor(() =>
      expect(harness.getTeamEnvironment).toHaveBeenCalledTimes(1),
    );

    await changeFixture(() => {
      harness.originCurrent = false;
      environmentRead.resolve({
        kind: "ok",
        environmentId: "old-account-environment",
      });
    });

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start a sandbox" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(harness.attachmentTransport).not.toHaveBeenCalled();
    expect(harness.createSandbox).not.toHaveBeenCalled();
    expect(harness.toastError).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();
  });

  it("does not attach or create from an existing task after its environment read crosses sign-in", async () => {
    const environmentRead = Promise.withResolvers<EnvironmentDirectoryResult>();
    harness.listEnvironments.mockReturnValueOnce(environmentRead.promise);
    renderActions("epic-team");
    await pressTeam();
    await waitFor(() =>
      expect(harness.listEnvironments).toHaveBeenCalledTimes(1),
    );

    await changeFixture(() => {
      harness.originCurrent = false;
      environmentRead.resolve({
        kind: "ok",
        list: {
          environments: [
            {
              environmentId: "old-account-environment",
              ownerKind: "organization",
              ownerId: "team-1",
              roomId: "old-account-room",
              label: "Old account environment",
            },
          ],
        },
      });
    });

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start a sandbox" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(harness.attachmentTransport).not.toHaveBeenCalled();
    expect(harness.createSandbox).not.toHaveBeenCalled();
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it("keeps a failed environment read on the existing task from attaching or creating", async () => {
    harness.listEnvironments.mockResolvedValueOnce({ kind: "unavailable" });
    renderActions("epic-team");
    await pressTeam();

    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledExactlyOnceWith(
        "Couldn't complete the sandbox action.",
      ),
    );
    expect(harness.attachmentTransport).not.toHaveBeenCalled();
    expect(harness.createSandbox).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Start a sandbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();
  });

  it("stops quietly when the sign-in changes while the attachment is on the wire", async () => {
    const attachment = Promise.withResolvers<{
      status: number;
      text: string | null;
    }>();
    harness.attachmentTransport.mockReturnValueOnce(attachment.promise);
    renderActions("epic-team");
    await pressTeam();
    await waitFor(() =>
      expect(harness.attachmentTransport).toHaveBeenCalledTimes(1),
    );

    await changeFixture(() => {
      harness.originCurrent = false;
      attachment.resolve({
        status: 200,
        text: JSON.stringify({ attached: true }),
      });
    });

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Start a sandbox" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(harness.toastError).not.toHaveBeenCalled();
    expect(harness.createSandbox).not.toHaveBeenCalled();
  });

  it("does not create when the sign-in changes after attach succeeds but before create", async () => {
    harness.attachmentMutation = {
      mutateAsync: () => {
        harness.events.push("attach-succeeded");
        harness.originCurrent = false;
        return Promise.resolve({ environmentId: "old-account-environment" });
      },
    };
    renderActions("epic-team");
    await pressTeam();

    await waitFor(() => expect(harness.events).toEqual(["attach-succeeded"]));
    expect(harness.createSandbox).not.toHaveBeenCalled();
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it("shows only Connect a computer when the build cannot use sandbox control", () => {
    harness.controlUnavailable = "Unavailable in this build";
    renderActions("epic-team");

    expect(
      screen.getByRole("button", { name: "Connect a computer" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Start a sandbox" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Host: none selected" }),
    ).toBeNull();
  });

  it("opens the existing Add host flow from Connect a computer", () => {
    renderActions(null);

    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Connect a computer" }),
      );
    });

    expect(useAddHostDialogStore.getState().open).toBe(true);
    expect(harness.openSettings).toHaveBeenCalledTimes(1);
  });
});
