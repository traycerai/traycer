import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type {
  SandboxArtifactBridge,
  SandboxArtifactRequest,
} from "@traycer-clients/shared/platform/sandbox-artifacts";
import { newMountId } from "./artifact-address";
import type { ArtifactServer, ArtifactServeResult } from "./artifact-server";

interface MountedServer {
  readonly server: ArtifactServer;
  readonly requests: Map<string, AbortController>;
}

export interface ArtifactMount {
  readonly mountId: string;
  /** Navigation must wait until the shell knows which renderer owns the mount. */
  readonly ready: Promise<void>;
  dispose(): void;
}

class MountDispatcher {
  private readonly mounts = new Map<string, MountedServer>();
  private readonly requests = new Map<string, AbortController>();
  private subscription: Disposable | null = null;

  constructor(private readonly bridge: SandboxArtifactBridge) {}

  mount(server: ArtifactServer): ArtifactMount {
    const mountId = newMountId();
    const entry: MountedServer = { server, requests: new Map() };
    this.mounts.set(mountId, entry);
    if (this.subscription === null) {
      const requests = this.bridge.onRequest((request) => {
        void this.dispatch(request);
      });
      const cancellations = this.bridge.onCancel(({ requestId }) => {
        this.requests.get(requestId)?.abort();
      });
      this.subscription = {
        dispose: () => {
          requests.dispose();
          cancellations.dispose();
        },
      };
    }
    const ready = this.bridge.register(mountId);
    let disposed = false;
    return {
      mountId,
      ready,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.mounts.delete(mountId);
        // An idle dispatcher must not race a replacement renderer's response
        // with a 404 for a mount it no longer owns.
        if (this.mounts.size === 0) {
          this.subscription?.dispose();
          this.subscription = null;
        }
        for (const [requestId, controller] of entry.requests) {
          controller.abort();
          this.requests.delete(requestId);
        }
        entry.requests.clear();
        // Even an unmount during registration must remove the native lease.
        void ready
          .then(
            () => this.bridge.unregister(mountId),
            () => this.bridge.unregister(mountId),
          )
          .catch(() => {
            /* The shell may already have closed. */
          });
      },
    };
  }

  private async dispatch(request: SandboxArtifactRequest): Promise<void> {
    const entry = this.mounts.get(request.mountId);
    const controller = new AbortController();
    this.requests.set(request.requestId, controller);
    entry?.requests.set(request.requestId, controller);
    let result: ArtifactServeResult;
    try {
      result =
        entry === undefined
          ? {
              kind: "unavailable",
              reason: "unmounted",
              status: 404,
            }
          : await entry.server.serve({
              path: request.path,
              offset: request.offset,
              length: request.length,
              signal: controller.signal,
            });
    } catch {
      result = { kind: "unavailable", reason: "read-failed", status: 503 };
    } finally {
      // Once a read completes, cancellation must not abort its signal after
      // the reply has already been handed to the shell.
      this.requests.delete(request.requestId);
      entry?.requests.delete(request.requestId);
    }
    if (controller.signal.aborted) return;
    await this.bridge
      .respond({ requestId: request.requestId, ...result })
      .catch(() => {
        /* A closed shell no longer has a waiting request. */
      });
  }
}

const dispatchers = new WeakMap<SandboxArtifactBridge, MountDispatcher>();

export function mountArtifact(
  runnerHost: IRunnerHost,
  server: ArtifactServer,
): ArtifactMount {
  const bridge = runnerHost.sandboxArtifacts;
  if (bridge === null) throw new Error("Artifact serving is unavailable");
  let dispatcher = dispatchers.get(bridge);
  if (dispatcher === undefined) {
    dispatcher = new MountDispatcher(bridge);
    dispatchers.set(bridge, dispatcher);
  }
  return dispatcher.mount(server);
}
