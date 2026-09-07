import {
  createMemoryHistory,
  createRouter,
  type Router,
  type RouterHistory,
} from "@tanstack/react-router";
import { queryClient } from "@/lib/query-client";
import { getAppHostClientSnapshot } from "@/lib/host/runtime";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { isMobileApp } from "@/lib/mobile-app";
import { RoutePendingScreen } from "@/components/loading/route-pending-screen";
import { RouteErrorComponent } from "@/components/errors/route-error-component";
import { warmRouteChunks } from "@/lib/warm-route-chunks";
import { routeTree } from "@/routeTree.gen";
import type { QueryClient } from "@tanstack/react-query";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export interface AppRouterContext {
  queryClient: QueryClient;
  getAuthSnapshot: () => AuthState;
  /** App-wide host client, already pinned to the effective host. Loaders read the host id off this client, not a second accessor. */
  getHostClient: () => HostClient<HostRpcRegistry> | null;
}

export type AppRouter = Router<typeof routeTree>;

export function createAppRouter(
  initialRoute: string | null,
  windowId: string | null,
): AppRouter {
  const history = createAppHistory(initialRoute, windowId);
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Neutral loading screen after this pend. Warm navigations resolve well under it.
    defaultPendingMs: 200,
    defaultPendingComponent: RoutePendingScreen,
    // Catch-all for route errors the route's own `errorComponent` did not handle. Without it an uncaught render tears the tree to a blank canvas.
    defaultErrorComponent: RouteErrorComponent,
    context: {
      queryClient,
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => getAppHostClientSnapshot(),
    },
    ...(history === undefined ? {} : { history }),
  });
  bindAuthInvalidation(router);
  warmRouteChunks();
  return router;
}

export interface AuthInvalidationRouter {
  readonly state: {
    readonly status: "pending" | "idle";
    /** Set after the first load's match set commits; undefined includes committed-but-unacknowledged. matches is unusable: pending matches publish first. */
    readonly resolvedLocation?: unknown;
  };
  invalidate: () => Promise<void> | void;
  load: () => Promise<void> | void;
}

export function bindAuthInvalidation(
  router: AuthInvalidationRouter,
): () => void {
  // At most one recovery load per uncommitted window: `router.load()` aborts its predecessor rather than joining it.
  let recovery: Promise<void> | null = null;
  return useAuthStore.subscribe((state, prevState) => {
    if (
      state.status === prevState.status &&
      state.contextMetadata?.userId === prevState.contextMetadata?.userId
    ) {
      return;
    }
    // Cold launch: auth can flip while the initial load is still in flight. Invalidating then orphans the load and leaves a blank screen.
    const uncommitted =
      router.state.status === "pending" &&
      router.state.resolvedLocation === undefined;
    if (!uncommitted) {
      void router.invalidate();
      return;
    }
    if (recovery !== null) {
      // The active recovery's post-settle invalidate already re-runs guards against the latest auth snapshot.
      return;
    }
    const invalidateAfterSettle = () => {
      recovery = null;
      // A rejected load still owes the auth change its recheck.
      void router.invalidate();
    };
    recovery = Promise.resolve(router.load()).then(
      invalidateAfterSettle,
      invalidateAfterSettle,
    );
  });
}

function isElectronContext(): boolean {
  if (typeof window === "undefined") return false;
  // Packaged production renderer loads `app://`; `file://` covers edge cases.
  const protocol = window.location.protocol;
  if (protocol === "app:" || protocol === "file:") return true;
  // Electron dev loads Vite over `http://localhost:*`. Fall back to the User-Agent `Electron/` stamp.
  const ua = window.navigator.userAgent;
  return ua.length > 0 && ua.indexOf("Electron/") !== -1;
}

function createAppHistory(
  initialRoute: string | null,
  windowId: string | null,
): RouterHistory | undefined {
  if (typeof window === "undefined") return undefined;
  // Browser web app: TanStack `createBrowserHistory`. A shell-injected `initialRoute` still overrides via memory history.
  if (!isElectronContext()) {
    // Installed mobile app owns its back stack. `windowId` is null so the stack is session-scoped: a cold-launch restore would swipe to yesterday's surface.
    if (isMobileApp()) return createPersistentMemoryHistory(initialRoute, null);
    if (initialRoute === null) return undefined;
    return createMemoryHistory({
      initialEntries: [normalizeInitialRoute(initialRoute)],
    });
  }
  // Electron renderer: memory history seeded from `localStorage` so the last route boots synchronously.
  return createPersistentMemoryHistory(initialRoute, windowId);
}

function normalizeInitialRoute(initialRoute: string | null): string {
  if (initialRoute === null) return "/";
  if (!initialRoute.startsWith("/")) return "/";
  return initialRoute;
}

export const router = createAppRouter(null, null);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
