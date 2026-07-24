import type { Disposable } from "../platform/uri-callback";
import type { IRunnerHost } from "../platform/runner-host";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";
import type { RequestContextProvider } from "../auth/request-context-provider";
import type { IHostMessenger } from "../host-transport/host-messenger";
import { HostClient, type IHostQueryInvalidator } from "./host-client";
import type { HostDirectoryEntry } from "./host-directory";
import { HostBindingAuthorityRegistry } from "./host-binding-authority-registry";
import { HostRequestCoordinator } from "./host-request-coordinator";
import type { RpcSchedulingPolicy } from "./rpc-scheduling-policy";

/**
 * Minimal host-directory surface the shared runtime depends on.
 *
 * The concrete `HostDirectoryService` lives in `gui-app`; it composes the
 * runner-host's local-host snapshot with the stubbed remote fetcher (see
 * `remote-fetcher.ts`) and owns selection state. Shared code only needs the
 * read/observe subset below.
 */
export interface IHostDirectoryService {
  list(): Promise<readonly HostDirectoryEntry[]>;
  findById(hostId: string): HostDirectoryEntry | null;
  refresh(): Promise<readonly HostDirectoryEntry[]>;
  getSelected(): HostDirectoryEntry | null;
  selectById(hostId: string | null): void;
  onSelectionChange(
    handler: (entry: HostDirectoryEntry | null) => void,
  ): Disposable;
}

export interface HostRuntimeOptions<Registry extends VersionedRpcRegistry> {
  readonly runnerHost: IRunnerHost;
  readonly registry: Registry;
  readonly messenger: IHostMessenger<Registry>;
  /**
   * Client `RequestContextProvider` boundary. The runtime threads
   * `provider.current()` into `HostClient` on `start()` and rebinds on
   * every `provider.onChange(...)` emission (sign-in, sign-out, cross-user
   * transition). Same-user credential rotation does NOT emit through the
   * provider - the lease is mutated in place - so the host-scoped cache
   * survives token refreshes intact.
   */
  readonly requestContextProvider: RequestContextProvider;
  readonly directory: IHostDirectoryService;
  readonly invalidator: IHostQueryInvalidator;
  readonly schedulingPolicy: RpcSchedulingPolicy<Registry>;
  /**
   * Provider-owned binding registry. `null` keeps the standalone-runtime
   * convenience path for tests and non-React shells.
   */
  readonly authorityRegistry?: HostBindingAuthorityRegistry | null;
  /** Provider-owned in GUI; standalone runtimes may create one. */
  readonly requestCoordinator: HostRequestCoordinator<Registry> | null;
}

/**
 * Shared orchestrator consumed by desktop, mobile, and browser-preview shells.
 *
 * `HostRuntime`:
 * 1. Builds a `HostClient<Registry>` around the messenger the shell built
 *    (shells pick their transport: `WsRpcClient` on desktop/mobile,
 *    `MockHostMessenger` under dev/preview).
 * 2. On `start()`, applies the current `RequestContext` and current host
 *    selection, then subscribes to context, selection, and local-host
 *    transitions. Each signal maps to a `HostClient` call so the
 *    TanStack query cache invalidates coherently on every identity change.
 * 3. Releases all subscriptions on `dispose()`.
 *
 * The runtime does not own transport construction: it receives the messenger
 * from its caller. That keeps the shared module free of `globalThis.fetch`
 * coupling and lets tests drive the full lifecycle with an in-memory
 * `MockHostMessenger`.
 */
export class HostRuntime<Registry extends VersionedRpcRegistry> {
  readonly hostClient: HostClient<Registry>;
  readonly requestContextProvider: RequestContextProvider;
  readonly directory: IHostDirectoryService;

  private readonly runnerHost: IRunnerHost;
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

  /**
   * Wires context / directory / local-host signals into `hostClient`.
   *
   * Safe to call multiple times: subsequent calls are no-ops. Callers that
   * need to rewire must `dispose()` and build a fresh runtime.
   */
  start(): void {
    if (this.disposed) {
      throw new Error("HostRuntime cannot be started after dispose().");
    }
    if (this.started) {
      return;
    }
    this.started = true;

    this.hostClient.setRequestContext(this.requestContextProvider.current());
    this.hostClient.bind(this.directory.getSelected());

    this.contextUnsubscribe = this.requestContextProvider.onChange((ctx) => {
      this.hostClient.setRequestContext(ctx);
    });

    // Same-user token refresh rotates the lease in place (silent on `onChange`);
    // forward it so stream transports can push the fresh credential onto open
    // connections without a reconnect.
    this.bearerRotationUnsubscribe =
      this.requestContextProvider.onBearerRotated(() => {
        this.hostClient.notifyBearerRotated();
      });

    this.disposables.push(
      this.directory.onSelectionChange((entry) => {
        this.hostClient.bind(entry);
      }),
    );

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
