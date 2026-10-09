/**
 * The account menu's Host section (F5): `UserMenuHostSection` inside
 * `<UserMenu />`. `useHostOptions` and `useMakeActiveHost` are mocked
 * module-level, as every host-picker suite does (see
 * `host-scope-fixture.ts`), so this suite is about the SECTION's own
 * rendering and click behaviour, not about how the host list is built.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { ACTIVATE_HOST_HINT } from "@/components/settings/host-scope/host-option-model";

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
const makeActiveRef = vi.hoisted((): { fn: (hostId: string) => void } => ({
  fn: () => undefined,
}));
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
 * `nameRef` to, and nothing else in the row (G4).
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
    }
    if (originalClientWidth !== undefined) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
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
    makeActiveRef.fn = () => undefined;
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

  it("lists every host under the Host label, checking the active one and disabling the offline one", async () => {
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

    expect(screen.getByText("Host")).toBeTruthy();
    expect(screen.getByTestId("user-menu-host-section")).toBeTruthy();

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
    const makeActive = vi.fn();
    makeActiveRef.fn = makeActive;

    await openMenu();

    fireEvent.click(screen.getByTestId("user-menu-host-option-host-other"));

    expect(makeActive).toHaveBeenCalledTimes(1);
    expect(makeActive).toHaveBeenCalledWith("host-other");
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
    const makeActive = vi.fn();
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
    const makeActive = vi.fn();
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
    it("shows the full name and the activate hint when the row's name is truncated", async () => {
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
      fireEvent.focus(screen.getByTestId("user-menu-host-option-host-other"));
      const tooltip = await screen.findByRole("tooltip");

      expect(tooltip.textContent).toContain("Office Linux Workstation");
      expect(tooltip.textContent).toContain(ACTIVATE_HOST_HINT);
      restore();
    });

    it("shows only the activate hint - no host name - when the row's name fits", async () => {
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
      fireEvent.focus(screen.getByTestId("user-menu-host-option-host-other"));
      const tooltip = await screen.findByRole("tooltip");

      expect(tooltip.textContent).toBe(ACTIVATE_HOST_HINT);
      restore();
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
      const makeActive = vi.fn();
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
