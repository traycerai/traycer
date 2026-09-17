import type {
  BrowserCdpCommand,
  BrowserCdpError,
  BrowserCdpResult,
  BrowserCdpTarget,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewDebugger,
  BrowserViewWebContents,
} from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";
import { dispatchCuratedCdp } from "@traycer/protocol/host/browser/cdp-dispatch";
import { BrowserFrameRoutes } from "./browser-frame-routes";
import { isRecord, recordValue } from "../guards";

interface BrowserDebugSessionOptions {
  readonly webContents: BrowserDebugWebContents;
  readonly onDetached: (reason: string) => void;
}

interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

/** One consumer's claim on the guest's attached debugger. */
export interface BrowserDebugLease {
  /** Attaches and enables the CDP domains; resolves once they are live. */
  ready(): Promise<void>;
  /** Idempotent. The last release detaches the debugger. */
  release(): void;
}

export class BrowserDebugSession {
  private readonly webContents: BrowserDebugWebContents;
  private readonly onDetached: (reason: string) => void;
  private readonly frameRoutes: BrowserFrameRoutes;
  private readonly bindingCalledListeners = new Set<
    (params: Record<string, unknown>) => void
  >();
  private readonly messageListener = (...args: unknown[]) => {
    this.handleDebuggerMessage(args);
  };
  private readonly detachListener = (...args: unknown[]) => {
    this.handleDebuggerDetach(args);
  };
  private enabled = false;
  private leases = 0;
  private enablePromise: Promise<void> | null = null;
  private attachedBySession = false;
  private listening = false;
  private disposed = false;
  private attachmentGeneration = 0;
  private attachmentEnd = Promise.withResolvers<void>();
  private readonly sessionEnd = Promise.withResolvers<void>();

  constructor(options: BrowserDebugSessionOptions) {
    this.webContents = options.webContents;
    this.onDetached = options.onDetached;
    this.frameRoutes = new BrowserFrameRoutes({
      browserDebugger: () => this.webContents.debugger,
      isAttached: () => this.isAttached(),
      isReady: () => this.isReady(),
      generation: () => this.attachmentGeneration,
      send: (method, params, sessionId) =>
        this.sendCommand(method, params, sessionId),
      raceWithSessionEnd: <T>(work: Promise<T>, message: string) =>
        this.raceWithDebugSessionEnd(work, message),
      attachmentEnded: () => this.attachmentEnd.promise,
    });
  }

  isAttached(): boolean {
    if (this.disposed) return false;
    const browserDebugger = this.liveDebugger();
    return browserDebugger !== null && browserDebugger.isAttached();
  }

  isReady(): boolean {
    return this.enabled && this.isAttached();
  }

  /** Internal desktop consumers share this attachment owner. */
  async sendCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    if (!this.isReady()) {
      throw new Error("Browser debugger is not ready.");
    }
    try {
      return await this.raceWithAttachmentEnd(
        this.webContents.debugger.sendCommand(method, params, sessionId),
        "Browser debugger detached during command",
      );
    } finally {
      this.stopListeningIfIdle();
    }
  }

  onBindingCalled(
    listener: (params: Record<string, unknown>) => void,
  ): () => void {
    if (this.disposed) return () => undefined;
    this.bindingCalledListeners.add(listener);
    if (this.isAttached()) this.startListening();
    return () => {
      this.bindingCalledListeners.delete(listener);
      this.stopListeningIfIdle();
    };
  }

  async dispatch(
    target: BrowserCdpTarget,
    command: BrowserCdpCommand,
  ): Promise<BrowserCdpResult> {
    if (!this.isReady()) {
      return cdpFailure(
        command,
        "not_attached",
        "Browser debugger is not ready.",
        null,
      );
    }
    try {
      const route = await this.frameRoutes.resolveTarget(target);
      this.frameRoutes.requireCurrentTargetRoute(route, false);
      const result = await dispatchCuratedCdp(
        (method, params) =>
          this.webContents.debugger.sendCommand(
            method,
            params,
            route.sessionId ?? undefined,
          ),
        command,
      );
      if (result.ok && result.kind === "cdpGetFrameTree") {
        this.frameRoutes.requireCurrentTargetRoute(route, true);
        this.frameRoutes.recordFrameTreeRoute(route, result.frames);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        isRecord(error) && typeof error.code === "number" ? error.code : null;
      return cdpFailure(
        command,
        this.isAttached() ? "cdp_error" : "not_attached",
        message,
        code,
      );
    }
  }

  async installScriptBeforeNavigation(source: string): Promise<string> {
    const result = await this.ensureAttached().sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      { source },
      undefined,
    );
    if (
      result === null ||
      typeof result !== "object" ||
      !("identifier" in result) ||
      typeof result.identifier !== "string"
    ) {
      throw new Error(
        "Browser seed script registration returned no identifier",
      );
    }
    return result.identifier;
  }

  removeScriptBeforeNavigation(identifier: string): Promise<unknown> {
    return this.sendCommand(
      "Page.removeScriptToEvaluateOnNewDocument",
      { identifier },
      undefined,
    );
  }

  /**
   * A consumer that needs CDP takes a lease. The first one attaches the
   * debugger and enables the domains; the last release detaches again, so a
   * tab nobody is driving stays a plain Chromium tab rather than one running
   * with `Runtime.enable` side effects for the page to read.
   */
  acquire(): BrowserDebugLease {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    this.leases += 1;
    let released = false;
    return {
      ready: () => this.enableWhileLeased(),
      release: () => {
        if (released) return;
        released = true;
        this.leases -= 1;
        this.detachIfUnleased();
      },
    };
  }

  /**
   * Brings the domains back up after a navigation or a renderer reload, for a
   * tab a lease holder is still driving. Recovery only: a tab nobody has
   * leased must not gain a debugger here.
   */
  enableWhileLeased(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Browser debug session is disposed"));
    }
    if (this.leases === 0) return Promise.resolve();
    if (this.isAttached()) {
      if (this.enabled) return Promise.resolve();
      if (this.enablePromise !== null) return this.enablePromise;
    }
    try {
      this.ensureAttached();
      this.startListening();
    } catch (err) {
      log.warn("[browser-view] debugger attach failed", {
        error: describeLogError(err),
      });
      return Promise.reject(err);
    }

    let enablePromise!: Promise<void>;
    const browserDebugger = this.webContents.debugger;
    enablePromise = this.raceWithDebugSessionEnd(
      Promise.all([
        browserDebugger.sendCommand("Page.enable", {}, undefined),
        browserDebugger.sendCommand("Runtime.enable", {}, undefined),
        browserDebugger.sendCommand("Network.enable", {}, undefined),
        // DOM.describeNode requires its domain to be enabled first.
        browserDebugger.sendCommand("DOM.enable", {}, undefined),
      ]).then(() => undefined),
      "Browser debugger detached while enabling",
    )
      .then(() => {
        if (
          this.disposed ||
          this.enablePromise !== enablePromise ||
          !browserDebugger.isAttached()
        ) {
          throw new Error("Browser debug session ended while enabling");
        }
        this.enabled = true;
      })
      .catch((err: unknown) => {
        if (this.enablePromise !== enablePromise) throw err;
        this.enablePromise = null;
        this.enabled = false;
        this.frameRoutes.clear();
        // Listeners off first, the order `detachIfUnleased` and `dispose` use:
        // the detach below is ours, and the detach listener exists to report
        // the ones we did not ask for.
        this.stopListening();
        if (this.attachedBySession && browserDebugger.isAttached()) {
          try {
            browserDebugger.detach();
          } catch (detachErr) {
            log.warn("[browser-view] debugger detach after enable failed", {
              error: describeLogError(detachErr),
            });
          }
        }
        this.attachedBySession = false;
        log.warn("[browser-view] debugger domain enable failed", {
          error: describeLogError(err),
        });
        throw err;
      });
    this.enablePromise = enablePromise;
    return enablePromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enablePromise = null;
    const browserDebugger = this.liveDebugger();
    this.stopListening();
    this.sessionEnd.resolve();
    this.frameRoutes.rejectPending("Browser debug session was disposed");
    this.frameRoutes.clear();
    if (
      this.attachedBySession ||
      browserDebugger === null ||
      !browserDebugger.isAttached()
    ) {
      this.attachmentEnd.resolve();
    }
    if (
      this.attachedBySession &&
      browserDebugger !== null &&
      browserDebugger.isAttached()
    ) {
      try {
        browserDebugger.detach();
      } catch (err) {
        log.warn("[browser-view] debugger detach failed", {
          error: describeLogError(err),
        });
      }
    }
    this.bindingCalledListeners.clear();
  }

  private handleDebuggerMessage(args: readonly unknown[]): void {
    const event = readCdpEvent(args);
    if (event === null) return;
    if (event.method === "Target.detachedFromTarget") {
      this.frameRoutes.handleTargetDetached(event.params);
      return;
    }
    if (event.method === "Page.frameAttached") {
      this.frameRoutes.handleFrameAttached(event.params, event.sessionId);
    } else if (event.method === "Page.frameNavigated") {
      this.frameRoutes.handleFrameNavigated(event.params, event.sessionId);
    } else if (event.method === "Page.frameDetached") {
      this.frameRoutes.handleFrameDetached(event.params, event.sessionId);
    }
    if (event.method === "Runtime.bindingCalled") {
      for (const listener of this.bindingCalledListeners) {
        listener(event.params);
      }
    }
  }

  private handleDebuggerDetach(args: readonly unknown[]): void {
    const reason = args
      .map((value) => (typeof value === "string" ? value : null))
      .find((value) => value !== null);
    this.stopListening();
    this.resetDetachedState();
    this.onDetached(reason ?? "Debugger detached");
  }

  private ensureAttached(): BrowserViewDebugger {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    const browserDebugger = this.webContents.debugger;
    if (!browserDebugger.isAttached()) {
      this.resetDetachedState();
      browserDebugger.attach("1.3");
      this.attachedBySession = true;
    }
    return browserDebugger;
  }

  private detachIfUnleased(): void {
    if (this.leases > 0 || this.disposed) return;
    const browserDebugger = this.liveDebugger();
    const attachedBySession = this.attachedBySession;
    // Listeners off first: this detach is deliberate, and the detach listener
    // exists to report the ones we did not ask for.
    this.stopListening();
    this.resetDetachedState();
    if (
      !attachedBySession ||
      browserDebugger === null ||
      !browserDebugger.isAttached()
    ) {
      return;
    }
    try {
      browserDebugger.detach();
    } catch (err) {
      log.warn("[browser-view] debugger detach failed", {
        error: describeLogError(err),
      });
    }
  }

  private resetDetachedState(): void {
    this.frameRoutes.rejectPending("Browser debugger detached while enabling");
    this.attachmentEnd.resolve();
    this.attachmentEnd = Promise.withResolvers<void>();
    this.enabled = false;
    this.enablePromise = null;
    this.attachedBySession = false;
    this.attachmentGeneration += 1;
    this.frameRoutes.resetForNewAttachment();
  }

  private raceWithDebugSessionEnd<T>(
    work: Promise<T>,
    message: string,
  ): Promise<T> {
    return Promise.race([
      this.raceWithAttachmentEnd(work, message),
      this.sessionEnd.promise.then(() => {
        throw new Error(message);
      }),
    ]);
  }

  private raceWithAttachmentEnd<T>(
    work: Promise<T>,
    message: string,
  ): Promise<T> {
    return Promise.race([
      work,
      this.attachmentEnd.promise.then(() => {
        throw new Error(message);
      }),
    ]);
  }

  private startListening(): void {
    if (this.listening) return;
    const browserDebugger = this.webContents.debugger;
    browserDebugger.on("message", this.messageListener);
    browserDebugger.on("detach", this.detachListener);
    this.listening = true;
  }

  private stopListeningIfIdle(): void {
    if (
      this.enabled ||
      this.enablePromise !== null ||
      this.bindingCalledListeners.size > 0
    ) {
      return;
    }
    this.stopListening();
  }

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    // A destroyed WebContents took its debugger, and our listeners on it,
    // down with it; there is nothing left to unsubscribe from.
    const browserDebugger = this.liveDebugger();
    if (browserDebugger === null) return;
    browserDebugger.off("message", this.messageListener);
    browserDebugger.off("detach", this.detachListener);
  }

  /**
   * Electron's `webContents.debugger` is a native getter that THROWS "Object
   * has been destroyed" once the WebContents is gone - it does not hand back
   * an inert debugger. Every path that can run AFTER the guest died (dispose
   * from the `destroyed` handler, the detach event that death emits, a lease
   * released late) reads the debugger through here so teardown unwinds
   * instead of throwing out of a lifecycle handler. Paths that need a live
   * debugger to do their work (`ensureAttached`, `startListening`) keep the
   * direct read: a throw there is a failed operation, reported to its caller.
   */
  private liveDebugger(): BrowserViewDebugger | null {
    if (this.webContents.isDestroyed()) return null;
    return this.webContents.debugger;
  }
}

type BrowserDebugWebContents = Pick<
  BrowserViewWebContents,
  "id" | "debugger" | "isDestroyed"
>;

function cdpFailure(
  command: BrowserCdpCommand,
  kind: BrowserCdpError["kind"],
  message: string,
  code: number | null,
): BrowserCdpResult {
  return { kind: command.kind, ok: false, error: { kind, message, code } };
}

function readCdpEvent(args: readonly unknown[]): CdpEvent | null {
  const method = args[1];
  if (typeof method !== "string") return null;
  const params = recordValue(args[2]) ?? {};
  const sessionId = typeof args[3] === "string" ? args[3] : undefined;
  return { method, params, sessionId };
}
