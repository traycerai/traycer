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
import { warmRouteChunks } from "@/lib/warm-route-chunks";
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
  warmRouteChunks();
  return router;
}

export interface AuthInvalidationRouter {
  readonly state: { readonly status: "pending" | "idle" };
  invalidate: () => Promise<void> | void;
  subscribe: (eventType: "onResolved", fn: () => void) => () => void;
}

/**
 * Re-runs route guards when the auth status or the signed-in user changes,
 * and never starts a router load while a navigation or the initial load is in
 * flight, which is what `status: "pending"` covers. Intent preloads and the
 * background revalidation of successful matches do not set pending, so they
 * are not waited for.
 *
 * `router.invalidate()` is itself a `router.load()`, and a second load
 * started under an in-flight one is unsafe on these router-core versions in
 * both shapes it takes:
 *
 *  - Before anything commits (a cold launch, where stored tokens validate
 *    while the initial load runs), the new load retires the in-flight one
 *    inside router-core's scheduler and nothing reschedules it: the router
 *    sits at `status: "pending"` forever behind a blank screen.
 *  - Once a load has outlived `defaultPendingMs`, its pending matches are
 *    rendered, and the second load's copies share `_nonReactive` with them.
 *    The first match to finish resolves and clears the shared
 *    `loadPromise`, a suspended match retries against the cleared promise
 *    and throws `undefined`, and `CatchBoundary` lets a falsy error through
 *    to the root error boundary. A fresh mobile install reaches this window
 *    on nearly every launch.
 *
 * So an auth change that lands mid-load waits for the load to resolve and
 * then invalidates once. Its guards read the auth snapshot that was current
 * when they ran, possibly the stale one, and the follow-up invalidate corrects
 * them against the latest. However many changes land in one load, they share
 * that single invalidate.
 */
export function bindAuthInvalidation(
  router: AuthInvalidationRouter,
): () => void {
  let disposed = false;
  let disarm: (() => void) | null = null;
  const invalidateWhenSettled = (): void => {
    if (disposed) return;
    if (router.state.status !== "pending") {
      void router.invalidate();
      return;
    }
    if (disarm !== null) return;
    disarm = router.subscribe("onResolved", () => {
      disarm?.();
      disarm = null;
      // The Transitioner emits `onResolved` BEFORE it sets `status: "idle"`,
      // in the same layout effect. A load started inside this listener
      // would be stamped idle while it runs, so it goes after that write.
      queueMicrotask(invalidateWhenSettled);
    });
  };
  const unsubscribe = useAuthStore.subscribe((state, prevState) => {
    if (
      state.status === prevState.status &&
      state.contextMetadata?.userId === prevState.contextMetadata?.userId
    ) {
      return;
    }
    invalidateWhenSettled();
  });
  return () => {
    disposed = true;
    unsubscribe();
    disarm?.();
    disarm = null;
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
