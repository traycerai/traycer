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

const VIEWPORTS: readonly {
  readonly width: number;
  readonly height: number;
}[] = [
  { width: 1440, height: 1000 },
  { width: 1280, height: 720 },
  { width: 844, height: 390 },
];

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

const ORIGINAL_INNER_WIDTH = window.innerWidth;
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

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

vi.mock("@/hooks/sandboxes/use-sandbox-catalogue-query", () => ({
  useSandboxCatalogue: () => ({
    isPending: false,
    isError: false,
    data: sandboxCatalogueState.data,
  }),
}));

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

function applyViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
  const root = document.documentElement.style;
  root.setProperty("--radix-popover-content-available-height", `${height}px`);
  root.setProperty(
    "--radix-dropdown-menu-content-available-height",
    `${height}px`,
  );
  root.setProperty("--spacing-safe-dvh", `${height}px`);
  root.setProperty("--spacing-safe-bottom", "0px");
}

function restoreViewport(): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: ORIGINAL_INNER_WIDTH,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: ORIGINAL_INNER_HEIGHT,
  });
  const root = document.documentElement.style;
  root.removeProperty("--radix-popover-content-available-height");
  root.removeProperty("--radix-dropdown-menu-content-available-height");
  root.removeProperty("--spacing-safe-dvh");
  root.removeProperty("--spacing-safe-bottom");
}

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

const injectedStyles: HTMLStyleElement[] = [];

function injectUtility(className: string, declaration: string): void {
  const style = document.createElement("style");
  style.textContent = `.${CSS.escape(className)} { ${declaration} }`;
  document.head.appendChild(style);
  injectedStyles.push(style);
}

function clearInjectedStyles(): void {
  for (const style of injectedStyles) {
    style.remove();
  }
  injectedStyles.length = 0;
}

function documentCssPx(variable: string): number {
  const value = document.documentElement.style
    .getPropertyValue(variable)
    .trim();
  if (!/^\d+(\.\d+)?px$/.test(value)) {
    throw new Error(`expected ${variable} to be a pixel length`);
  }
  return Number.parseFloat(value);
}

function assertCappedMaxHeight(
  element: HTMLElement,
  capClass: string,
  declaration: string,
  viewportHeight: number,
): void {
  expect(element.className).toContain(capClass);
  injectUtility(capClass, declaration);
  const maxHeight = getComputedStyle(element).maxHeight;
  expect(maxHeight).toMatch(/^\d+(\.\d+)?px$/);
  expect(Number.parseFloat(maxHeight)).toBeLessThanOrEqual(viewportHeight);
}

function assertOverflowYAuto(element: HTMLElement): void {
  expect(hasToken(element.className, "overflow-y-auto")).toBe(true);
  injectUtility("overflow-y-auto", "overflow-y: auto;");
  expect(getComputedStyle(element).overflowY).toBe("auto");
}

function assertOutsideScroll(control: HTMLElement, scroll: HTMLElement): void {
  expect(document.body.contains(control)).toBe(true);
  expect(scroll.contains(control)).toBe(false);
}

function popoverCapDeclaration(): string {
  return `max-height: ${String(documentCssPx("--radix-popover-content-available-height"))}px;`;
}

function dropdownCapDeclaration(): string {
  return `max-height: ${String(documentCssPx("--radix-dropdown-menu-content-available-height"))}px;`;
}

function dialogCapDeclaration(): string {
  const dvh = documentCssPx("--spacing-safe-dvh");
  const bottom = documentCssPx("--spacing-safe-bottom");
  return `max-height: ${String(dvh - bottom)}px;`;
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

async function atEachViewport(
  run: (viewport: {
    readonly width: number;
    readonly height: number;
  }) => void | Promise<void>,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    applyViewport(viewport.width, viewport.height);
    resetOverlayStores();
    try {
      await run(viewport);
    } finally {
      cleanup();
      clearInjectedStyles();
      resetOverlayStores();
    }
  }
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
  clearInjectedStyles();
  restoreViewport();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  resetOverlayStores();
});

describe("bounded overlays", () => {
  it("ConfigurationStatusChip caps the popover and scrolls the host list", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
      assertCappedMaxHeight(
        popover,
        POPOVER_CAP,
        popoverCapDeclaration(),
        viewport.height,
      );
      const list = requireElement(
        popover.querySelector("ul.overflow-y-auto"),
        "host list",
      );
      assertOverflowYAuto(list);
      expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
      assertOutsideScroll(
        screen.getByRole("button", { name: "Details" }),
        list,
      );
    });
  });

  it("Browser host submenu caps the dropdown and scrolls pickable hosts", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(submenu.className, "overflow-hidden")).toBe(true);
      assertCappedMaxHeight(
        submenu,
        DROPDOWN_CAP,
        dropdownCapDeclaration(),
        viewport.height,
      );
      const list = requireElement(
        submenu.querySelector("div.overflow-y-auto"),
        "host filter list",
      );
      assertOverflowYAuto(list);
      const openLinksOn = within(submenu).getByText("Open links on");
      assertOutsideScroll(openLinksOn, list);
    });
  });

  it("McpServerDialog caps the dialog and keeps Cancel and Add outside the fields", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(dialog.className, "flex")).toBe(true);
      expect(hasToken(dialog.className, "flex-col")).toBe(true);
      assertCappedMaxHeight(
        dialog,
        DIALOG_CAP,
        dialogCapDeclaration(),
        viewport.height,
      );
      const fields = innerOverflowYAuto(dialog);
      assertOverflowYAuto(fields);
      assertOutsideScroll(
        within(dialog).getByRole("button", { name: "Cancel" }),
        fields,
      );
      assertOutsideScroll(
        within(dialog).getByRole("button", { name: "Add" }),
        fields,
      );
    });
  });

  it("SandboxShapeSheet caps the dialog and keeps Use and Cancel outside the form body", async () => {
    await atEachViewport((viewport) => {
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
      );
      const dialog = screen.getByTestId("sandbox-shape-sheet");
      expect(hasToken(dialog.className, "flex")).toBe(true);
      expect(hasToken(dialog.className, "flex-col")).toBe(true);
      assertCappedMaxHeight(
        dialog,
        DIALOG_CAP,
        dialogCapDeclaration(),
        viewport.height,
      );
      const form = requireElement(dialog.querySelector("form"), "shape form");
      const body = requireElement(
        form.querySelector("div.overflow-y-auto"),
        "shape form body",
      );
      assertOverflowYAuto(body);
      assertOutsideScroll(screen.getByTestId("sandbox-shape-sheet-use"), body);
      assertOutsideScroll(screen.getByRole("button", { name: "Cancel" }), body);
    });
  });

  it("ConfirmDestructiveDialog caps the dialog and scrolls 15 child rows", async () => {
    await atEachViewport((viewport) => {
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
      expect(hasToken(dialog.className, "flex")).toBe(true);
      expect(hasToken(dialog.className, "flex-col")).toBe(true);
      assertCappedMaxHeight(
        dialog,
        DIALOG_CAP,
        dialogCapDeclaration(),
        viewport.height,
      );
      const body = requireElement(
        dialog.querySelector("div.min-h-0.overflow-y-auto"),
        "confirm body",
      );
      assertOverflowYAuto(body);
      expect(within(body).getAllByText(/^Idle sandbox \d+$/)).toHaveLength(
        ROW_COUNT,
      );
      assertOutsideScroll(screen.getByTestId("confirm-cancel"), body);
      assertOutsideScroll(screen.getByTestId("confirm-action"), body);
    });
  });

  it("HomeFocusTaskStopCluster Stop all dialog caps and scrolls 15 agents", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(dialog.className, "flex")).toBe(true);
      expect(hasToken(dialog.className, "flex-col")).toBe(true);
      assertCappedMaxHeight(
        dialog,
        DIALOG_CAP,
        dialogCapDeclaration(),
        viewport.height,
      );
      const list = screen.getByTestId("home-focus-stop-all-list");
      expect(hasToken(list.className, "overflow-y-auto")).toBe(true);
      assertOverflowYAuto(list);
      expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
      assertOutsideScroll(
        screen.getByTestId("home-focus-stop-all-cancel"),
        list,
      );
    });
  });

  it("EpicWriteCommandsDialog caps the dialog and scrolls 15 pending commands", async () => {
    await atEachViewport((viewport) => {
      writeCommandMocks.commands = Array.from(
        { length: ROW_COUNT },
        (_, index) =>
          queuedCommand(
            `cmd-${String(index + 1)}`,
            `Queued rename ${String(index + 1)}`,
          ),
      );
      render(<EpicWriteCommandsDialog open onOpenChange={() => undefined} />);
      const dialog = screen.getByTestId("epic-write-commands-dialog");
      expect(hasToken(dialog.className, "flex")).toBe(true);
      expect(hasToken(dialog.className, "flex-col")).toBe(true);
      assertCappedMaxHeight(
        dialog,
        DIALOG_CAP,
        dialogCapDeclaration(),
        viewport.height,
      );
      const list = requireElement(
        dialog.querySelector("ul.overflow-y-auto"),
        "write command list",
      );
      assertOverflowYAuto(list);
      expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
      assertOutsideScroll(screen.getByText("Pending changes"), list);
    });
  });

  it("CanvasPageMenu caps the popover and keeps New page outside the page list", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
      assertCappedMaxHeight(
        popover,
        POPOVER_CAP,
        popoverCapDeclaration(),
        viewport.height,
      );
      const list = screen.getByRole("list", { name: "Canvas pages" });
      assertOverflowYAuto(list);
      expect(within(list).getAllByRole("listitem")).toHaveLength(ROW_COUNT);
      assertOutsideScroll(
        screen.getByRole("button", { name: "New page" }),
        list,
      );
    });
  });

  it("GithubMentionFilterPopover caps the popover and scrolls repositories", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
      assertCappedMaxHeight(
        popover,
        POPOVER_CAP,
        popoverCapDeclaration(),
        viewport.height,
      );
      const list = requireElement(
        popover.querySelector("div.overflow-y-auto"),
        "repository list",
      );
      assertOverflowYAuto(list);
      expect(within(list).getAllByRole("radio").length).toBeGreaterThanOrEqual(
        ROW_COUNT,
      );
      const stateRadio = screen.getByRole("radio", { name: "Open" });
      expect(list.contains(stateRadio)).toBe(false);
    });
  });

  it("PrReferencePills overflow popover caps and keeps the heading outside the list", async () => {
    await atEachViewport(async (viewport) => {
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
      expect(hasToken(popover.className, "overflow-hidden")).toBe(true);
      assertCappedMaxHeight(
        popover,
        POPOVER_CAP,
        popoverCapDeclaration(),
        viewport.height,
      );
      const list = requireElement(
        popover.querySelector("span.overflow-y-auto"),
        "overflow pills",
      );
      assertOverflowYAuto(list);
      assertOutsideScroll(screen.getByText("More pull requests"), list);
    });
  });

  it("AddHostDialog caps the dialog and keeps Close outside the steps", async () => {
    await atEachViewport((viewport) => {
      scopeMocks.scope = {
        hosts: [],
        isLoading: false,
        listsFailed: false,
      };
      useAddHostDialogStore.getState().openDialog([]);
      render(<AddHostDialog />);
      const dialog = screen.getByTestId("add-host-dialog");
      expect(hasToken(dialog.className, "flex")).toBe(true);
      expect(hasToken(dialog.className, "flex-col")).toBe(true);
      expect(dialog.className).toContain(DIALOG_CAP);
      expect(unprefixedMaxHeightTokens(dialog.className)).toEqual([DIALOG_CAP]);
      assertCappedMaxHeight(
        dialog,
        DIALOG_CAP,
        dialogCapDeclaration(),
        viewport.height,
      );
      const steps = innerOverflowYAuto(dialog);
      assertOverflowYAuto(steps);
      expect(steps.contains(screen.getByTestId("add-host-steps"))).toBe(true);
      assertOutsideScroll(screen.getByRole("button", { name: "Close" }), steps);
    });
  });
});
