import {
  createMemoryHistory,
  createRouter,
  type Router,
  type RouterHistory,
} from "@tanstack/react-router";
import { queryClient } from "@/lib/query-client";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
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
  getActiveHostId: () => string | null;
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
    defaultPendingMs: 200,
    defaultPendingComponent: RoutePendingScreen,
    // Catch-all for any error thrown inside a route match (loader, beforeLoad,
    // or component render) that the route's own `errorComponent` didn't handle.
    // Without it an uncaught render error tears the whole tree down to a blank
    // canvas; with it the failure lands on the shared recovery card.
    defaultErrorComponent: RouteErrorComponent,
    context: {
      queryClient,
      getAuthSnapshot: () => useAuthStore.getState(),
      getActiveHostId: () =>
        getHostBindingSnapshot()?.hostClient.getActiveHostId() ?? null,
      getHostClient: () => getHostBindingSnapshot()?.hostClient ?? null,
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
    /**
     * Assigned once the first load's render is acknowledged (after its match
     * set commits) and never cleared afterwards — `undefined` means no load
     * has ever fully resolved, which conservatively includes the
     * just-committed-but-unacknowledged instant. `matches` is NOT usable
     * here: a cold load that outlives `defaultPendingMs` publishes
     * provisional pending matches before anything commits.
     */
    readonly resolvedLocation?: unknown;
  };
  invalidate: () => Promise<void> | void;
  load: () => Promise<void> | void;
}

export function bindAuthInvalidation(router: AuthInvalidationRouter): () => void {
  // At most one recovery load per uncommitted window, however many auth
  // changes land inside it: `router.load()` on these router-core versions
  // ABORTS its predecessor transaction rather than joining it, so issuing one
  // per auth flip multiplies route passes (and each continuation's invalidate
  // would fan out further).
  let recovery: Promise<void> | null = null;
  return useAuthStore.subscribe((state, prevState) => {
    if (
      state.status === prevState.status &&
      state.contextMetadata?.userId === prevState.contextMetadata?.userId
    ) {
      return;
    }
    // On a cold launch the auth status flips (e.g. signed-out → signed-in as
    // stored tokens validate) while the router's INITIAL load may still be in
    // flight — no match set has ever committed. Invalidating in that window
    // retires the in-flight load inside router-core's scheduler and nothing
    // reschedules it: the router sits at `status: "pending"` forever and the
    // app renders a permanently blank screen (no error, no pending component —
    // there is no committed match to hang either on). A fresh mobile install
    // hits this window on nearly every launch.
    const uncommitted =
      router.state.status === "pending" &&
      router.state.resolvedLocation === undefined;
    if (!uncommitted) {
      void router.invalidate();
      return;
    }
    if (recovery !== null) {
      // The active recovery's post-settle invalidate re-runs route guards
      // against the auth store's LATEST snapshot, so this later change is
      // already covered.
      return;
    }
    const invalidateAfterSettle = () => {
      recovery = null;
      // A rejected load still owes the auth change its recheck — invalidating
      // on failure also gives the failed load a retry with the fresh auth
      // snapshot.
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

export const router = createAppRouter(null, null);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
