/**
 * The account menu's Host section: `UserMenuHostSection` inside
 * `<UserMenu />`. `useHostOptions` and `useMakeActiveHost` are mocked
 * module-level, as every host-picker suite does (see
 * `host-scope-fixture.ts`), so this suite is about the SECTION's own
 * rendering and click behaviour, not about how the host list is built.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { UserMenu } from "@/components/auth/user-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import {
  hostOptionsFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostOptions } from "@/components/settings/host-scope/use-host-options";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import {
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";

const hostOptionsRef = vi.hoisted((): { value: HostOptions } => ({
  value: {
    hosts: [],
    activeHostId: null,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  },
}));
const makeActiveRef = vi.hoisted(
  (): { fn: (hostId: string) => Promise<boolean> } => ({
    fn: () => Promise.resolve(false),
  }),
);
/** The write in flight from ANY surface (R1-A2's module-level latch), mocked
 * here as a plain mutable ref so a test can put a switch in flight without
 * standing up the real authority/selection machinery. */
const activatingHostRef = vi.hoisted((): { value: string | null } => ({
  value: null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => hostOptionsRef.value,
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useMakeActiveHost: () => ({
    makeActive: (hostId: string) => makeActiveRef.fn(hostId),
    isActivating: activatingHostRef.value !== null,
    activatingHostId: activatingHostRef.value,
  }),
}));

/**
 * A sandbox row as the host list builds it: the directory entry carries the
 * sandbox facts, and a team's row also carries the registry owner. A team
 * row is the one `activate` refuses.
 */
function sandboxOption(hostId: string, teamId: string | null): HostScopeOption {
  return hostScopeOptionFixture({
    hostId,
    name: hostId,
    kind: "sandbox",
    isLocalMachine: false,
    isActive: false,
    connectable: true,
    entry: remoteEntry(hostId, sandboxFacts(teamId)),
    item:
      teamId === null
        ? null
        : {
            hostId,
            displayName: hostId,
            platform: "linux-x64",
            kind: "sandbox",
            publicKey: "pk",
            createdAt: new Date(0).toISOString(),
            updatePolicy: "manual",
            status: {
              connectivity: "connectable",
              viewerReachability: "unknown",
              clientCloud: "ok",
              updateState: "current",
              appVersion: "1.4.2",
              lastSeenAt: new Date(0).toISOString(),
            },
            owner: { kind: "team", id: teamId, name: "Alpha" },
          },
    sandbox: {
      state: "awake",
      frozen: false,
      summary: sandboxSummaryFixture({ id: `sbx-${hostId}` }),
      teamOwned: teamId !== null,
    },
  });
}

function buildHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function makeMessengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            updateOperation: null,
            updateTransaction: null,
            storeFormats: null,
            install: null,
            processMemory: null,
            crossHostMessaging: null,
            sessions: null,
            updatesExternallyManaged: null,
            previousExit: null,
          }),
      },
    });
}

function installFetch(): () => void {
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  };
}

function mountMenu(host: MockRunnerHost, children: ReactNode): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <RunnerHostProvider runnerHost={host}>
        <QueryClientProvider client={queryClient}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={makeMessengerFactory()}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback">…</div>}
          >
            <TooltipProvider>{children}</TooltipProvider>
          </HostRuntimeProvider>
        </QueryClientProvider>
      </RunnerHostProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

/**
 * Overrides `scrollWidth`/`clientWidth` for whichever element's ENTIRE text
 * content equals `hostName` - the name span `HostOptionRow` attaches its
 * `nameRef` to, and nothing else in the row.
 */
function stubHostNameOverflow(
  hostName: string,
  metrics: { readonly scrollWidth: number; readonly clientWidth: number },
): () => void {
  const originalScrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent === hostName ? metrics.scrollWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent === hostName ? metrics.clientWidth : 0;
    },
  });
  return () => {
    if (originalScrollWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollWidth",
        originalScrollWidth,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
    }
    if (originalClientWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  };
}

async function openMenu(): Promise<void> {
  const host = buildHost();
  mountMenu(
    host,
    <UserMenu
      userName="Ada Lovelace"
      email="ada@example.com"
      avatarUrl={null}
      showAppSettings={false}
      trigger={null}
    />,
  );
  fireEvent.click(await screen.findByTestId("user-menu-trigger"));
  await screen.findByTestId("user-menu-identity");
}

describe("<UserMenu /> host section", () => {
  let restoreFetch: () => void = () => undefined;

  beforeEach(() => {
    useAuthStore.getState().setSignedIn(
      {
        userId: "test-user",
        userName: "Ada Lovelace",
        email: "ada@example.com",
      },
      { userId: "test-user", username: "Ada Lovelace" },
      [],
    );
    restoreFetch = installFetch();
    useTitleBarDragStore.setState({ suppressors: new Set() });
    useDesktopDialogStore.getState().close();
    makeActiveRef.fn = () => Promise.resolve(false);
    activatingHostRef.value = null;
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useTitleBarDragStore.setState({ suppressors: new Set() });
    useDesktopDialogStore.getState().close();
    restoreFetch();
    hostOptionsRef.value = hostOptionsFixture({ hosts: [] });
    activatingHostRef.value = null;
  });

  it("lists every host, checks the active one, and disables an offline host", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      name: "Ada's Mac",
      isActive: true,
      connectable: true,
    });
    const otherOnline = hostScopeOptionFixture({
      hostId: "host-other",
      name: "Office Linux",
      isActive: false,
      connectable: true,
    });
    const offline = hostScopeOptionFixture({
      hostId: "host-offline",
      name: "Old Laptop",
      isActive: false,
      connectable: false,
      health: {
        state: "offline",
        label: "Offline",
        detail: null,
        tone: "idle",
        live: false,
      },
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [active, otherOnline, offline],
      activeHostId: active.hostId,
    });

    await openMenu();

    expect(screen.getByText("Host", { exact: true })).toBeTruthy();
    expect(screen.queryByText("Set the app's machine")).toBeNull();
    // OR-04: the Host heading has no sentence under it.
    expect(
      screen.queryByText(
        "Every window follows, and the choice outlives this one.",
      ),
    ).toBeNull();
    const hostSection = screen.getByTestId("user-menu-host-section");
    expect(hostSection).toBeTruthy();

    const activeRow = screen.getByTestId("user-menu-host-option-host-active");
    expect(activeRow.getAttribute("aria-checked")).toBe("true");
    expect(activeRow.getAttribute("aria-disabled")).toBeNull();

    const otherRow = screen.getByTestId("user-menu-host-option-host-other");
    expect(otherRow.getAttribute("aria-checked")).toBe("false");
    expect(otherRow.getAttribute("aria-disabled")).toBeNull();

    const offlineRow = screen.getByTestId("user-menu-host-option-host-offline");
    expect(offlineRow.getAttribute("aria-checked")).toBe("false");
    expect(offlineRow.getAttribute("aria-disabled")).toBe("true");
    expect(offlineRow.textContent).toContain("offline");
    const offlineName = screen.getByText("Old Laptop");
    const nameAndStatus = offlineName.parentElement;
    expect(nameAndStatus?.classList.contains("items-center")).toBe(true);
    expect(nameAndStatus?.contains(screen.getByText("offline"))).toBe(true);
  });

  it("bounds the host list while keeping account actions after it", async () => {
    const hosts = Array.from({ length: 15 }, (_, index) =>
      hostScopeOptionFixture({
        hostId: `host-${index}`,
        name: `Host ${index}`,
        isActive: index === 0,
        connectable: index !== 2,
        ...(index === 2
          ? {
              health: {
                state: "offline",
                label: "Offline",
                detail: null,
                tone: "idle",
                live: false,
              },
            }
          : {}),
      }),
    );
    hostOptionsRef.value = hostOptionsFixture({
      hosts,
      activeHostId: "host-0",
    });

    const host = buildHost();
    mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings
        trigger={null}
      />,
    );
    fireEvent.click(await screen.findByTestId("user-menu-trigger"));
    await screen.findByTestId("user-menu-identity");

    const menu = screen.getByTestId("user-menu-content");
    const hostSection = screen.getByTestId("user-menu-host-section");
    const actions = screen.getByTestId("user-menu-account-actions");
    expect(
      hostSection.classList.contains(
        "max-h-(--radix-dropdown-menu-content-available-height)",
      ),
    ).toBe(true);
    expect(hostSection.classList.contains("overflow-y-auto")).toBe(true);
    expect(menu.classList.contains("overflow-y-hidden")).toBe(true);
    expect(actions.classList.contains("shrink-0")).toBe(true);
    expect(
      hostSection.querySelectorAll('[data-testid^="user-menu-host-option-"]'),
    ).toHaveLength(15);
    expect(within(actions).getByText("Drafts")).toBeTruthy();
    expect(within(actions).getByText("App settings")).toBeTruthy();
    expect(within(hostSection).queryByText("App settings")).toBeNull();
    expect(within(actions).getByText("Manage subscription")).toBeTruthy();
    expect(within(actions).getByText("Sign out")).toBeTruthy();
    expect(
      hostSection.compareDocumentPosition(actions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leaves a team's sandbox out of the list, which activate would refuse, and keeps personal hosts and personal sandboxes", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [
        active,
        sandboxOption("sandbox-personal", null),
        sandboxOption("sandbox-team", "team-a"),
      ],
      activeHostId: active.hostId,
    });

    await openMenu();

    expect(
      screen.getByTestId("user-menu-host-option-host-active"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("user-menu-host-option-sandbox-personal"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("user-menu-host-option-sandbox-team"),
    ).toBeNull();
  });

  it("leaves a team's sandbox out of the list while its registry row has not arrived", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [
        active,
        sandboxOption("sandbox-personal", null),
        { ...sandboxOption("sandbox-team", "team-a"), item: null },
      ],
      activeHostId: active.hostId,
    });

    await openMenu();

    expect(
      screen.getByTestId("user-menu-host-option-sandbox-personal"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("user-menu-host-option-sandbox-team"),
    ).toBeNull();
    expect(
      screen
        .getAllByRole("menuitemradio")
        .some((row) => row.textContent.includes("sandbox-team")),
    ).toBe(false);
  });

  it("switches to a different online host on click", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });
    const otherOnline = hostScopeOptionFixture({
      hostId: "host-other",
      isActive: false,
      connectable: true,
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [active, otherOnline],
      activeHostId: active.hostId,
    });
    const makeActive = vi.fn(() => Promise.resolve(true));
    makeActiveRef.fn = makeActive;

    await openMenu();

    fireEvent.click(screen.getByTestId("user-menu-host-option-host-other"));

    await waitFor(() =>
      expect(screen.queryByTestId("user-menu-content")).toBeNull(),
    );
    expect(makeActive).toHaveBeenCalledTimes(1);
    expect(makeActive).toHaveBeenCalledWith("host-other");
  });

  it("keeps the menu open when the host activation is refused", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });
    const other = hostScopeOptionFixture({
      hostId: "host-other",
      isActive: false,
      connectable: true,
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [active, other],
      activeHostId: active.hostId,
    });
    let finishActivation: (landed: boolean) => void = () => {
      throw new Error("activation has not started");
    };
    const activation = new Promise<boolean>((resolve) => {
      finishActivation = resolve;
    });
    const makeActive = vi.fn(() => activation);
    makeActiveRef.fn = makeActive;

    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByTestId("user-menu-host-option-host-other"));
      finishActivation(false);
      await activation;
    });

    expect(makeActive).toHaveBeenCalledWith("host-other");
    expect(screen.getByTestId("user-menu-content")).toBeTruthy();
  });

  it("does nothing when clicking the already-active host", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [active],
      activeHostId: active.hostId,
    });
    const makeActive = vi.fn(() => Promise.resolve(false));
    makeActiveRef.fn = makeActive;

    await openMenu();

    fireEvent.click(screen.getByTestId("user-menu-host-option-host-active"));

    expect(makeActive).not.toHaveBeenCalled();
  });

  it("renders no Host section for a zero-host account", async () => {
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [],
      activeHostId: null,
    });

    await openMenu();

    expect(screen.queryByTestId("user-menu-host-section")).toBeNull();
    expect(screen.queryByText("Host")).toBeNull();
  });

  describe("failed host lists", () => {
    const only = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });

    it("offers Try loading hosts again with the reason under it, and retries the lists on click, when a list failed", async () => {
      const retryLists = vi.fn();
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [only],
        activeHostId: only.hostId,
        listsFailed: true,
        isLoading: false,
        retryLists,
      });

      await openMenu();

      const retry = screen.getByTestId("user-menu-host-retry-lists");
      expect(retry.textContent).toContain("Try loading hosts again");
      expect(
        screen.getByTestId("user-menu-host-retry-lists-reason").textContent,
      ).toBe("Some hosts may be missing");
      fireEvent.click(retry);

      expect(retryLists).toHaveBeenCalledTimes(1);
    });

    it("offers the retry on its own, with no reason line, when the failure left no host to pick", async () => {
      const retryLists = vi.fn();
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [],
        activeHostId: null,
        listsFailed: true,
        isLoading: false,
        retryLists,
      });

      await openMenu();

      const retry = screen.getByTestId("user-menu-host-retry-lists");
      expect(retry.textContent).toBe("Try loading hosts again");
      expect(
        screen.queryByTestId("user-menu-host-retry-lists-reason"),
      ).toBeNull();
      fireEvent.click(retry);

      expect(retryLists).toHaveBeenCalledTimes(1);
    });

    it("shows no retry when the lists did not fail", async () => {
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [only],
        activeHostId: only.hostId,
        listsFailed: false,
        isLoading: false,
      });

      await openMenu();

      expect(screen.queryByTestId("user-menu-host-retry-lists")).toBeNull();
      expect(screen.queryByTestId("user-menu-host-loading-more")).toBeNull();
    });

    it("says more hosts are loading, in a disabled item and with no retry, while a list is on its first read", async () => {
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [only],
        activeHostId: only.hostId,
        listsFailed: true,
        isLoading: true,
      });

      await openMenu();

      const loading = screen.getByTestId("user-menu-host-loading-more");
      expect(loading.textContent).toContain("Loading more hosts…");
      expect(loading.getAttribute("aria-disabled")).toBe("true");
      expect(screen.queryByTestId("user-menu-host-retry-lists")).toBeNull();
    });
  });

  it("holds every row and shows the spinner on the pending one while a switch is in flight (R1-A2)", async () => {
    const active = hostScopeOptionFixture({
      hostId: "host-active",
      isActive: true,
      connectable: true,
    });
    const pending = hostScopeOptionFixture({
      hostId: "host-pending",
      isActive: false,
      connectable: true,
    });
    const other = hostScopeOptionFixture({
      hostId: "host-other",
      isActive: false,
      connectable: true,
    });
    hostOptionsRef.value = hostOptionsFixture({
      hosts: [active, pending, other],
      activeHostId: active.hostId,
    });
    // A write already in flight FROM ANOTHER SURFACE (Settings, or an earlier
    // pick this same menu made before it was reopened) - the module-level
    // latch means every mount of the hook sees it, this menu's included.
    activatingHostRef.value = "host-pending";
    const makeActive = vi.fn(() => Promise.resolve(false));
    makeActiveRef.fn = makeActive;

    await openMenu();

    // Held through `aria-disabled` alone: Radix's own `disabled` (which sets
    // `data-disabled`) would drop the row from roving focus.
    for (const hostId of ["host-active", "host-pending", "host-other"]) {
      const row = screen.getByTestId(`user-menu-host-option-${hostId}`);
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.hasAttribute("data-disabled")).toBe(false);
    }

    expect(
      screen.getByTestId("user-menu-host-activating-host-pending"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("user-menu-host-activating-host-active"),
    ).toBeNull();
    expect(
      screen.queryByTestId("user-menu-host-activating-host-other"),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("user-menu-host-option-host-other"));

    expect(makeActive).not.toHaveBeenCalled();
  });

  describe("host row tooltip (G4)", () => {
    it("shows the full name and app-wide choice when a pickable row is truncated", async () => {
      const active = hostScopeOptionFixture({
        hostId: "host-active",
        isActive: true,
        connectable: true,
      });
      const other = hostScopeOptionFixture({
        hostId: "host-other",
        name: "Office Linux Workstation",
        isActive: false,
        connectable: true,
      });
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [active, other],
        activeHostId: active.hostId,
      });
      const restore = stubHostNameOverflow("Office Linux Workstation", {
        scrollWidth: 240,
        clientWidth: 100,
      });

      await openMenu();
      const name = screen.getByText("Office Linux Workstation");
      expect(name.classList.contains("truncate")).toBe(true);
      fireEvent.focus(screen.getByTestId("user-menu-host-option-host-other"));
      const tooltip = await screen.findByRole("tooltip");

      expect(tooltip.textContent).toBe("Office Linux Workstation");
      restore();
    });

    it("shows no row tooltip when the name fits", async () => {
      const active = hostScopeOptionFixture({
        hostId: "host-active",
        isActive: true,
        connectable: true,
      });
      const other = hostScopeOptionFixture({
        hostId: "host-other",
        name: "Short",
        isActive: false,
        connectable: true,
      });
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [active, other],
        activeHostId: active.hostId,
      });
      const restore = stubHostNameOverflow("Short", {
        scrollWidth: 40,
        clientWidth: 100,
      });

      await openMenu();
      const row = screen.getByTestId("user-menu-host-option-host-other");
      expect(screen.getByText("Short").classList.contains("truncate")).toBe(
        true,
      );
      vi.useFakeTimers();
      try {
        fireEvent.pointerMove(row, { pointerType: "mouse" });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(501);
        });
        expect(screen.queryByRole("tooltip")).toBeNull();
      } finally {
        vi.useRealTimers();
        restore();
      }
    });

    it("shows no tooltip at all on the active row when its name fits", async () => {
      const active = hostScopeOptionFixture({
        hostId: "host-active",
        name: "Ada's Mac",
        isActive: true,
        connectable: true,
      });
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [active],
        activeHostId: active.hostId,
      });
      const restore = stubHostNameOverflow("Ada's Mac", {
        scrollWidth: 40,
        clientWidth: 100,
      });

      await openMenu();
      fireEvent.focus(screen.getByTestId("user-menu-host-option-host-active"));

      expect(screen.queryByRole("tooltip")).toBeNull();
      restore();
    });

    // A row is `aria-disabled`, never Radix's own `disabled` prop - `disabled`
    // would drop it from `RovingFocusGroupItem`'s `focusable` set, so ArrowDown
    // roving navigation would skip straight past it (Radix's own roving-focus
    // mechanism, not a raw `fireEvent.focus`, which reaches an item's `onFocus`
    // the same way regardless of `disabled` and so cannot tell the two apart).
    // `aria-disabled` keeps the row a real arrow-key stop, which is the only
    // way a keyboard user reaches a truncated, unpickable host's full name.
    it("reaches an offline (unpickable) host via ArrowDown roving focus and shows its full name in the tooltip", async () => {
      const active = hostScopeOptionFixture({
        hostId: "host-active",
        isActive: true,
        connectable: true,
      });
      const offline = hostScopeOptionFixture({
        hostId: "host-offline",
        name: "Very Long Offline Workstation Name",
        isActive: false,
        connectable: false,
        health: {
          state: "offline",
          label: "Offline",
          detail: null,
          tone: "idle",
          live: false,
        },
      });
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [active, offline],
        activeHostId: active.hostId,
      });
      const restore = stubHostNameOverflow(
        "Very Long Offline Workstation Name",
        {
          scrollWidth: 240,
          clientWidth: 100,
        },
      );

      await openMenu();
      const activeRow = screen.getByTestId("user-menu-host-option-host-active");
      const offlineRow = screen.getByTestId(
        "user-menu-host-option-host-offline",
      );
      fireEvent.keyDown(activeRow, { key: "ArrowDown" });

      await waitFor(() => {
        expect(document.activeElement).toBe(offlineRow);
      });
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("Very Long Offline Workstation Name");
      restore();
    });
  });

  describe("offline (unpickable) host row selection (G4 follow-up)", () => {
    it("does nothing when clicking or pressing Enter on an offline host - the check stays and the menu stays open", async () => {
      const active = hostScopeOptionFixture({
        hostId: "host-active",
        isActive: true,
        connectable: true,
      });
      const offline = hostScopeOptionFixture({
        hostId: "host-offline",
        isActive: false,
        connectable: false,
        health: {
          state: "offline",
          label: "Offline",
          detail: null,
          tone: "idle",
          live: false,
        },
      });
      hostOptionsRef.value = hostOptionsFixture({
        hosts: [active, offline],
        activeHostId: active.hostId,
      });
      const makeActive = vi.fn(() => Promise.resolve(false));
      makeActiveRef.fn = makeActive;

      await openMenu();
      const offlineRow = screen.getByTestId(
        "user-menu-host-option-host-offline",
      );

      fireEvent.click(offlineRow);
      fireEvent.keyDown(offlineRow, { key: "Enter" });

      expect(makeActive).not.toHaveBeenCalled();
      expect(
        screen
          .getByTestId("user-menu-host-option-host-active")
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(offlineRow.getAttribute("aria-checked")).toBe("false");
      expect(screen.getByTestId("user-menu-content")).toBeTruthy();
    });

    // The mid-switch "holds every row" case (R1-A2, above) already covers
    // pin 3: clicking another row while `activatingHostId` is set calls
    // `makeActive` zero times and every row (the pending one included)
    // carries `aria-disabled`.
  });
});
