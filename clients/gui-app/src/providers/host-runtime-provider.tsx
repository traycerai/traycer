import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import type {
  HostClient,
  IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { createAuthAwareMessenger } from "@traycer-clients/shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import {
  hostListItemToDirectoryEntry,
  type RemoteHostFetcher,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { HostBindingAuthorityRegistry } from "@traycer-clients/shared/host-client/host-binding-authority-registry";
import { HostRequestCoordinator } from "@traycer-clients/shared/host-client/host-request-coordinator";
import type { RpcSchedulingPolicy } from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { AuthService } from "@/lib/auth/auth-service";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import {
  buildRuntimeHostMessenger,
  defaultHostRpcRequestId,
  type RuntimeHostMessengerBinding,
} from "@/lib/host/host-messenger";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { appLogger } from "@/lib/logger";
import {
  runnerHostQueryScopeId,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { useRunnerHost } from "@/providers/use-runner-host";

export interface HostRuntimeBinding<Registry extends VersionedRpcRegistry> {
  readonly runtime: HostRuntime<Registry>;
  readonly hostClient: HostClient<Registry>;
  readonly directory: HostDirectoryService;
  readonly auth: AuthService;
}

export interface HostRuntimeState<Registry extends VersionedRpcRegistry> {
  readonly context: Context<HostRuntimeBinding<Registry> | null>;
  readonly bindingSnapshot: {
    value: HostRuntimeBinding<Registry> | null;
  };
}

export function createHostRuntimeState<
  Registry extends VersionedRpcRegistry,
>(): HostRuntimeState<Registry> {
  return {
    context: createContext<HostRuntimeBinding<Registry> | null>(null),
    bindingSnapshot: { value: null },
  };
}

export type MessengerFactory<Registry extends VersionedRpcRegistry> = (args: {
  readonly registry: Registry;
}) => IHostMessenger<Registry>;

interface HostRuntimeProviderProps<Registry extends VersionedRpcRegistry> {
  readonly registry: Registry;
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  /**
   * Optional override that lets tests / mock mode substitute the messenger.
   * Production desktop omits this so the runtime builds a `WsRpcClient`
   * from the selected host's advertised WebSocket endpoint.
   */
  readonly messengerFactory: MessengerFactory<Registry> | null;
  /**
   * Optional override for the query invalidator. Production uses the app's
   * TanStack `queryClient`; tests pass a stub so assertions can observe
   * invalidation without spinning up a real client.
   */
  readonly invalidator: IHostQueryInvalidator | null;
  /** Optional request-id generator. Defaults to `uuid` v4. */
  readonly requestId: (() => string) | null;
  /**
   * Optional override for the remote-host fetcher. When `null`, the shared
   * stubbed `fetchRemoteHosts` is used via `HostDirectoryService`'s
   * default. Dev runners (gui-app-dev) inject a custom fetcher so scenario
   * fixtures drive the mounted picker / list.
   */
  readonly remoteFetcher: RemoteHostFetcher | null;
}

export interface TypedHostRuntime<Registry extends VersionedRpcRegistry> {
  readonly HostRuntimeProvider: (
    props: HostRuntimeProviderProps<Registry>,
  ) => ReactNode;
  readonly HostRuntimeContext: Context<HostRuntimeBinding<Registry> | null>;
  readonly useHostClient: () => HostClient<Registry>;
  readonly useHostDirectory: () => HostDirectoryService;
  readonly useAuthService: () => AuthService;
  readonly useHostBinding: () => HostRuntimeBinding<Registry> | null;
  readonly getBindingSnapshot: () => HostRuntimeBinding<Registry> | null;
}

/**
 * Builds a typed host-runtime provider + hooks bound to a specific
 * versioned registry.
 *
 * Lifecycle on mount:
 *   1. Construct GUI-owned `AuthService` and `HostDirectoryService` over
 *      the runner host from context.
 *   2. Build the messenger (`WsRpcClient` by default; tests inject mocks).
 *   3. Construct the shared `HostRuntime` with the services + messenger.
 *   4. `await auth.start()` to rehydrate any persisted token, then
 *      `await directory.start()` to subscribe to local-host snapshots
 *      and resolve initial remotes, then `runtime.start()` to wire auth /
 *      selection / local-host transitions into `HostClient`.
 *   5. Publish the binding so descendants can read `hostClient` / `auth`
 *      / `directory` through typed hooks.
 *
 * Unmount disposes the runtime and services.
 */
export function createHostRuntime<Registry extends VersionedRpcRegistry>(
  schedulingPolicy: RpcSchedulingPolicy<Registry>,
  runtimeState: HostRuntimeState<Registry>,
): TypedHostRuntime<Registry> {
  const { context, bindingSnapshot: latestBindingSnapshot } = runtimeState;
  const setLatestBindingSnapshot = (
    binding: HostRuntimeBinding<Registry> | null,
  ): void => {
    latestBindingSnapshot.value = binding;
  };

  function HostRuntimeProvider(
    props: HostRuntimeProviderProps<Registry>,
  ): ReactNode {
    // Destructure so the effect deps list references stable identifiers
    // rather than `props.X` lookups - satisfies `react-hooks/exhaustive-deps`
    // without widening the dep to the whole `props` object.
    const {
      registry,
      children,
      fallback,
      messengerFactory,
      invalidator: invalidatorProp,
      requestId: requestIdProp,
      remoteFetcher,
    } = props;

    const runnerHost = useRunnerHost();
    const queryClient = useQueryClient();
    const authorityRegistryRef = useRef<HostBindingAuthorityRegistry | null>(
      null,
    );
    const requestCoordinatorRef =
      useRef<HostRequestCoordinator<Registry> | null>(null);
    const authorityRegistryDisposalGeneration = useRef(0);
    if (authorityRegistryRef.current === null) {
      authorityRegistryRef.current = new HostBindingAuthorityRegistry();
    }
    const authorityRegistry = authorityRegistryRef.current;
    if (requestCoordinatorRef.current === null) {
      requestCoordinatorRef.current = new HostRequestCoordinator({
        registry,
        schedulingPolicy,
      });
    }
    const requestCoordinator = requestCoordinatorRef.current;
    const [binding, setBinding] = useState<HostRuntimeBinding<Registry> | null>(
      null,
    );

    const invalidator = useMemo<IHostQueryInvalidator>(() => {
      if (invalidatorProp !== null) {
        return invalidatorProp;
      }
      return createHostQueryInvalidator(queryClient);
    }, [invalidatorProp, queryClient]);

    const requestId = requestIdProp ?? defaultHostRpcRequestId;

    useEffect(() => {
      const lifecycle: { disposed: boolean } = { disposed: false };
      const isDisposed = (): boolean => lifecycle.disposed;

      const auth = new AuthService({ runnerHost });
      const directory = new HostDirectoryService({
        runnerHost,
        remoteFetcher:
          remoteFetcher ?? buildDefaultRemoteFetcher(auth, runnerHost),
        localHostIdSeeder: () =>
          queryClient.fetchQuery(localHostIdQueryOptions(runnerHost)),
      });

      let runtime: HostRuntime<Registry> | null = null;

      // Endpoint + bearer now ride the per-request `HostRequestAuthority` the
      // coordinator mints, so neither is closed over here. The remote branch
      // still needs the FULL directory entry (`kind`/`publicKey`) behind the
      // hostId an authority names - that lookup is all this seam supplies.
      //
      // Resolved against the whole DIRECTORY, not just the active host: a
      // transient requester (`createRequester`, Settings ▸ Worktrees / the
      // My Hosts panel) issues authorities for a non-active host, and keying
      // this off `getActiveHost()` would drop those onto the local WS client -
      // i.e. dial a relay attach URL directly and never connect.
      const resolveTarget = (hostId: string) =>
        runtime === null ? null : runtime.hostClient.resolveHostById(hostId);

      let runtimeMessenger: RuntimeHostMessengerBinding<Registry> | null = null;
      const rawMessenger: IHostMessenger<Registry> =
        messengerFactory !== null
          ? messengerFactory({ registry })
          : (runtimeMessenger = buildRuntimeHostMessenger({
              registry,
              resolveTarget,
              // UNAUTHORIZED session-fatal recovery for the shared remote
              // session: revalidate + redial with the fresh bearer instead of
              // terminally closing (the same recovery the stream transports
              // wire via `useStreamAuthRevalidator`).
              auth: createStreamAuthRevalidator(auth),
              authnBaseUrl: runnerHost.authnBaseUrl,
              requestId,
            })).messenger;
      // Closes the unary-RPC auth-recovery loop: a mid-call 401 from
      // the Traycer cloud backend is surfaced by the host as
      // `HostRpcError { code: "UNAUTHORIZED" }`, and this wrapper drives
      // `AuthService.revalidateCurrentContext()` so the GUI either rotates
      // the existing context's credential lease in place (refresh
      // succeeded) or signs the user out (refresh rejected) instead of
      // leaving them staring at a generic failure toast.
      // Retry is the outermost layer: a transport failure the host provably
      // never dispatched (`RetryableTransportError` - a pre-send dial/handshake
      // failure, or a host-attested post-`openAck` request timeout) re-dials on
      // a short backoff before the auth-aware wrapper or the query layer ever
      // see it. That includes the legacy `UNAUTHORIZED` spelling of the
      // post-open timeout, which is why the auth wrapper never sees it as a
      // credential rejection. The auth wrapper only acts on `UNAUTHORIZED`,
      // never a retryable transport error, so the two never contend. When auth revalidation really rotates the bearer,
      // retry the same RPC once against the fresh lease; some usage-limit
      // queries intentionally disable TanStack retry, so the refresh loop must
      // complete in the transport layer.
      const messenger: IHostMessenger<Registry> = createRetryingMessenger(
        createAuthAwareMessenger(rawMessenger, auth),
        DEFAULT_TRANSPORT_RETRY_POLICY,
      );

      runtime = new HostRuntime<Registry>({
        runnerHost,
        registry,
        messenger,
        requestContextProvider: auth.getRequestContextProvider(),
        directory,
        invalidator,
        authorityRegistry,
        schedulingPolicy,
        requestCoordinator,
      });

      const activeRuntime = runtime;
      const runtimeTransportUnsubscribe =
        runtimeMessenger === null
          ? null
          : activeRuntime.hostClient.onChange(() => {
              runtimeMessenger.reset();
            });
      void (async () => {
        let phase = "auth.start";
        try {
          appLogger.info("[host-runtime] startup begin", {
            hasCustomMessenger: messengerFactory !== null,
            hasRemoteFetcher: remoteFetcher !== null,
          });
          await auth.start();
          if (isDisposed()) {
            auth.dispose();
            activeRuntime.dispose();
            directory.dispose();
            return;
          }
          phase = "directory.start";
          await directory.start();
          if (isDisposed()) {
            auth.dispose();
            activeRuntime.dispose();
            directory.dispose();
            return;
          }
          phase = "runtime.start";
          activeRuntime.start();
          const nextBinding = {
            runtime: activeRuntime,
            hostClient: activeRuntime.hostClient,
            directory,
            auth,
          };
          setLatestBindingSnapshot(nextBinding);
          setBinding(nextBinding);
          appLogger.info("[host-runtime] startup complete", {
            hostCardinality: directory.getCardinality(),
            hasLocalHost: directory.getLocalEntry() !== null,
          });
        } catch (error) {
          appLogger.error("[host-runtime] startup failed", { phase }, error);
          runtimeMessenger?.dispose();
          runtimeTransportUnsubscribe?.();
          auth.dispose();
          activeRuntime.dispose();
          directory.dispose();
          if (!isDisposed()) {
            setLatestBindingSnapshot(null);
            setBinding(null);
          }
          return;
        }
      })();

      return () => {
        lifecycle.disposed = true;
        runtimeMessenger?.dispose();
        runtimeTransportUnsubscribe?.();
        activeRuntime.dispose();
        directory.dispose();
        auth.dispose();
        setLatestBindingSnapshot(null);
        setBinding(null);
      };
    }, [
      runnerHost,
      invalidator,
      requestId,
      registry,
      messengerFactory,
      remoteFetcher,
      authorityRegistry,
      requestCoordinator,
      queryClient,
    ]);

    useEffect(() => {
      authorityRegistryDisposalGeneration.current += 1;
      return () => {
        const cleanupGeneration = ++authorityRegistryDisposalGeneration.current;
        queueMicrotask(() => {
          if (
            authorityRegistryDisposalGeneration.current === cleanupGeneration
          ) {
            authorityRegistry.dispose();
            requestCoordinator.dispose();
          }
        });
      };
    }, [authorityRegistry, requestCoordinator]);

    if (binding === null) {
      return <>{fallback}</>;
    }

    return <context.Provider value={binding}>{children}</context.Provider>;
  }

  function useBinding(): HostRuntimeBinding<Registry> {
    const value = use(context);
    if (value === null) {
      throw new Error(
        "Host runtime hooks must be used inside a <HostRuntimeProvider>.",
      );
    }
    return value;
  }

  return {
    HostRuntimeProvider,
    HostRuntimeContext: context,
    useHostClient: () => useBinding().hostClient,
    useHostDirectory: () => useBinding().directory,
    useAuthService: () => useBinding().auth,
    useHostBinding: () => use(context),
    getBindingSnapshot: () => latestBindingSnapshot.value,
  };
}

/**
 * The production `RemoteHostFetcher` used whenever a caller does not override
 * one (S2/T14): every shell today passes `remoteFetcher={null}` down through
 * `TraycerApp`, which used to fall back to `HostDirectoryService`'s built-in
 * always-empty stub (S1 - "visible in My Hosts, not in the selectable
 * directory"). Reuses `AuthService.fetchRegisteredHosts()` - the same
 * bearer-gated `GET /api/v3/hosts` call My Hosts already makes - rather than
 * exposing a separate raw-bearer getter (the bearer deliberately never leaves
 * `AuthService`).
 *
 * Maps `fetchRegisteredHosts()`'s contract onto `RemoteHostFetchOutcome`
 * (T20 / audit P4): a `null` return (no bearer, or one the registry
 * rejected - `AuthService` deliberately does not distinguish the two so a
 * background poll never forces a sign-out) becomes `signed-out`; a thrown
 * network error becomes `failed` so `HostDirectoryService.refresh()` retains
 * the last-known remote entries instead of wiping the merged directory and
 * unbinding an active remote selection.
 */
/**
 * The shell's durable answer to "which host id is THIS machine", the value
 * `HostDirectoryService` seeds itself with before its first emission.
 *
 * Query owns the read like every other `RunnerHost` request, but the directory
 * consumes it through `fetchQuery` rather than a hook: the service is
 * constructed inside the provider's effect and must recognise this machine
 * BEFORE it emits a directory, so a hook's value would arrive a render too
 * late to BE the seed. `fetchQuery` still gives it the centralized key, the
 * cache, and in-flight dedupe.
 *
 * `retry: false` deliberately. `start()` awaits this, and the service already
 * falls back to the persisted id when the shell cannot answer - so Query's
 * default backoff would delay the first directory the user sees in order to
 * reach a value there is already a fallback for.
 */
function localHostIdQueryOptions(runnerHost: IRunnerHost) {
  return queryOptions({
    queryKey: runnerQueryKeys.lastKnownLocalHostId(
      runnerHostQueryScopeId(runnerHost),
    ),
    queryFn: () => runnerHost.getLastKnownLocalHostId(),
    retry: false,
  });
}

function buildDefaultRemoteFetcher(
  auth: AuthService,
  runnerHost: IRunnerHost,
): RemoteHostFetcher {
  return async () => {
    try {
      const response = await auth.fetchRegisteredHosts();
      if (response === null) {
        return { kind: "signed-out" };
      }
      return {
        kind: "hosts",
        entries: response.hosts.map((item) =>
          hostListItemToDirectoryEntry(item, runnerHost.relayBaseUrl),
        ),
      };
    } catch {
      return { kind: "failed" };
    }
  };
}
