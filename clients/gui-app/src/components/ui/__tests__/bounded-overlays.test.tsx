/**
 * Rendered overlay content: the cap class on the content element, `flex` and
 * `flex-col` on that element when a caller scrolls an inner body, `min-h-0`
 * and `overflow-y-auto` on that body, and a pinned control outside it.
 */
import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { GithubMentionRepository } from "@traycer/protocol/host/mention-schemas";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import { CanvasPageMenu } from "@/components/canvas-artifact/canvas-pages";
import type { CanvasPageItems } from "@/components/canvas-artifact/canvas-model";
import { GithubMentionFilterPopover } from "@/components/chat/composer/menu/github-mention-filter-popover";
import { BrowserOfflineFilter } from "@/components/epic-canvas/sidebar/epic-browser-sidebar-header";
import { EpicWriteCommandsDialog } from "@/components/epic-canvas/panels/epic-write-commands-dialog";
import { HomeFocusTaskStopCluster } from "@/components/home-focus/home-focus-rows";
import type { HomeFocusRowActions } from "@/components/home-focus/home-focus-rows";
import { SandboxShapeSheet } from "@/components/hosts/sandbox-shape-sheet";
import { ConfigurationStatusChip } from "@/components/settings/environment/status-chip";
import type { ConfigurationChipHost } from "@/components/settings/environment/status-chip-model";
import { McpServerDialog } from "@/components/settings/environment/mcp-server-dialog";
import { AddHostDialog } from "@/components/settings/host-scope/add-host-dialog";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PrReferencePills } from "@/components/worktree/worktree-pr-metadata";
import type { WorktreePrReference } from "@/components/worktree/worktree-pr-metadata-model";
import type { FocusAgentRow, FocusTaskRow } from "@/lib/home-focus/focus-model";
import { DEFAULT_PULL_REQUEST_MENTION_FILTER } from "@/lib/composer/mentions";
import type { HostRpcRegistry } from "@/lib/host";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { useGithubMentionFilterStore } from "@/stores/composer/github-mention-filter-store";
import { usePanelHeaderMenuStore } from "@/stores/epics/panel-header-menu-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  mountTeamPage,
  personalPoolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  windowHostScopeMock,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  negotiateMethods,
  reachableHost,
  teamEnvironments,
} from "@/components/settings/environment/__tests__/mcp-skills-test-support";

const POPOVER_CAP = "max-h-(--radix-popover-content-available-height)";
const DROPDOWN_CAP = "max-h-(--radix-dropdown-menu-content-available-height)";
const DIALOG_CAP =
  "max-h-[calc(var(--spacing-safe-dvh)-var(--spacing-safe-bottom))]";

const ROW_COUNT = 15;

const sandboxCatalogueState = vi.hoisted(() => {
  const data: SandboxCatalogue = {
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
            fromPriceMcPerHour: { awakeMc: 80, suspendedMc: 4, stoppedMc: 2 },
            pricing: null,
          },
        ],
      },
    ],
  };
  return { data };
});

const writeCommandMocks = vi.hoisted(() => ({
  retryWriteCommand: vi.fn<(commandId: string) => void>(),
  discardWriteCommand: vi.fn<(commandId: string) => void>(),
  commands: [] as CommandRecord<EpicWriteCommandIntent>[],
}));

const browserHostPinState = vi.hoisted(() => ({
  selection: null as string | null,
  setSelection: vi.fn((selection: string | null) => {
    browserHostPinState.selection = selection;
  }),
}));

const browserHostOptionsState = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  isLoading: false,
  listsFailed: false,
  retryLists: vi.fn(),
}));

const scopeMocks = vi.hoisted(() => ({
  scope: {} as Partial<HostScope>,
}));

const openLink = vi.hoisted(() => vi.fn());

vi.mock("@/lib/epic-selectors", () => ({
  useEpicWriteCommands: () => writeCommandMocks.commands,
}));

interface MockedOpenEpicState {
  readonly retryWriteCommand: (commandId: string) => void;
  readonly discardWriteCommand: (commandId: string) => void;
}

vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: <T,>(selector: (state: MockedOpenEpicState) => T): T =>
    selector({
      retryWriteCommand: writeCommandMocks.retryWriteCommand,
      discardWriteCommand: writeCommandMocks.discardWriteCommand,
    }),
}));

vi.mock("@/hooks/host/use-surface-host-pin", () => ({
  useTabSurfaceKey: (kind: string, tabId: string) => `${kind}:${tabId}`,
  useSurfaceHostPin: () => ({
    selection: browserHostPinState.selection,
    honoredSelection: browserHostPinState.selection,
    setSelection: browserHostPinState.setSelection,
    resolvedHostId: browserHostPinState.selection ?? "host-1",
    followingHostId: "host-1",
    isPinned: browserHostPinState.selection !== null,
    latchOnFirstUse: () => undefined,
  }),
  useSurfaceHostClient: () => null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: browserHostOptionsState.hosts,
    activeHostId: browserHostOptionsState.hosts[0]?.hostId ?? null,
    isLoading: browserHostOptionsState.isLoading,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: browserHostOptionsState.listsFailed,
    retryLists: browserHostOptionsState.retryLists,
    nowMs: 0,
  }),
}));

vi.mock("@/components/settings/host-scope/host-option-row", () => ({
  HostOptionRow: (props: { readonly host: { readonly name: string } }) => (
    <span>{props.host.name}</span>
  ),
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));

vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => ({
    hostId: "host-local",
    hostClient: requireTeamHostClient(),
  }),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

vi.mock(
  "@/components/settings/host-scope/use-host-scope",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/components/settings/host-scope/use-host-scope")
      >();
    const { hostScopeFixture } =
      await import("@/components/settings/host-scope/host-scope-fixture");
    return {
      ...original,
      useHostScope: () => hostScopeFixture(scopeMocks.scope),
      useHostScopeFor: () => hostScopeFixture(scopeMocks.scope),
      usePersonalHostScope: () => windowHostScopeMock(),
    };
  },
);

vi.mock(
  "@/hooks/sandboxes/use-sandbox-catalogue-query",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-catalogue-query")
    >()),
    useSandboxCatalogue: () => ({
      isPending: false,
      isError: false,
      data: sandboxCatalogueState.data,
    }),
  }),
);

vi.mock("@/hooks/auth/use-auth-user-query", () => ({
  useAuthUser: () => ({ data: null }),
}));

vi.mock("@/hooks/sandboxes/use-configuration-billing-url", () => ({
  useConfigurationBillingUrl: () => "https://example.test/billing",
}));

vi.mock("@/lib/links/open-link", () => ({ useOpenLink: () => openLink }));

vi.mock("@/lib/settings-navigation", () => ({
  navigateToSettingsSection: vi.fn(),
}));

function requireElement(node: Element | null, label: string): HTMLElement {
  if (!(node instanceof HTMLElement)) {
    throw new Error(`expected ${label}`);
  }
  return node;
}

function hasToken(className: string, token: string): boolean {
  return className.split(/\s+/).includes(token);
}

function unprefixedMaxHeightTokens(className: string): string[] {
  return className.split(/\s+/).filter((token) => token.startsWith("max-h-"));
}

function assertCapClass(element: HTMLElement, capClass: string): void {
  expect(hasToken(element.className, capClass)).toBe(true);
}

function assertColumn(element: HTMLElement): void {
  expect(hasToken(element.className, "flex")).toBe(true);
  expect(hasToken(element.className, "flex-col")).toBe(true);
}

function assertScrollClasses(element: HTMLElement): void {
  expect(hasToken(element.className, "min-h-0")).toBe(true);
  expect(hasToken(element.className, "overflow-y-auto")).toBe(true);
}

function assertOutsideScroll(control: HTMLElement, scroll: HTMLElement): void {
  expect(document.body.contains(control)).toBe(true);
  expect(scroll.contains(control)).toBe(false);
}

function withTooltip(node: ReactNode): ReactNode {
  return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>;
}

function resetOverlayStores(): void {
  useAddHostDialogStore.getState().closeDialog();
  useSettingsHostScopeStore.getState().reset();
  useGithubMentionFilterStore.getState().resetForTests();
  usePanelHeaderMenuStore.setState(
    usePanelHeaderMenuStore.getInitialState(),
    true,
  );
}

function chipHosts(): ConfigurationChipHost[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    hostId: `host-${String(index + 1)}`,
    name: `host-${String(index + 1)}`,
    state: "applied",
    lastReportedAt: Date.UTC(2026, 9, 20, 9, 30),
    rows: [],
  }));
}

function pickableHosts(): HostScopeOption[] {
  return Array.from({ length: ROW_COUNT }, (_, index) =>
    hostScopeOptionFixture({
      hostId: `host-${String(index + 1)}`,
      name: `Host ${String(index + 1)}`,
      isActive: index === 0,
    }),
  );
}

function mcpHandlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.mcpServers.list": () => ({ servers: [] }),
    "environment.configuration.mcpServers.put": () => ({
      outcome: "saved",
      reason: null,
      serverId: null,
    }),
    "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    "environment.host.list": () => ({ hosts: [reachableHost] }),
    "environment.list": () => teamEnvironments,
    "providers.list": () => ({ providers: [], native: null }),
  };
}

function innerOverflowYAuto(root: HTMLElement): HTMLElement {
  const match = [...root.querySelectorAll(".overflow-y-auto")].find(
    (node) => node !== root,
  );
  return requireElement(match ?? null, "inner overflow-y-auto");
}

function focusAgent(index: number): FocusAgentRow {
  return {
    agentId: `agent-${String(index + 1)}`,
    title: `Agent ${String(index + 1)}`,
    surface: "chat",
    tier: "turn",
    parentId: null,
    hostId: "host-1",
    hostUnattributed: false,
    stoppable: true,
  };
}

function focusTaskRow(): FocusTaskRow {
  return {
    epicId: "epic-1",
    taskTitle: "Focus task",
    mountedHere: true,
    agents: Array.from({ length: ROW_COUNT }, (_, index) => focusAgent(index)),
    needsYou: false,
    stoppable: true,
  };
}

function focusActions(): HomeFocusRowActions {
  return {
    openPrompt: () => undefined,
    openAgent: () => undefined,
    openTask: () => undefined,
    openBackground: () => undefined,
    openBrowser: () => undefined,
    stopAgent: () => undefined,
    stopManagedCommand: () => undefined,
    stopping: new Set<string>(),
  };
}

function queuedCommand(
  commandId: string,
  title: string,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId,
    intent: {
      kind: "rename-artifact",
      artifactId: `artifact-${commandId}`,
      title,
    },
    state: "pending",
    delivery: "queued",
    issuedAtMs: 1000,
    attempts: 0,
    expectedEntityVersion: null,
    resolution: null,
  };
}

function canvasPages(): CanvasLayoutSnapshot["pages"] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `page-${String(index + 1)}`,
    name: `Page ${String(index + 1)}`,
    pos: `a${String(index + 1)}`,
  }));
}

function prReference(index: number): WorktreePrReference {
  const number = index + 1;
  return {
    key: `pr-${String(number)}`,
    label: `#${String(number)}`,
    ariaLabel: `Open PR #${String(number)} Open`,
    state: "open",
    prNumber: number,
    url: `https://github.com/acme/app/pull/${String(number)}`,
    githubHost: "github.com",
    owner: "acme",
    repo: "app",
    branch: `feature/${String(number)}`,
    worktreePath: `/worktrees/app/feature-${String(number)}`,
  };
}

function githubRepositories(): readonly GithubMentionRepository[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    githubHost: "github.com",
    owner: "acme",
    repo: `repo-${String(index + 1)}`,
  }));
}

beforeEach(() => {
  writeCommandMocks.commands = [];
  writeCommandMocks.retryWriteCommand.mockReset();
  writeCommandMocks.discardWriteCommand.mockReset();
  browserHostPinState.selection = null;
  browserHostPinState.setSelection.mockClear();
  browserHostOptionsState.hosts = [];
  browserHostOptionsState.isLoading = false;
  browserHostOptionsState.listsFailed = false;
  scopeMocks.scope = {};
  openLink.mockReset();
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  resetOverlayStores();
});

describe("overlay cap and scroll classes", () => {
  it("ConfigurationStatusChip content carries the popover cap and the host list carries the scroll classes", async () => {
    const user = userEvent.setup();
    render(
      <ConfigurationStatusChip
        hosts={chipHosts()}
        emptyText="Nothing runs this yet"
        savingOffline={false}
        local={false}
        onDetails={() => undefined}
        onRecover={() => undefined}
        recoveryPending={false}
      />,
    );
    await user.click(screen.getByRole("button"));
    const popover = requireElement(
      document.querySelector("[data-slot='popover-content']"),
      "popover content",
    );
    assertCapClass(popover, POPOVER_CAP);
    assertColumn(popover);
    expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
    const list = requireElement(
      popover.querySelector("ul.overflow-y-auto"),
      "host list",
    );
    assertScrollClasses(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
    assertOutsideScroll(screen.getByRole("button", { name: "Details" }), list);
  });

  it("browser host submenu carries the dropdown cap and the host list carries the scroll classes", async () => {
    const user = userEvent.setup();
    browserHostOptionsState.hosts = pickableHosts();
    render(
      withTooltip(
        <BrowserOfflineFilter
          epicId="epic-1"
          tabId="view-tab-1"
          mobile={false}
        />,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Filter browsers" }));
    expect(screen.getByText("Show offline hosts")).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Open links on" }));
    expect(await screen.findByText("Follow task host")).toBeTruthy();
    const submenu = requireElement(
      document.querySelector("[data-slot='dropdown-menu-sub-content']"),
      "dropdown submenu",
    );
    assertCapClass(submenu, DROPDOWN_CAP);
    assertColumn(submenu);
    expect(hasToken(submenu.className, "overflow-hidden")).toBe(true);
    const list = requireElement(
      submenu.querySelector("div.overflow-y-auto"),
      "host filter list",
    );
    assertScrollClasses(list);
    assertOutsideScroll(within(submenu).getByText("Open links on"), list);
  });

  it("McpServerDialog content carries the dialog cap and the fields carry the scroll classes", async () => {
    negotiateMethods({
      "environment.configuration.mcpServers.list": { major: 1, minor: 0 },
      "environment.configuration.mcpServers.put": { major: 1, minor: 1 },
      "environment.configuration.mcpServers.delete": { major: 1, minor: 0 },
      "environment.secrets.list": { major: 1, minor: 1 },
    });
    const harness = mountTeamPage(personalPoolSource(), mcpHandlers());
    render(<McpServerDialog server={null} onClose={() => undefined} />, {
      wrapper: harness.Wrapper,
    });
    const dialog = await screen.findByRole("dialog");
    assertCapClass(dialog, DIALOG_CAP);
    assertColumn(dialog);
    const fields = innerOverflowYAuto(dialog);
    assertScrollClasses(fields);
    assertOutsideScroll(
      within(dialog).getByRole("button", { name: "Cancel" }),
      fields,
    );
    assertOutsideScroll(
      within(dialog).getByRole("button", { name: "Add" }),
      fields,
    );
  });

  it("SandboxShapeSheet content carries the dialog cap and the form body carries the scroll classes", () => {
    const harness = mountTeamPage(personalPoolSource(), {});
    render(
      <SandboxShapeSheet
        open
        onOpenChange={() => undefined}
        configuration={{ kind: "personal" }}
        defaults={null}
        initialShape={{
          os: "linux",
          cpus: 2,
          memoryMb: 4096,
          diskMb: null,
          region: "us-east",
          idleMinutes: 30,
          destroyAfterRestingMinutes: 10_080,
        }}
        initialName=""
        context={{
          audience: "private",
          reachHost: null,
          unmovedComputer: null,
        }}
        onUseShape={() => undefined}
      />,
      { wrapper: harness.Wrapper },
    );
    const dialog = screen.getByTestId("sandbox-shape-sheet");
    assertCapClass(dialog, DIALOG_CAP);
    assertColumn(dialog);
    const form = requireElement(dialog.querySelector("form"), "shape form");
    const body = requireElement(
      form.querySelector("div.overflow-y-auto"),
      "shape form body",
    );
    assertScrollClasses(body);
    assertOutsideScroll(screen.getByTestId("sandbox-shape-sheet-use"), body);
    assertOutsideScroll(screen.getByRole("button", { name: "Cancel" }), body);
  });

  it("ConfirmDestructiveDialog content carries the dialog cap and the body carries the scroll classes", () => {
    render(
      <ConfirmDestructiveDialog
        open
        onOpenChange={() => undefined}
        title="Destroy 15 idle sandboxes?"
        description="Files on these sandboxes cannot be recovered."
        cascadeSummary={null}
        actionLabel="Destroy 15"
        isPending={false}
        blockedReason={null}
        onConfirm={() => undefined}
      >
        {Array.from({ length: ROW_COUNT }, (_, index) => (
          <p key={`idle-${String(index + 1)}`}>
            {`Idle sandbox ${String(index + 1)}`}
          </p>
        ))}
      </ConfirmDestructiveDialog>,
    );
    const dialog = screen.getByTestId("confirm-destructive-dialog");
    assertCapClass(dialog, DIALOG_CAP);
    assertColumn(dialog);
    const body = requireElement(
      dialog.querySelector("div.min-h-0.overflow-y-auto"),
      "confirm body",
    );
    assertScrollClasses(body);
    expect(within(body).getAllByText(/^Idle sandbox \d+$/)).toHaveLength(
      ROW_COUNT,
    );
    assertOutsideScroll(screen.getByTestId("confirm-cancel"), body);
    assertOutsideScroll(screen.getByTestId("confirm-action"), body);
  });

  it("HomeFocusTaskStopCluster dialog carries the dialog cap and the agent list carries the scroll classes", async () => {
    render(
      withTooltip(
        <HomeFocusTaskStopCluster
          row={focusTaskRow()}
          actions={focusActions()}
          hostLabel={null}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("home-focus-task-stop-all"));
    const dialog = await screen.findByTestId("home-focus-stop-all-dialog");
    assertCapClass(dialog, DIALOG_CAP);
    assertColumn(dialog);
    const list = screen.getByTestId("home-focus-stop-all-list");
    assertScrollClasses(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
    assertOutsideScroll(screen.getByTestId("home-focus-stop-all-cancel"), list);
  });

  it("EpicWriteCommandsDialog content carries the dialog cap and the command list carries the scroll classes", () => {
    writeCommandMocks.commands = Array.from({ length: ROW_COUNT }, (_, index) =>
      queuedCommand(
        `cmd-${String(index + 1)}`,
        `Queued rename ${String(index + 1)}`,
      ),
    );
    render(<EpicWriteCommandsDialog open onOpenChange={() => undefined} />);
    const dialog = screen.getByTestId("epic-write-commands-dialog");
    assertCapClass(dialog, DIALOG_CAP);
    assertColumn(dialog);
    const list = requireElement(
      dialog.querySelector("ul.overflow-y-auto"),
      "write command list",
    );
    assertScrollClasses(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
    assertOutsideScroll(screen.getByText("Pending changes"), list);
  });

  it("CanvasPageMenu content carries the popover cap and the page list carries the scroll classes", async () => {
    const user = userEvent.setup();
    const pages = canvasPages();
    const firstPage = pages[0];
    const boards: CanvasPageItems["boards"] = [];
    render(
      <CanvasPageMenu
        pages={pages}
        viewOnly={false}
        page={firstPage.id}
        boards={boards}
        onSelect={() => undefined}
        onRename={() => undefined}
        onAdd={() => undefined}
        onRemove={() => undefined}
        onCenterBoard={() => undefined}
        onMoveBoard={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pages" }));
    const popover = requireElement(
      document.querySelector("[data-slot='popover-content']"),
      "pages popover",
    );
    assertCapClass(popover, POPOVER_CAP);
    assertColumn(popover);
    expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
    const list = screen.getByRole("list", { name: "Canvas pages" });
    assertScrollClasses(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
    assertOutsideScroll(screen.getByRole("button", { name: "New page" }), list);
  });

  it("GithubMentionFilterPopover content carries the popover cap and the repository list carries the scroll classes", async () => {
    const user = userEvent.setup();
    render(
      withTooltip(
        <GithubMentionFilterPopover
          filter={{
            section: "pull-requests",
            epicId: "epic-1",
            repositories: githubRepositories(),
            selected: DEFAULT_PULL_REQUEST_MENTION_FILTER,
          }}
          onReturnFocus={() => undefined}
        />,
      ),
    );
    await user.click(screen.getByRole("button", { name: "Filter" }));
    const popover = requireElement(
      document.querySelector("[data-slot='popover-content']"),
      "mention filter popover",
    );
    assertCapClass(popover, POPOVER_CAP);
    assertColumn(popover);
    expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
    const list = requireElement(
      popover.querySelector("div.overflow-y-auto"),
      "repository list",
    );
    assertScrollClasses(list);
    expect(within(list).getAllByRole("radio").length).toBeGreaterThanOrEqual(
      ROW_COUNT,
    );
    assertOutsideScroll(screen.getByRole("radio", { name: "Open" }), list);
  });

  it("PrReferencePills content carries the popover cap and the pill list carries the scroll classes", async () => {
    const user = userEvent.setup();
    const references = Array.from({ length: ROW_COUNT + 1 }, (_, index) =>
      prReference(index),
    );
    render(
      withTooltip(
        <PrReferencePills
          references={references}
          detailOnHover={false}
          maximumVisible={1}
          className={undefined}
          testId="history-prs"
          openPrInApp={null}
        />,
      ),
    );
    await user.click(screen.getByTestId("worktree-pr-overflow-trigger"));
    const popover = screen.getByTestId("worktree-pr-overflow-content");
    assertCapClass(popover, POPOVER_CAP);
    assertColumn(popover);
    expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
    const list = requireElement(
      popover.querySelector("span.overflow-y-auto"),
      "overflow pills",
    );
    assertScrollClasses(list);
    assertOutsideScroll(screen.getByText("More pull requests"), list);
  });

  it("AddHostDialog content keeps the dialog cap through the merge and the steps carry the scroll classes", () => {
    scopeMocks.scope = {
      hosts: [],
      isLoading: false,
      listsFailed: false,
    };
    useAddHostDialogStore.getState().openDialog([]);
    render(<AddHostDialog />);
    const dialog = screen.getByTestId("add-host-dialog");
    assertCapClass(dialog, DIALOG_CAP);
    assertColumn(dialog);
    expect(unprefixedMaxHeightTokens(dialog.className)).toEqual([DIALOG_CAP]);
    const steps = innerOverflowYAuto(dialog);
    assertScrollClasses(steps);
    expect(steps.contains(screen.getByTestId("add-host-steps"))).toBe(true);
    assertOutsideScroll(screen.getByRole("button", { name: "Close" }), steps);
  });
});
