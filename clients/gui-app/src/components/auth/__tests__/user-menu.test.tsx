import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { setMobileApp } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAccountContextStore } from "@/stores/auth/account-context-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { formatChordForDisplay } from "@/lib/keybindings/chord";

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
            // `null` = this fixture's host did not report the durable attempt,
            // which is exactly what host.status@1.2-and-older peers send.
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

function mountMenu(
  host: MockRunnerHost,
  children: ReactNode,
): {
  cleanupClient: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Tiny memory router so modal action hooks and any other router-dependent
  // hooks the menu pulls in transitively have a valid TanStack context to read
  // from.
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
  return {
    cleanupClient: () => {
      queryClient.clear();
    },
  };
}

describe("<UserMenu />", () => {
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
  });

  afterEach(() => {
    cleanup();
    setMobileApp(false);
    useAuthStore.getState().setSignedOut();
    useAccountContextStore.setState({ accountContext: { type: "PERSONAL" } });
    useTitleBarDragStore.setState({ suppressors: new Set() });
    useDesktopDialogStore.getState().close();
    restoreFetch();
  });

  it("opens via the avatar trigger and renders the identity block", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    const trigger = await screen.findByTestId("user-menu-trigger");
    await userEvent.click(trigger);

    const identity = await screen.findByTestId("user-menu-identity");
    expect(identity.textContent).toContain("Ada Lovelace");
    expect(identity.textContent).toContain("ada@example.com");
    result.cleanupClient();
  });

  // Regression: Base opens on mousedown (deferred one frame), so a click handler
  // that toggles `open` on release closes the menu it just opened. Hold the
  // press until Base's frame lands, then release, as a real ~150ms click does;
  // `userEvent.click` presses and releases too fast to expose it.
  it("stays open after a held press and release on the avatar trigger", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    const user = userEvent.setup();
    const trigger = await screen.findByTestId("user-menu-trigger");
    await user.pointer({ keys: "[MouseLeft>]", target: trigger });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
    await user.pointer({ keys: "[/MouseLeft]" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("user-menu-content")).toBeTruthy();
    result.cleanupClient();
  });

  // Anchor identity regression: the trigger button must not remount on open.
  it("keeps the avatar trigger as the same DOM node across the open transition (anchor identity)", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    const triggerBeforeOpen = await screen.findByTestId("user-menu-trigger");
    await userEvent.click(triggerBeforeOpen);

    expect(await screen.findByTestId("user-menu-content")).not.toBeNull();
    expect(screen.getByTestId("user-menu-trigger")).toBe(triggerBeforeOpen);
    result.cleanupClient();
  });

  // H10: the item is always there (no gate on showAppSettings or anything
  // else) and opens the avatar Drafts dialog through the real store.
  it("opens the Drafts dialog and closes the menu", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    await userEvent.click(await screen.findByTestId("user-menu-trigger"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Drafts" }));

    expect(useDesktopDialogStore.getState().activeDialog).toBe("drafts");
    await waitFor(() => {
      expect(screen.queryByTestId("user-menu-content")).toBeNull();
    });
    result.cleanupClient();
  });

  it("withholds Manage subscription in the installed mobile app, keeping settings and sign-out", async () => {
    // App Store review guideline 3.1.1: the installed app must not link out to
    // a subscription that cannot be bought through Apple. The other two
    // actions are unaffected by that rule and must stay.
    setMobileApp(true);
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings
        trigger={null}
      />,
    );

    await userEvent.click(await screen.findByTestId("user-menu-trigger"));
    await screen.findByTestId("user-menu-identity");

    expect(screen.queryByTestId("user-menu-manage-subscription")).toBeNull();
    expect(screen.getByTestId("user-menu-app-settings")).toBeTruthy();
    expect(screen.getByTestId("user-menu-sign-out")).toBeTruthy();
    result.cleanupClient();
  });

  it("offers Manage subscription outside the installed mobile app", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    await userEvent.click(await screen.findByTestId("user-menu-trigger"));
    await screen.findByTestId("user-menu-identity");

    expect(screen.getByTestId("user-menu-manage-subscription")).toBeTruthy();
    result.cleanupClient();
  });

  it("opens the personal Billing page from Manage subscription", async () => {
    const host = buildHost();
    const result = mountMenu(
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
    fireEvent.click(await screen.findByTestId("user-menu-manage-subscription"));

    // The platform origin's root is the marketing homepage, so the item names
    // the Billing page on the shell's configured origin.
    await waitFor(() => {
      expect(host.openedExternalLinks).toEqual([
        "https://auth.traycer.invalid/billing",
      ]);
    });
    result.cleanupClient();
  });

  it("opens the selected team's Billing page from Manage subscription", async () => {
    useAccountContextStore.setState({
      accountContext: { type: "TEAM", teamId: "team-1" },
    });
    const host = buildHost();
    const result = mountMenu(
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
    // Set once mounted: this harness's auth bootstrap settles on signed-out,
    // which clears the projected teams it finds at mount.
    act(() => {
      useAuthStore.setState({
        shareableTeams: [{ teamId: "team-1", slug: "acme", avatarUrl: null }],
      });
    });
    fireEvent.click(await screen.findByTestId("user-menu-manage-subscription"));

    await waitFor(() => {
      expect(host.openedExternalLinks).toEqual([
        "https://auth.traycer.invalid/team/acme/billing",
      ]);
    });
    result.cleanupClient();
  });

  it("shows the current Settings shortcut beside the menu item", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings
        trigger={null}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Open user menu" }),
    );

    expect(
      (await screen.findByRole("menuitem", { name: /App settings/ }))
        .textContent,
    ).toContain(formatChordForDisplay("mod+,"));
    result.cleanupClient();
  });

  it("suppresses title-bar dragging only while the menu is open", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("user-menu");
    const trigger = await screen.findByTestId("user-menu-trigger");

    expect(isSuppressed()).toBe(false);

    await userEvent.click(trigger);
    expect(await screen.findByTestId("user-menu-content")).toBeTruthy();
    expect(isSuppressed()).toBe(true);

    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(isSuppressed()).toBe(false);
    });

    result.cleanupClient();
  });

  it("calls AuthService.signOut() once the Sign out confirm is accepted", async () => {
    const host = buildHost();
    await host.tokenStore.signIn(
      { token: "token", refreshToken: "token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    const trigger = await screen.findByTestId("user-menu-trigger");
    await userEvent.click(trigger);
    const signOut = await screen.findByTestId("user-menu-sign-out");
    fireEvent.click(signOut);

    // Selecting the item only asks - signing out is not undoable from the UI.
    expect(await host.tokenStore.get()).not.toBeNull();
    fireEvent.click(await screen.findByTestId("confirm-action"));

    // The cleared token store, not `useAuthStore.status`: this harness's auth
    // bootstrap lands on "signed-out" at mount regardless, so asserting the
    // status alone would pass whether or not sign-out ran.
    await waitFor(async () => {
      expect(await host.tokenStore.get()).toBeNull();
    });
    result.cleanupClient();
  });

  it("leaves the session alone when the Sign out confirm is cancelled", async () => {
    const host = buildHost();
    await host.tokenStore.signIn(
      { token: "token", refreshToken: "token-refresh" },
      { id: "user-1", email: "test@example.com", name: "Test User" },
    );
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={null}
      />,
    );

    await userEvent.click(await screen.findByTestId("user-menu-trigger"));
    fireEvent.click(await screen.findByTestId("user-menu-sign-out"));
    fireEvent.click(await screen.findByTestId("confirm-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
    });
    // The session survives - the token the accept case clears is still there.
    expect(await host.tokenStore.get()).not.toBeNull();
    result.cleanupClient();
  });

  it("renders the avatar image when an avatarUrl is provided", async () => {
    // Radix `AvatarImage` only commits the <img> once the image "loads", but
    // jsdom never fires load events - stub Image so the load resolves
    // synchronously and the loaded <img> renders.
    const originalImage: unknown = (globalThis as { Image?: unknown }).Image;
    // Radix resolves "loaded" from `image.complete && image.naturalWidth > 0`
    // (and a "load" event); jsdom's Image never satisfies either, so stub a
    // synchronously-complete image.
    class ImmediateImage {
      complete = true;
      naturalWidth = 1;
      src = "";
      addEventListener(
        type: string,
        listener: (event: { currentTarget: ImmediateImage }) => void,
      ): void {
        // Radix's `handleLoad` reads `event.currentTarget` (react-avatar >= 1.2)
        // to resolve the loaded image, so the synthetic event must carry it.
        if (type === "load") listener({ currentTarget: this });
      }
      removeEventListener(): void {}
    }
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      writable: true,
      value: ImmediateImage,
    });

    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl="https://example.com/ada.png"
        showAppSettings={false}
        trigger={null}
      />,
    );

    try {
      const trigger = await screen.findByTestId("user-menu-trigger");
      const image = await waitFor(() => {
        const el = trigger.querySelector(
          'img[src="https://example.com/ada.png"]',
        );
        if (el === null) throw new Error("avatar image not rendered yet");
        return el;
      });
      expect(image).not.toBeNull();
    } finally {
      result.cleanupClient();
      Object.defineProperty(globalThis, "Image", {
        configurable: true,
        writable: true,
        value: originalImage,
      });
    }
  });

  // The strip foot's account row passes its own trigger element; the menu
  // must open it through Radix's own pointerdown handling rather than an
  // onClick this component wires itself (jsdom has no PointerEvent capture,
  // so a plain click on a trigger with no onClick of its own would not open
  // it if Radix's mechanism were bypassed).
  it("opens a custom trigger through Base's own click handling", async () => {
    const host = buildHost();
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
        trigger={
          <button type="button" data-testid="custom-trigger">
            Custom
          </button>
        }
      />,
    );

    const trigger = await screen.findByTestId("custom-trigger");
    expect(screen.queryByTestId("user-menu-content")).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByTestId("user-menu-content")).toBeTruthy();

    result.cleanupClient();
  });
});
