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
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/index";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { HostBindingAuthorityRegistry } from "@traycer-clients/shared/host-client/host-binding-authority-registry";
import { HostRequestCoordinator } from "@traycer-clients/shared/host-client/host-request-coordinator";
import type { RpcSchedulingPolicy } from "@traycer-clients/shared/host-client/rpc-scheduling-policy";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { AuthService } from "@/lib/auth/auth-service";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
import { createAuthBoundHostDirectory } from "@/lib/host/auth-bound-host-directory";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import {
  buildRuntimeHostMessenger,
  defaultHostRpcRequestId,
  type RuntimeHostMessengerBinding,
} from "@/lib/host/host-messenger";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { acquireRendererSelectionKernel } from "@/lib/host/renderer-selection-kernel";
import {
  mountSelectionAuthorityBridge,
  type SelectionAuthorityBridge,
} from "@/lib/host/selection-authority-bridge";
import { createSessionRetirementSweep } from "@/lib/host/session-retirement";
import { buildHostKeyRotationSweep } from "@/lib/host/host-key-rotation-sweep";
import { buildRuntimeChangeScopeHandler } from "@/lib/host/runtime-change-scope";
import { appLogger } from "@/lib/logger";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { authQueryKeys } from "@/lib/query-keys";
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
  /** Host `hostClient` addresses, carried here rather than looked up beside it. `null` means read the app-wide effective host. Do not infer from `hostClient.getActiveHostId()`: a requester answers `null` while its directory row is unresolved. */
  readonly hostId: string | null;
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
  /** Test/mock messenger override. Production omits this and builds a `WsRpcClient`. */
  readonly messengerFactory: MessengerFactory<Registry> | null;
  /** Test invalidator override. Production uses the app TanStack `queryClient`. */
  readonly invalidator: IHostQueryInvalidator | null;
  /** Optional request-id generator. Defaults to `uuid` v4. */
  readonly requestId: (() => string) | null;
  /** Test/dev remote-host fetcher override. `null` uses `HostDirectoryService`'s default. */
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

/** Typed host-runtime provider + hooks. `directory.startSeeded()` leaves the registry listing in flight; nothing that paints reads it. */
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
    // Destructure so effect deps are stable identifiers, not `props.X` lookups.
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
      // Auth-derived wiring lives here so a test can exercise these accessors rather than re-typings of them.
      const directory = createAuthBoundHostDirectory({
        auth,
        runnerHost,
        remoteFetcher,
        localHostIdSeeder: () =>
          queryClient.fetchQuery(localHostIdQueryOptions(runnerHost)),
        // One liveness timer for the window: the directory poll. Registered-hosts observers refetch off this invalidation.
        onRegistryPollTick: () => {
          void queryClient.invalidateQueries({
            queryKey: authQueryKeys.registeredHostsAll(),
          });
        },
      });

      let runtime: HostRuntime<Registry> | null = null;
      // Mounted and torn down with the runtime so the kernel and the reporting client cannot outlive each other.
      let selectionBridge: SelectionAuthorityBridge | null = null;

      // Acquire the window's evidence kernel (renderer-load lifetime). Do not construct here: StrictMode remount would attach a second kernel against a spent client.
      const selectionKernel = acquireRendererSelectionKernel(
        runnerHost.selectionAuthority,
      );

      // Resolve against the whole directory, not the active host: a transient requester issues authorities for a non-active host.
      const resolveTarget = (hostId: string) =>
        runtime === null ? null : runtime.hostClient.resolveHostById(hostId);

      let runtimeMessenger: RuntimeHostMessengerBinding<Registry> | null = null;
      const rawMessenger: IHostMessenger<Registry> =
        messengerFactory !== null
          ? messengerFactory({ registry })
          : (runtimeMessenger = buildRuntimeHostMessenger({
              registry,
              resolveTarget,
              // UNAUTHORIZED session-fatal: revalidate + redial with the fresh bearer instead of terminally closing.
              auth: createStreamAuthRevalidator(auth),
              authnBaseUrl: runnerHost.authnBaseUrl,
              requestId,
              // Silent invalidation only: announcing would `runtimeMessenger.reset()` this binding as a side effect of its own recovery.
              onRemoteAvailabilityRecovered: (hostId) => {
                if (runtime === null) {
                  return;
                }
                runtime.hostClient.invalidateHostScopeUnannounced(hostId);
              },
            })).messenger;
      // Retry outermost for never-dispatched transport failures. Auth wrapper acts only on `UNAUTHORIZED`; retry the RPC once after a real bearer rotation.
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
        // Read ports only: one directory and one lease vocabulary. Adds the per-host "did this host's row move" verdict.
        connectionRegistry: {
          directory: {
            findById: (hostId) => directory.findById(hostId),
            onDirectoryChanged: (listener) => directory.onChange(listener),
          },
          leases: {
            leaseFor: (hostId) =>
              useSelectionAuthorityStore
                .getState()
                .leases.find((lease) => lease.hostId === hostId) ?? null,
            onLeasesChanged: (listener) => {
              const unsubscribe =
                useSelectionAuthorityStore.subscribe(listener);
              return { dispose: unsubscribe };
            },
          },
        },
      });

      const activeRuntime = runtime;
      const requestContextProvider = auth.getRequestContextProvider();
      // Retire previous-context remote sessions on any context transition. `runtimeMessenger.reset()` must run first in the change handler.
      const sweepRetiredContextSessions = createSessionRetirementSweep({
        currentContext: () => requestContextProvider.current(),
        retire: retireAllRemoteSessions,
      });
      // Reason-scoped; the filter lives in `buildRuntimeChangeScopeHandler` so a test can hold it.
      const runtimeTransportUnsubscribe = activeRuntime.hostClient.onChange(
        buildRuntimeChangeScopeHandler({
          resetMessenger: () => runtimeMessenger?.reset(),
          sweepRetiredSessions: sweepRetiredContextSessions,
        }),
      );
      // R-1: public-key rotation under a stable host id. Unannounced; subscribed to the directory, not the connection registry.
      const sweepRotatedHostScopes = buildHostKeyRotationSweep({
        sweepHostScope: (hostId) => {
          if (runtime === null) {
            return;
          }
          runtime.hostClient.invalidateHostScopeUnannounced(hostId);
        },
      });
      const rotationSweepSubscription = directory.onChange(
        sweepRotatedHostScopes,
      );
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
          // Seeded, not listed: leave `GET /api/v3/hosts` in flight. Until it lands the directory reports `"unknown"`, not `"zero"`.
          await directory.startSeeded();
          if (isDisposed()) {
            auth.dispose();
            activeRuntime.dispose();
            directory.dispose();
            return;
          }
          phase = "runtime.start";
          activeRuntime.start();
          // After `runtime.start()`: the connection registry is what tells a pinned consumer its row arrived.
          phase = "selection-bridge.mount";
          selectionBridge = mountSelectionAuthorityBridge({
            client: runnerHost.selectionAuthority,
            kernel: selectionKernel,
            hostLabels: {
              // Fall back to the id, not a placeholder: a directory lag is when the user most needs to know which host.
              labelFor: (hostId) => directory.findById(hostId)?.label ?? hostId,
            },
          });
          const nextBinding = {
            runtime: activeRuntime,
            hostClient: activeRuntime.hostClient,
            directory,
            auth,
            // App-wide binding: the only one that may answer `null`. Naming a host would pin every consumer.
            hostId: null,
          };
          setLatestBindingSnapshot(nextBinding);
          setBinding(nextBinding);
          appLogger.info("[host-runtime] startup complete", {
            hostCardinality: directory.getCardinality(),
            hasLocalHost: directory.getLocalEntry() !== null,
          });
        } catch (error) {
          appLogger.error("[host-runtime] startup failed", { phase }, error);
          selectionBridge?.dispose();
          runtimeMessenger?.dispose();
          runtimeTransportUnsubscribe();
          rotationSweepSubscription.dispose();
          auth.dispose();
          activeRuntime.dispose();
          directory.dispose();
          // Availability callback guards on `runtime === null`; without this reset that guard could never fire.
          runtime = null;
          if (!isDisposed()) {
            setLatestBindingSnapshot(null);
            setBinding(null);
          }
          return;
        }
      })();

      return () => {
        lifecycle.disposed = true;
        selectionBridge?.dispose();
        // Do not tear down the kernel here: it belongs to the renderer load. Releasing it on cleanup permanently detaches the window.
        runtimeMessenger?.dispose();
        runtimeTransportUnsubscribe();
        rotationSweepSubscription.dispose();
        activeRuntime.dispose();
        directory.dispose();
        auth.dispose();
        // Availability callback guards on `runtime === null`; without this reset that guard could never fire.
        runtime = null;
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

/** Local host id seed, via `fetchQuery` so the directory can emit before a hook would resolve. `retry: false`: the service already falls back to the persisted id. */
function localHostIdQueryOptions(runnerHost: IRunnerHost) {
  return queryOptions({
    queryKey: runnerQueryKeys.lastKnownLocalHostId(
      runnerHostQueryScopeId(runnerHost),
    ),
    queryFn: () => runnerHost.getLastKnownLocalHostId(),
    retry: false,
  });
}
