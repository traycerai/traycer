/**
 * `TestEpicSessionTab`: the drop-in for `<EpicSessionProvider>` in suites.
 * Helpers live in `epic-session-controller-test-support.ts`; this file holds
 * only components.
 */
import { use, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { installEpicSessionControllerEnvironment } from "@/lib/registries/epic-session-controller";
import {
  openTestEpicTab,
  readTestEpicSessionHostClientResolver,
  setTestEffectiveHost,
  TEST_EPIC_TAB_NAME,
  type TestEpicSessionEnvironment,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { useAuthService, useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useDurableStreamTransportFactory } from "@/lib/host/use-durable-stream-transport";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { hasActiveTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";

/**
 * The controller's environment and host selection, derived from the SAME
 * hooks `EpicSessionProvider` read before the controller existed.
 *
 * That is the point of it: two dozen suites steer a session by mocking
 * `useEffectiveHostId`, `useHostClientForHostId`, `useAuthService` and the
 * transport factory, and re-render to move the host. The controller reads the
 * selection STORE, not those hooks, so this component mirrors what the hooks
 * answer into the store on every commit and installs an environment that
 * reads the hooks' latest values. A suite's mocks keep steering; a suite with
 * no mocks mirrors the store onto itself.
 */
function TestEpicSessionHookEnvironment(): ReactNode {
  const openTransport = useDurableStreamTransportFactory();
  const effectiveHostId = useEffectiveHostId();
  const attached = useSelectionAuthorityAttached();
  const authService = useAuthService();
  const { hostClient } = useHostBinding() ?? {};
  const effectiveHostClient = useHostClientForHostId(effectiveHostId);
  const latest = useRef({ openTransport, authService });
  // The production bridge retains each named requester for the life of its
  // binding. A test binding may recreate its wrapper around the same spine.
  const requesters = useMemo(
    () => ({ hostClient, byId: new Map<string, typeof effectiveHostClient>() }),
    [hostClient],
  );
  // The suite's own Query client, when it provides one: the session's History
  // and home write-throughs are controller-owned and need it, exactly as the
  // app's bridge supplies the app's.
  const queryClient = use(QueryClientContext) ?? null;
  const environment = useMemo(
    (): TestEpicSessionEnvironment => ({
      openTransport: (hostId) => latest.current.openTransport(hostId),
      resolveHostClient: (hostId) => {
        const override = readTestEpicSessionHostClientResolver();
        if (override !== null) return override(hostId);
        if (requesters.byId.has(hostId))
          return requesters.byId.get(hostId) ?? null;
        if (requesters.hostClient === undefined) return null;
        const client = resolveNamedHostClient(
          { hostClient: requesters.hostClient },
          hostId,
        );
        requesters.byId.set(hostId, client);
        return client;
      },
      revalidateAuth: () => {
        void latest.current.authService.revalidateCurrentContext();
      },
      queryClient,
    }),
    [queryClient, requesters],
  );
  // EVERY commit, no deps: a re-render is how these suites say "an input
  // moved" - they mutate what a mocked hook answers and re-render, where
  // production would hear a store or host-row notification. Re-installing the
  // same environment is the controller's "reconcile everything".
  useLayoutEffect(() => {
    latest.current = { openTransport, authService };
    // Hook-only harnesses supply no binding. Retain each client observed at
    // that seam when the effective host changes.
    if (hostClient === undefined && effectiveHostId !== null) {
      requesters.byId.set(effectiveHostId, effectiveHostClient);
    }
    const selection = useSelectionAuthorityStore.getState();
    if (
      !hasActiveTestSelectionAuthority() &&
      (selection.effectiveHostId !== effectiveHostId ||
        selection.attached !== attached)
    ) {
      setTestEffectiveHost(effectiveHostId, attached);
    }
    installEpicSessionControllerEnvironment(environment);
  });
  return null;
}

/**
 * `EpicSessionProvider` for a tab that is OPEN - what every production mount
 * of the provider is - with the controller's environment derived from the
 * suite's hooks. The tab is opened in a layout effect, which runs before the
 * provider's own passive effects attach its surface.
 */
export function TestEpicSessionTab(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly children: ReactNode;
}): ReactNode {
  const { epicId, tabId, children } = props;
  useLayoutEffect(() => {
    openTestEpicTab(tabId, epicId, TEST_EPIC_TAB_NAME);
  }, [epicId, tabId]);
  return (
    <>
      <TestEpicSessionHookEnvironment />
      <EpicSessionProvider epicId={epicId} tabId={tabId}>
        {children}
      </EpicSessionProvider>
    </>
  );
}
