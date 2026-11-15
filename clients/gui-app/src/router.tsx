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
import {
  ROUTE_PENDING_MS,
  RoutePendingScreen,
} from "@/components/loading/route-pending-screen";
import { RouteErrorComponent } from "@/components/errors/route-error-component";
import { observeNestedFocusTraversals } from "@/lib/nested-focus-history-traversal";
import { observeTracyPlaceTraversals } from "@/lib/bots/tracy-place-traversal";
import { warmRouteChunks } from "@/lib/warm-route-chunks";
import {
  runWhenRouterSettled,
  type SettlingRouter,
} from "@/lib/router-settled";
import { routeTree } from "@/routeTree.gen";
import type { QueryClient } from "@tanstack/react-query";
import { useAuthStore, type AuthState } from "@/stores/auth/auth-store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export interface AppRouterContext {
  queryClient: QueryClient;
  getAuthSnapshot: () => AuthState;
  /**
   * The app-wide host client, already pinned to the effective host. A loader
   * that needs the host ID reads it off this client rather than from a second
   * accessor: the pair used to be two independent reads of the active slot,
   * which could disagree across a move mid-loader, and the ID half was the
   * privileged identity P4.2 deleted.
   */
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
    // Show a neutral loading screen once a navigation has pended past this
    // threshold instead of holding the previous screen. The pend is dominated
    // by code-split chunk download on first visit (see `warmRouteChunks`); warm
    // navigations resolve well under this threshold so the screen never flashes.
    defaultPendingMs: ROUTE_PENDING_MS,
    defaultPendingComponent: RoutePendingScreen,
    // Catch-all for any error thrown inside a route match (loader, beforeLoad,
    // or component render) that the route's own `errorComponent` didn't handle.
    // Without it an uncaught render error tears the whole tree down to a blank
    // canvas; with it the failure lands on the shared recovery card.
    defaultErrorComponent: RouteErrorComponent,
    context: {
      queryClient,
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => getAppHostClientSnapshot(),
    },
    ...(history === undefined ? {} : { history }),
  });
  bindAuthInvalidation(router);
  // Installed on `router.history` rather than the local `history`, because the
  // browser web app passes none and lets TanStack build its own: this is the
  // one place every backend's history is in hand.
  observeNestedFocusTraversals(router.history);
  observeTracyPlaceTraversals(router.history);
  warmRouteChunks();
  return router;
}

export interface AuthInvalidationRouter extends SettlingRouter {
  readonly state: {
    readonly status: "pending" | "idle";
    /**
     * Set when the router's first load resolves and never cleared after:
     * `undefined` means no load has completed yet.
     */
    readonly resolvedLocation: unknown;
  };
  invalidate: () => Promise<void> | void;
}

/**
 * Re-runs route guards when the auth status or the signed-in user changes,
 * without ever starting a load under another (see `runWhenRouterSettled`):
 * `router.invalidate()` is itself a `router.load()`.
 *
 * - Before the router has started its first load, a change starts nothing:
 *   that load reads the latest auth when it runs. The provisional session
 *   restored at start-up lands here, before `RouterProvider` mounts.
 * - During a load, including the first, a change waits for it to resolve and
 *   then invalidates once. That load's guards read the auth snapshot that was
 *   current when they ran, possibly a stale one, and the invalidate corrects
 *   them against the latest. However many changes land before it runs, they
 *   share that one invalidate.
 * - Otherwise it invalidates at once.
 */
export function bindAuthInvalidation(
  router: AuthInvalidationRouter,
): () => void {
  // One invalidate waits at a time; a task that runs at once has already
  // cleared the flag, and cancelling it after is a no-op.
  let waiting = false;
  let cancelWaiting: () => void = () => undefined;
  const unsubscribe = useAuthStore.subscribe((state, prevState) => {
    if (
      state.status === prevState.status &&
      state.contextMetadata?.userId === prevState.contextMetadata?.userId
    ) {
      return;
    }
    if (
      router.state.status !== "pending" &&
      router.state.resolvedLocation === undefined
    ) {
      return;
    }
    if (waiting) return;
    waiting = true;
    cancelWaiting = runWhenRouterSettled(router, () => {
      waiting = false;
      void router.invalidate();
    });
  });
  return () => {
    unsubscribe();
    cancelWaiting();
    waiting = false;
  };
}

function isElectronContext(): boolean {
  if (typeof window === "undefined") return false;
  // Packaged production renderer loads the privileged `app://` scheme;
  // a `file://` fallback covers edge cases. Both signals are reliable.
  const protocol = window.location.protocol;
  if (protocol === "app:" || protocol === "file:") return true;
  // Electron dev (`make dev-desktop`) loads the Vite dev server over
  // `http://localhost:*`, so the protocol alone is indistinguishable
  // from the browser web app. Fall back to the User-Agent string, which
  // Electron stamps as `... Electron/<version> ...` even under Vite.
  const ua = window.navigator.userAgent;
  return ua.length > 0 && ua.indexOf("Electron/") !== -1;
}

function createAppHistory(
  initialRoute: string | null,
  windowId: string | null,
): RouterHistory | undefined {
  if (typeof window === "undefined") return undefined;
  // Browser web app (http: / https:): let TanStack pick `createBrowserHistory`
  // automatically so the URL bar drives navigation, deep links from sharing
  // work natively, and reload survives via the browser. A shell-injected
  // `initialRoute` still overrides via memory history below.
  if (!isElectronContext()) {
    // The installed mobile app owns its back stack, because it is the one
    // non-Electron shell whose ONLY history affordance is in-app: the phone has
    // no URL bar, no back button, and no room in its header for the desktop's
    // arrows - the edge swipe is the whole of back and forward there. TanStack's
    // own history would leave that gesture reading a stack nothing in this app
    // fills, which is a gesture that recognizes perfectly and then navigates
    // nowhere.
    //
    // `windowId` is deliberately `null`, which is what makes the stack
    // SESSION-scoped: both halves of the persistence layer no-op on a null
    // window, so nothing is read at boot and nothing is written. A phone's
    // process outlives every navigation the user makes inside one sitting, so
    // the in-memory stack already survives everything a resume can do to it; a
    // stack restored across a COLD launch would instead hand the first swipe
    // after opening the app a surface from yesterday, which reads as the app
    // going somewhere the user never was.
    if (isMobileApp()) return createPersistentMemoryHistory(initialRoute, null);
    if (initialRoute === null) return undefined;
    return createMemoryHistory({
      initialEntries: [normalizeInitialRoute(initialRoute)],
    });
  }
  // Electron renderer: no URL bar, the scheme drops the path on relaunch.
  // Use a memory history seeded from `localStorage` so the router boots at
  // the last visited route synchronously, with no async gate.
  return createPersistentMemoryHistory(initialRoute, windowId);
}

function normalizeInitialRoute(initialRoute: string | null): string {
  if (initialRoute === null) return "/";
  if (!initialRoute.startsWith("/")) return "/";
  return initialRoute;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
