import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

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
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    useTitleBarDragStore.setState({ suppressors: new Set() });
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
      />,
    );

    const trigger = await screen.findByTestId("user-menu-trigger");
    fireEvent.click(trigger);

    const identity = await screen.findByTestId("user-menu-identity");
    expect(identity.textContent).toContain("Ada Lovelace");
    expect(identity.textContent).toContain("ada@example.com");
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
      />,
    );

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("user-menu");
    const trigger = await screen.findByTestId("user-menu-trigger");

    expect(isSuppressed()).toBe(false);

    fireEvent.click(trigger);
    expect(await screen.findByTestId("user-menu-content")).toBeTruthy();
    expect(isSuppressed()).toBe(true);

    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(isSuppressed()).toBe(false);
    });

    result.cleanupClient();
  });

  it("calls AuthService.signOut() when the Sign out item is selected", async () => {
    const host = buildHost();
    await host.tokenStore.set({
      token: "token",
      refreshToken: "token-refresh",
    });
    const result = mountMenu(
      host,
      <UserMenu
        userName="Ada Lovelace"
        email="ada@example.com"
        avatarUrl={null}
        showAppSettings={false}
      />,
    );

    const trigger = await screen.findByTestId("user-menu-trigger");
    fireEvent.click(trigger);
    const signOut = await screen.findByTestId("user-menu-sign-out");
    fireEvent.click(signOut);

    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe("signed-out");
    });
    expect(await host.tokenStore.get()).toBeNull();
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
});
