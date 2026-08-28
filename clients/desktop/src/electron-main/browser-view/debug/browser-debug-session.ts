import type {
  BrowserCdpCommand,
  BrowserCdpError,
  BrowserCdpResult,
  BrowserCdpTarget,
} from "@traycer/protocol/host/browser/contracts";
import type { BrowserViewDebugSnapshotData } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserViewDebugger,
  BrowserViewWebContents,
} from "../browser-view-port";
import { describeLogError, log } from "../../app/logger";
import { dispatchCuratedCdp } from "@traycer/protocol/host/browser/cdp-dispatch";
import { BrowserDebugTelemetry } from "./browser-debug-telemetry";
import { BrowserFrameRoutes } from "./browser-frame-routes";
import { BrowserPipCapture } from "./browser-pip-capture";
import type { BrowserPipCaptureStartInput } from "./browser-pip-capture";
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

export class BrowserDebugSession {
  private readonly webContents: BrowserDebugWebContents;
  private readonly onDetached: (reason: string) => void;
  private readonly telemetry: BrowserDebugTelemetry;
  private readonly frameRoutes: BrowserFrameRoutes;
  private readonly pipCapture: BrowserPipCapture;
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
    this.telemetry = new BrowserDebugTelemetry(options.webContents.id);
    this.pipCapture = new BrowserPipCapture(options.webContents);
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
    return !this.disposed && this.webContents.debugger.isAttached();
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

  enableAfterCommit(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Browser debug session is disposed"));
    }
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
        browserDebugger.sendCommand("Log.enable", {}, undefined),
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
        this.stopListeningIfIdle();
        log.warn("[browser-view] debugger domain enable failed", {
          error: describeLogError(err),
        });
        throw err;
      });
    this.enablePromise = enablePromise;
    return enablePromise;
  }

  startPipCapture(input: BrowserPipCaptureStartInput): Promise<void> {
    if (this.disposed) throw new Error("Browser debug session is disposed");
    this.pipCapture.start(input);
    return Promise.resolve();
  }

  stopPipCapture(): void {
    this.pipCapture.stop();
  }

  isPipCapturing(): boolean {
    return this.pipCapture.isCapturing();
  }

  snapshot(): BrowserViewDebugSnapshotData {
    return this.telemetry.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enablePromise = null;
    this.pipCapture.stall();
    const browserDebugger = this.webContents.debugger;
    this.stopListening();
    this.sessionEnd.resolve();
    this.frameRoutes.rejectPending("Browser debug session was disposed");
    this.frameRoutes.clear();
    if (this.attachedBySession || !browserDebugger.isAttached()) {
      this.attachmentEnd.resolve();
    }
    if (this.attachedBySession && browserDebugger.isAttached()) {
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
    if (
      this.telemetry.handleEvent(event.method, event.params, event.sessionId)
    ) {
      return;
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
    const browserDebugger = this.webContents.debugger;
    browserDebugger.off("message", this.messageListener);
    browserDebugger.off("detach", this.detachListener);
    this.listening = false;
  }
}

type BrowserDebugWebContents = Pick<
  BrowserViewWebContents,
  "id" | "debugger" | "capturePage"
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
