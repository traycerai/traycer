import type { Disposable } from "../platform/uri-callback";
import type { IRunnerHost } from "../platform/runner-host";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type {
  AuthEra,
  RequestContextProvider,
} from "../auth/request-context-provider";
import type { IHostMessenger } from "../host-transport/host-messenger";
import { HostClient, type IHostQueryInvalidator } from "./host-client";
import type { HostDirectoryEntry } from "./host-directory";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistry,
  type HostConnectionRegistrySource,
} from "./host-connection-registry";
import { HostBindingAuthorityRegistry } from "./host-binding-authority-registry";
import { HostRequestCoordinator } from "./host-request-coordinator";
import type { RpcSchedulingPolicy } from "./rpc-scheduling-policy";

/**
 * Minimal host-directory surface the shared runtime depends on.
 * Shared code only needs the read/observe subset below.
 */
export interface IHostDirectoryService {
  list(): Promise<readonly HostDirectoryEntry[]>;
  findById(hostId: string): HostDirectoryEntry | null;
  refresh(): Promise<readonly HostDirectoryEntry[]>;
  /** Refresh on behalf of an explicitly named {@link AuthEra}. */
  refreshForEra(era: AuthEra): Promise<readonly HostDirectoryEntry[]>;
  /** Drop any in-flight refresh - used when the credential rotates. */
  invalidateInFlightRefresh(): void;
}

export interface HostRuntimeOptions<Registry extends VersionedRpcRegistry> {
  readonly runnerHost: IRunnerHost;
  readonly registry: Registry;
  readonly messenger: IHostMessenger<Registry>;
  /** Client `RequestContextProvider` boundary. */
  readonly requestContextProvider: RequestContextProvider;
  readonly directory: IHostDirectoryService;
  readonly invalidator: IHostQueryInvalidator;
  readonly schedulingPolicy: RpcSchedulingPolicy<Registry>;
  /**
   * The window's connection-registry wiring (connection-registry §1), or `null` for a shell that runs without one (the standalone/test path).
   * Required rather than optional on purpose.
   */
  readonly connectionRegistry: HostConnectionRegistrySource | null;
  /**
   * Provider-owned binding registry. `null` keeps the standalone-runtime
   * convenience path for tests and non-React shells.
   */
  readonly authorityRegistry?: HostBindingAuthorityRegistry | null;
  /** Provider-owned in GUI; standalone runtimes may create one. */
  readonly requestCoordinator: HostRequestCoordinator<Registry> | null;
}

export class HostRuntime<Registry extends VersionedRpcRegistry> {
  readonly hostClient: HostClient<Registry>;
  readonly requestContextProvider: RequestContextProvider;
  readonly directory: IHostDirectoryService;

  private readonly runnerHost: IRunnerHost;
  private readonly connectionRegistry: HostConnectionRegistrySource | null;
  readonly authorityRegistry: HostBindingAuthorityRegistry;
  readonly requestCoordinator: HostRequestCoordinator<Registry>;
  private readonly ownsAuthorityRegistry: boolean;
  private readonly ownsRequestCoordinator: boolean;
  private started = false;
  private disposed = false;
  private readonly disposables: Disposable[] = [];
  private contextUnsubscribe: (() => void) | null = null;
  private bearerRotationUnsubscribe: (() => void) | null = null;

  constructor(options: HostRuntimeOptions<Registry>) {
    this.runnerHost = options.runnerHost;
    this.requestContextProvider = options.requestContextProvider;
    this.directory = options.directory;
    this.connectionRegistry = options.connectionRegistry;
    this.ownsAuthorityRegistry =
      options.authorityRegistry === null ||
      options.authorityRegistry === undefined;
    this.authorityRegistry =
      options.authorityRegistry ?? new HostBindingAuthorityRegistry();
    this.ownsRequestCoordinator = options.requestCoordinator === null;
    this.requestCoordinator =
      options.requestCoordinator ??
      new HostRequestCoordinator({
        registry: options.registry,
        schedulingPolicy: options.schedulingPolicy,
      });
    this.hostClient = new HostClient<Registry>({
      registry: options.registry,
      messenger: options.messenger,
      invalidator: options.invalidator,
      authorityRegistry: this.authorityRegistry,
      schedulingPolicy: options.schedulingPolicy,
      requestCoordinator: this.requestCoordinator,
      findHostById: (hostId) => options.directory.findById(hostId),
    });
  }

  /** Wires context / directory / local-host signals into `hostClient`. */
  start(): void {
    if (this.disposed) {
      throw new Error("HostRuntime cannot be started after dispose().");
    }
    if (this.started) {
      return;
    }
    this.started = true;

    // Before anything else reads it, so a consumer that subscribes during the opening commit sees the registry already answering off the live directory rather than the empty answers an uninstalled source gives.
    // This used to be sequenced "before the first bind"; there is no bind, and the registry is now the only thing that tells a pinned consumer its row arrived, which makes the ordering more load-bearing than it was, not less.
    if (this.connectionRegistry !== null) {
      installHostConnectionRegistrySource(this.connectionRegistry);
    }

    this.hostClient.setRequestContext(this.requestContextProvider.current());

    this.contextUnsubscribe = this.requestContextProvider.onChange(
      (ctx, era) => {
        this.hostClient.setRequestContext(ctx);
        // The era comes from the emission and is passed through untouched - not rebuilt here out of `ctx` plus a generation read, and not left for the directory to read off its own accessors.
        // On sign-out the era's identity is `null`, which is exactly right: `null` IS the incoming identity, and stamping it is what lets the signed-out clear commit instead of being discarded as stale.
        void this.directory.refreshForEra(era);
      },
    );

    // Same-user token refresh rotates the lease in place (silent on `onChange`); forward it so stream transports can push the fresh credential onto open connections without a reconnect.
    this.bearerRotationUnsubscribe =
      this.requestContextProvider.onBearerRotated(() => {
        // A rotation is invisible to a user-id fence - same account, new credential - so the in-flight refresh is dropped here rather than joined.
        this.directory.invalidateInFlightRefresh();
        this.hostClient.notifyBearerRotated();
      });

    this.disposables.push(
      this.runnerHost.onLocalHostChange(() => {
        void this.directory.refresh();
      }),
    );
  }

  /** Releases every subscription `start()` installed. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.connectionRegistry !== null) {
      resetHostConnectionRegistry();
    }

    if (this.contextUnsubscribe !== null) {
      this.contextUnsubscribe();
      this.contextUnsubscribe = null;
    }
    if (this.bearerRotationUnsubscribe !== null) {
      this.bearerRotationUnsubscribe();
      this.bearerRotationUnsubscribe = null;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    if (this.ownsAuthorityRegistry) {
      this.authorityRegistry.dispose();
    }
    if (this.ownsRequestCoordinator) {
      this.requestCoordinator.dispose();
    }
  }
}
