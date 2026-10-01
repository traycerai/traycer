import { browserDesktopControlServerFrameSchema } from "@traycer/protocol/host/browser/desktop-control";
import type { IStreamSession } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { BrowserSessionsRegistryDeps } from "./browser-sessions-owner";
import type { BrowserSessionsHostTransport } from "./browser-sessions-transport";

type PreparedBrowserScope = {
  readonly windowId: string;
  readonly release: () => void;
};

export type BrowserDesktopControlDeps = Pick<
  BrowserSessionsRegistryDeps,
  | "directory"
  | "openTransport"
  | "userId"
  | "localHostId"
  | "subscribeLocalHostChange"
  | "subscribeBearerRotation"
> & {
  readonly prepare: (
    epicId: string,
    onUnavailable: () => void,
  ) => PreparedBrowserScope | null;
};

/** One local subscription; task streams and native births stay in the sessions registry. */
export class BrowserDesktopControl {
  private transport: BrowserSessionsHostTransport | null = null;
  private session: IStreamSession | null = null;
  private generation = 0;
  private hostId: string | null = null;
  private userId: string | null = null;
  private terminal = false;
  private disposed = false;
  private readonly holds = new Map<string, () => void>();
  private readonly unsubscribeHost: () => void;
  private readonly unsubscribeAuth: () => void;

  constructor(private readonly deps: BrowserDesktopControlDeps) {
    this.unsubscribeHost = deps.subscribeLocalHostChange(() => {
      this.refresh();
      this.transport?.wsStreamClient.reconnectAll("local-host-changed", {
        probeFirst: false,
        wakeProbe: null,
      });
    });
    this.unsubscribeAuth = deps.subscribeBearerRotation(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    if (this.disposed) return;
    const hostId = this.deps.localHostId();
    const userId = this.deps.userId();
    if (hostId === this.hostId && userId === this.userId && !this.terminal) {
      this.transport?.wsStreamClient.notifyBearerRotated();
      return;
    }
    this.teardown();
    this.hostId = hostId;
    this.userId = userId;
    this.terminal = false;
    if (hostId === null || userId === null) return;
    const generation = this.generation;
    void this.open(hostId, userId, generation);
  }

  private async open(
    hostId: string,
    userId: string,
    generation: number,
  ): Promise<void> {
    try {
      const target = await this.deps.directory.resolve(hostId);
      if (this.disposed || generation !== this.generation) return;
      // This control path never follows a directory entry onto another machine.
      if (target?.kind !== "local") {
        this.terminal = true;
        return;
      }
      const transport = this.deps.openTransport(target, userId);
      if (transport === null) {
        this.terminal = true;
        return;
      }
      this.transport = transport;
      if (
        transport.wsStreamClient.getMethodSupport(
          "host.browserPreparation.subscribe",
        ) === "unsupported"
      ) {
        this.terminal = true;
        return;
      }
      const session = transport.wsStreamClient.subscribe(
        "host.browserPreparation.subscribe",
        {},
      );
      this.session = session;
      session.onStatusChange((status) => {
        if (generation !== this.generation) return;
        if (status !== "open") this.releaseAll();
        if (status === "closed") this.terminal = true;
      });
      session.onServerFrame((envelope, binaryPayload) => {
        if (generation !== this.generation || binaryPayload !== null) return;
        const parsed =
          browserDesktopControlServerFrameSchema.safeParse(envelope);
        if (!parsed.success || parsed.data.kind === "pong") return;
        const frame = parsed.data;
        if (frame.kind === "release") {
          const release = this.holds.get(frame.requestId);
          this.holds.delete(frame.requestId);
          release?.();
          return;
        }
        if (this.holds.has(frame.requestId)) return;
        let unavailable = false;
        const onUnavailable = (): void => {
          unavailable = true;
          const release = this.holds.get(frame.requestId);
          this.holds.delete(frame.requestId);
          release?.();
          if (generation === this.generation)
            session.sendClientFrame(
              {
                kind: "refused",
                hasBinaryPayload: false,
                requestId: frame.requestId,
              },
              null,
            );
        };
        let prepared: PreparedBrowserScope | null;
        try {
          prepared = this.deps.prepare(frame.epicId, onUnavailable);
        } catch {
          onUnavailable();
          return;
        }
        if (prepared === null || unavailable) {
          prepared?.release();
          if (!unavailable) onUnavailable();
          return;
        }
        this.holds.set(frame.requestId, prepared.release);
        session.sendClientFrame(
          {
            kind: "prepared",
            hasBinaryPayload: false,
            requestId: frame.requestId,
            windowId: prepared.windowId,
          },
          null,
        );
      });
    } catch {
      if (generation !== this.generation) return;
      this.teardown();
      this.terminal = true;
    }
  }

  private releaseAll(): void {
    const releases = [...this.holds.values()];
    this.holds.clear();
    for (const release of releases) release();
  }

  private teardown(): void {
    this.generation += 1;
    this.releaseAll();
    this.session?.close();
    this.session = null;
    this.transport?.close();
    this.transport = null;
  }

  notifySystemResumed(): void {
    this.refresh();
    this.transport?.wsStreamClient.reconnectAll("system-resume", {
      probeFirst: true,
      wakeProbe: null,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeHost();
    this.unsubscribeAuth();
    this.teardown();
  }
}
