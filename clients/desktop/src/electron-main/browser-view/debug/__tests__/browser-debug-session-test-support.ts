import { EventEmitter } from "node:events";
import { BrowserDebugSession } from "../browser-debug-session";
import type { PipCaptureIpcPayload } from "../../../../ipc-contracts/pip-capture-types";
import type {
  BrowserViewCapturedImage,
  BrowserViewDebugger,
  BrowserViewFrameImage,
  BrowserViewWebContents,
  BrowserViewWindowOpenDetails,
  BrowserViewWindowOpenResult,
} from "../../browser-view-port";

type BrowserViewFindInPageOptions = Parameters<
  BrowserViewWebContents["findInPage"]
>[1];
type BrowserViewDevToolsWebContents = Parameters<
  BrowserViewWebContents["setDevToolsWebContents"]
>[0];
type BrowserViewOpenDevToolsOptions = Parameters<
  BrowserViewWebContents["openDevTools"]
>[0];

export interface RecordedCommand {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | undefined;
}

export function commandKey(
  method: string,
  sessionId: string | undefined,
): string {
  return `${method}:${sessionId ?? "root"}`;
}

export class FakeDebugger implements BrowserViewDebugger {
  attached = false;
  readonly commands: RecordedCommand[] = [];
  readonly responses = new Map<string, unknown>();
  readonly failures = new Map<string, Error>();
  detachBeforeFailure = false;
  onSendCommand: ((command: RecordedCommand) => void) | null = null;
  private readonly events = new EventEmitter();
  private readonly deferredResponses = new Map<
    string,
    {
      consumed: boolean;
      readonly resolve: (response: unknown) => void;
      readonly promise: Promise<unknown>;
    }
  >();

  isAttached(): boolean {
    return this.attached;
  }

  attach(_protocolVersion: string): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  deferResponse(method: string, sessionId: string | undefined): void {
    let resolve!: (response: unknown) => void;
    const promise = new Promise<unknown>((resolveResponse) => {
      resolve = resolveResponse;
    });
    this.deferredResponses.set(commandKey(method, sessionId), {
      consumed: false,
      promise,
      resolve,
    });
  }

  resolveResponse(
    method: string,
    sessionId: string | undefined,
    response: unknown,
  ): void {
    const key = commandKey(method, sessionId);
    const deferred = this.deferredResponses.get(key);
    if (deferred === undefined) {
      throw new Error(`No response pending for ${key}`);
    }
    this.deferredResponses.delete(key);
    deferred.resolve(response);
  }

  sendCommand(
    method: string,
    commandParams: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<unknown> {
    const command = { method, params: commandParams, sessionId };
    this.commands.push(command);
    this.onSendCommand?.(command);
    const key = commandKey(method, sessionId);
    const failure = this.failures.get(key) ?? this.failures.get(method);
    if (failure !== undefined) {
      if (this.detachBeforeFailure) this.attached = false;
      return Promise.reject(failure);
    }
    const deferred = this.deferredResponses.get(key);
    if (deferred !== undefined && !deferred.consumed) {
      deferred.consumed = true;
      return deferred.promise;
    }
    return Promise.resolve(
      this.responses.get(key) ?? this.responses.get(method) ?? {},
    );
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.events.off(event, listener);
  }

  emitMessage(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ): void {
    this.events.emit("message", {}, method, params, sessionId);
  }

  emitDetach(reason: string): void {
    this.attached = false;
    this.events.emit("detach", {}, reason);
  }
}

class FakeCapturedImage implements BrowserViewCapturedImage {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly qualities: number[],
  ) {}

  getSize(): { readonly width: number; readonly height: number } {
    return { width: 800, height: 600 };
  }

  toJPEG(quality: number): Uint8Array {
    this.qualities.push(quality);
    return this.bytes;
  }

  toDataURL(): string {
    return "";
  }

  isEmpty(): boolean {
    return this.bytes.byteLength === 0;
  }

  crop(_rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): BrowserViewCapturedImage {
    return this;
  }

  toPNG(): Uint8Array {
    return this.bytes;
  }
}

export class FakeWebContents
  extends EventEmitter
  implements BrowserViewWebContents
{
  readonly id = 1;
  readonly debugger = new FakeDebugger();
  readonly session = {
    cookies: {
      get: () => Promise.resolve([]),
      set: () => Promise.resolve(),
      flushStore: () => Promise.resolve(),
    },
  };
  readonly navigationHistory = undefined;
  readonly qualities: number[] = [];
  captureCount = 0;
  deferCaptures = false;
  private bytes: Uint8Array = Uint8Array.from([1, 2, 3]);
  private readonly captureResolvers: Array<
    (image: BrowserViewCapturedImage) => void
  > = [];

  beginFrameSubscription(
    _callback: (image: BrowserViewFrameImage) => void,
  ): void {}

  endFrameSubscription(): void {}

  setCaptureBytes(bytes: Uint8Array): void {
    this.bytes = bytes;
  }

  resolveNextCapture(bytes: Uint8Array): void {
    const resolve = this.captureResolvers.shift();
    if (resolve === undefined) throw new Error("No capture is pending");
    resolve(new FakeCapturedImage(bytes, this.qualities));
  }

  loadURL(_url: string): Promise<unknown> {
    return Promise.resolve();
  }

  executeJavaScript(_script: string, _userGesture: boolean): Promise<unknown> {
    return Promise.resolve();
  }

  capturePage(): Promise<BrowserViewCapturedImage> {
    this.captureCount += 1;
    if (this.deferCaptures) {
      return new Promise((resolve) => {
        this.captureResolvers.push(resolve);
      });
    }
    return Promise.resolve(new FakeCapturedImage(this.bytes, this.qualities));
  }

  getURL(): string {
    return "";
  }

  getTitle(): string {
    return "";
  }

  isDestroyed(): boolean {
    return false;
  }

  close(): void {}

  reload(): void {}

  findInPage(_text: string, _options: BrowserViewFindInPageOptions): number {
    return 0;
  }

  stopFindInPage(_action: "clearSelection"): void {}

  getZoomFactor(): number {
    return 1;
  }

  setZoomFactor(_factor: number): void {}

  setBackgroundThrottling(_allowed: boolean): void {}

  setDevToolsWebContents(_webContents: BrowserViewDevToolsWebContents): void {}

  openDevTools(_options: BrowserViewOpenDevToolsOptions): void {}

  setWindowOpenHandler(
    _handler: (
      details: BrowserViewWindowOpenDetails,
    ) => BrowserViewWindowOpenResult,
  ): void {}
}

export interface BrowserDebugSessionHarness {
  readonly session: BrowserDebugSession;
  readonly webContents: FakeWebContents;
  readonly frames: PipCaptureIpcPayload[];
}

export function createHarness(): BrowserDebugSessionHarness {
  const webContents = new FakeWebContents();
  const frames: PipCaptureIpcPayload[] = [];
  const session = new BrowserDebugSession({
    webContents,
    onDetached: () => undefined,
  });
  return { session, webContents, frames };
}
