/**
 * Mounts one identity's session for the tab that shows it.
 *
 * Three things happen here and nowhere else in the identity surface:
 *
 * 1. The tab's HOST is bound for life: `<TabHostProvider hostId>` so every
 *    unary consumer below reads `useTabHostClient()`, and the tab host's STREAM
 *    transport is re-provided as `StreamRuntimeContext` through
 *    `useSurfaceHostStreamBinding(hostId)`, the same way the pinned git-diff
 *    and PR surfaces move their transport.
 * 2. The family is GATED: both lanes must be `supported` on that transport
 *    (`hostServesAgentIdentityLanes`) and the unaries must be in the host's
 *    manifest. Either half missing means the family is absent on this host,
 *    and the surface says so rather than opening a lane that will be refused.
 * 3. The session is ACQUIRED from the registry in an effect, keyed
 *    `(hostId, identityId)`, and read back through `useSyncExternalStore` -
 *    the same shape `EpicSessionProvider` uses, so nothing here sets state
 *    inside an effect.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { IdentityStateStreamClient } from "@traycer-clients/shared/host-transport/identity-state-stream-client";
import { IdentityFileStreamClient } from "@traycer-clients/shared/host-transport/identity-file-stream-client";
import { hostServesAgentIdentityLanes } from "@traycer-clients/shared/identity-lanes/lane-capability";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import {
  StreamRuntimeContext,
  useStreamMethodSupportFor,
} from "@/lib/host/stream-runtime-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { ensureProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import {
  acquireOpenIdentitySession,
  peekOpenIdentitySession,
  subscribeOpenIdentitySessions,
} from "@/stores/identities/open-identity/session-registry";
import { createOpenIdentityStore } from "@/stores/identities/open-identity/store";
import {
  OpenIdentityContext,
  type OpenIdentityGate,
} from "./open-identity-context";

export interface OpenIdentityProviderProps {
  readonly identityId: string;
  readonly hostId: string;
  readonly children: ReactNode;
}

/** The unary the whole family is gated on; a host that has one has them all. */
const IDENTITY_UNARY_PROBE = "agentIdentity.list";

export function OpenIdentityProvider(
  props: OpenIdentityProviderProps,
): ReactNode {
  const { identityId, hostId, children } = props;
  const streamBinding = useSurfaceHostStreamBinding(hostId);
  const wsStreamClient = streamBinding?.wsStreamClient ?? null;
  const stateSupport = useStreamMethodSupportFor(
    wsStreamClient,
    "agentIdentity.state.subscribe",
  );
  const fileSupport = useStreamMethodSupportFor(
    wsStreamClient,
    "agentIdentity.file.subscribe",
  );
  const unarySupported = useHostSupportsMethod(hostId, IDENTITY_UNARY_PROBE);

  const lanesServed = hostServesAgentIdentityLanes((method) => {
    const support =
      method === "agentIdentity.state.subscribe" ? stateSupport : fileSupport;
    return support ?? "unknown";
  });
  const lanesRefused =
    stateSupport === "unsupported" || fileSupport === "unsupported";
  const canOpen = wsStreamClient !== null && lanesServed && unarySupported;

  // The stream client the session's lanes dial. A ref rather than a closure
  // over the render's value: the session outlives any one render, and the
  // transport object is reused across reconnects by the stream client itself.
  const streamRef = useRef<IHostStreamClient<HostStreamRpcRegistry> | null>(
    null,
  );
  // Written in a layout effect, before the session effect below runs, so the
  // factories always dial the transport of the render that committed.
  useLayoutEffect(() => {
    streamRef.current = wsStreamClient;
  }, [wsStreamClient]);

  useEffect(() => {
    if (!canOpen) return;
    const session = acquireOpenIdentitySession(hostId, identityId, () =>
      createOpenIdentityStore({
        hostId,
        identityId,
        environment: createRendererRuntimeEnvironment(),
        stateStreamClientFactory: (id, callbacks, resumeProvider) => {
          const client = streamRef.current;
          if (client === null)
            throw new Error("identity stream transport gone");
          return new IdentityStateStreamClient({
            wsStreamClient: client,
            identityId: id,
            resumeProvider,
            callbacks,
          });
        },
        fileStreamClientFactory: (request) => {
          const client = streamRef.current;
          if (client === null)
            throw new Error("identity stream transport gone");
          return new IdentityFileStreamClient({
            wsStreamClient: client,
            identityId: request.identityId,
            path: request.path,
            authorityEpoch: request.authorityEpoch,
            seedOfferProvider: request.seedOfferProvider,
            callbacks: request.callbacks,
          });
        },
        getCurrentUserId: () => useAuthStore.getState().profile?.userId ?? null,
        memory: ensureProcessMemoryRuntime(createRendererRuntimeEnvironment()),
      }),
    );
    return session.release;
  }, [canOpen, hostId, identityId]);

  const readHandle = useCallback(
    () => peekOpenIdentitySession(hostId, identityId),
    [hostId, identityId],
  );
  const handle = useSyncExternalStore(
    subscribeOpenIdentitySessions,
    readHandle,
    readHandle,
  );

  const gate = useMemo<OpenIdentityGate>(() => {
    if (handle !== null) return { kind: "ready", handle };
    if (streamBinding === null) return { kind: "binding-pending" };
    if (lanesRefused || (!unarySupported && lanesServed)) {
      return { kind: "unsupported" };
    }
    return { kind: "unknown" };
  }, [handle, streamBinding, lanesRefused, unarySupported, lanesServed]);

  return (
    <TabHostProvider hostId={hostId}>
      <StreamRuntimeContext.Provider value={streamBinding}>
        <OpenIdentityContext.Provider value={gate}>
          {children}
        </OpenIdentityContext.Provider>
      </StreamRuntimeContext.Provider>
    </TabHostProvider>
  );
}
