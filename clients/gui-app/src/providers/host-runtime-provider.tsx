import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  type Context,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import type {
  HostClient,
  IHostQueryInvalidator,
} from "@traycer-clients/shared/host-client/host-client";
import { HostRuntime } from "@traycer-clients/shared/host-client/host-runtime";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import { createAuthAwareMessenger } from "@traycer-clients/shared/host-transport/auth-aware-messenger";
import {
  createRetryingMessenger,
  DEFAULT_TRANSPORT_RETRY_POLICY,
} from "@traycer-clients/shared/host-transport/retrying-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import type { RemoteHostFetcher } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { AuthService } from "@/lib/auth/auth-service";
import { HostDirectoryService } from "@/lib/host/host-directory-service";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { appLogger } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";

export interface HostRuntimeBinding<Registry extends VersionedRpcRegistry> {
  readonly runtime: HostRuntime<Registry>;
  readonly hostClient: HostClient<Registry>;
  readonly directory: HostDirectoryService;
  readonly auth: AuthService;
}

export type MessengerFactory<Registry extends VersionedRpcRegistry> = (args: {
  readonly registry: Registry;
  readonly endpoint: () =>
    | import("@traycer-clients/shared/host-client/host-directory").HostDirectoryEntry
    | null;
  // Mirrors the transport's actual seam: a bearer source for the WS open frame,
  // not a full RequestContext. An override that wires a real WsRpcClient passes
  // this straight through.
  readonly bearer: () =>
    | import("@traycer-clients/shared/auth/bearer-source").OpenFrameBearerSource
    | null;
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
 * Per-frame timeout after a successful dial. 30 s covers slow downstream
 * work (e.g. the host waiting on an LLM call) without giving a stuck
 * socket an unbounded lease. Matches the host's post-open timeout
 * so neither side holds a dangling connection.
 */
const DEFAULT_WS_FRAME_TIMEOUT_MS = 30_000;

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
export function createHostRuntime<
  Registry extends VersionedRpcRegistry,
>(): TypedHostRuntime<Registry> {
  const context: Context<HostRuntimeBinding<Registry> | null> =
    createContext<HostRuntimeBinding<Registry> | null>(null);
  const latestBindingSnapshot: {
    value: HostRuntimeBinding<Registry> | null;
  } = { value: null };
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
    const [binding, setBinding] = useState<HostRuntimeBinding<Registry> | null>(
      null,
    );

    const invalidator = useMemo<IHostQueryInvalidator>(() => {
      if (invalidatorProp !== null) {
        return invalidatorProp;
      }
      return createHostQueryInvalidator(queryClient);
    }, [invalidatorProp, queryClient]);

    const requestId = requestIdProp ?? defaultRequestId;

    useEffect(() => {
      const lifecycle: { disposed: boolean } = { disposed: false };
      const isDisposed = (): boolean => lifecycle.disposed;

      const auth = new AuthService({ runnerHost });
      const directory = new HostDirectoryService({
        runnerHost,
        remoteFetcher,
      });

      let runtime: HostRuntime<Registry> | null = null;

      const endpoint = () =>
        runtime === null ? null : runtime.hostClient.getActiveHost();
      // The transport only needs the bearer; hand it the active context's
      // credential lease (a structural `OpenFrameBearerSource`). Shared by the
      // factory override and the default client so the port matches the seam.
      const bearer = () =>
        runtime === null
          ? null
          : (runtime.hostClient.getRequestContext()?.credentials ?? null);

      const rawMessenger: IHostMessenger<Registry> =
        messengerFactory !== null
          ? messengerFactory({ registry, endpoint, bearer })
          : new WsRpcClient<Registry>({
              registry,
              endpoint,
              bearer,
              requestId,
              webSocketFactory: createWhatwgWebSocketFactory(),
              dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
              frameTimeoutMs: DEFAULT_WS_FRAME_TIMEOUT_MS,
            });
      // Closes the unary-RPC auth-recovery loop: a mid-call 401 from
      // the Traycer cloud backend is surfaced by the host as
      // `HostRpcError { code: "UNAUTHORIZED" }`, and this wrapper drives
      // `AuthService.revalidateCurrentContext()` so the GUI either rotates
      // the existing context's credential lease in place (refresh
      // succeeded) or signs the user out (refresh rejected) instead of
      // leaving them staring at a generic failure toast.
      // Retry is the outermost layer: a pre-send transient dial/handshake
      // failure (`RetryableTransportError`) re-dials on a short backoff before
      // the auth-aware wrapper or the query layer ever see it. The auth wrapper
      // only acts on `UNAUTHORIZED`, never a retryable transport error, so the
      // two never contend.
      const messenger: IHostMessenger<Registry> = createRetryingMessenger(
        createAuthAwareMessenger(rawMessenger, auth, null),
        DEFAULT_TRANSPORT_RETRY_POLICY,
      );

      runtime = new HostRuntime<Registry>({
        runnerHost,
        registry,
        messenger,
        requestContextProvider: auth.getRequestContextProvider(),
        directory,
        invalidator,
      });

      const activeRuntime = runtime;
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
    ]);

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

function defaultRequestId(): string {
  return uuidv4();
}
