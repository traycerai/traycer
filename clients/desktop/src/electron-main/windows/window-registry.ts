import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import type { WindowSummary } from "../../ipc-contracts/window-types";
import { MruTracker } from "./mru-tracker";

export interface CreateWindowRequest {
  readonly windowId: string;
  readonly initialRoute: string | null;
}

export interface WindowRegistryCreateOptions {
  readonly initialRoute: string | null;
  readonly beforeLoad: ((windowId: string) => void) | null;
}

export interface WindowRegistryCreateWithIdOptions extends WindowRegistryCreateOptions {
  readonly windowId: string;
}

export interface RegistryManagedWindow {
  readonly webContents: {
    readonly id: number;
  };
  close(): void;
  destroy(): void;
  focus(): void;
  getTitle(): string;
  isMaximized(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  show(): void;
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
}

export interface WindowRegistryOptions<
  TWindow extends RegistryManagedWindow = BrowserWindow,
> {
  createWindow(request: CreateWindowRequest): TWindow;
  loadWindow(window: TWindow): Promise<void>;
}

export interface WindowRegistryRecord<
  TWindow extends RegistryManagedWindow = BrowserWindow,
> {
  readonly windowId: string;
  readonly webContentsId: number;
  readonly window: TWindow;
}

type WindowRegistryListener = () => void;

export class WindowRegistry<
  TWindow extends RegistryManagedWindow = BrowserWindow,
> {
  private readonly events = new EventEmitter();
  private readonly createWindowFn: (request: CreateWindowRequest) => TWindow;
  private readonly loadWindowFn: (window: TWindow) => Promise<void>;
  private readonly mru = new MruTracker();
  private readonly recordsByWindowId = new Map<
    string,
    WindowRegistryRecord<TWindow>
  >();
  private readonly windowIdByWebContentsId = new Map<number, string>();
  private readonly disposersByWindowId = new Map<string, () => void>();

  constructor(options: WindowRegistryOptions<TWindow>) {
    this.createWindowFn = options.createWindow;
    this.loadWindowFn = options.loadWindow;
  }

  async create(options: WindowRegistryCreateOptions): Promise<string> {
    const windowId = randomUUID();
    this.createWithId({
      windowId,
      initialRoute: options.initialRoute,
      beforeLoad: options.beforeLoad,
    });
    await this.loadById(windowId);
    return windowId;
  }

  createWithId(options: WindowRegistryCreateWithIdOptions): string {
    if (this.recordsByWindowId.has(options.windowId)) {
      throw new Error(`windowId is already registered: ${options.windowId}`);
    }
    const window = this.createWindowFn({
      windowId: options.windowId,
      initialRoute: options.initialRoute,
    });
    this.register(options.windowId, window);
    options.beforeLoad?.(options.windowId);
    return options.windowId;
  }

  async loadById(windowId: string): Promise<void> {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined) {
      throw new Error(`windowId is not registered: ${windowId}`);
    }
    await this.loadWindowFn(record.window);
  }

  register(windowId: string, window: TWindow): void {
    if (this.recordsByWindowId.has(windowId)) {
      throw new Error(`windowId is already registered: ${windowId}`);
    }
    if (this.windowIdByWebContentsId.has(window.webContents.id)) {
      throw new Error(
        `webContents id is already registered: ${window.webContents.id}`,
      );
    }
    const record = {
      windowId,
      webContentsId: window.webContents.id,
      window,
    };
    this.recordsByWindowId.set(windowId, record);
    this.windowIdByWebContentsId.set(record.webContentsId, windowId);
    this.mru.touch(windowId);

    const onClosed = (): void => {
      this.unregister(record);
    };
    const onFocus = (): void => {
      this.mru.touch(windowId);
      this.emitChange();
    };
    const onChange = (): void => {
      this.emitChange();
    };
    window.on("closed", onClosed);
    window.on("focus", onFocus);
    window.on("show", onChange);
    window.on("hide", onChange);
    window.on("page-title-updated", onChange);
    this.disposersByWindowId.set(windowId, () => {
      window.off("closed", onClosed);
      window.off("focus", onFocus);
      window.off("show", onChange);
      window.off("hide", onChange);
      window.off("page-title-updated", onChange);
    });
    this.emitChange();
  }

  closeById(windowId: string): Promise<void> {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined || record.window.isDestroyed()) {
      return Promise.resolve();
    }
    record.window.close();
    return Promise.resolve();
  }

  minimizeById(windowId: string): Promise<void> {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined || record.window.isDestroyed()) {
      return Promise.resolve();
    }
    record.window.minimize();
    return Promise.resolve();
  }

  zoomById(windowId: string): Promise<void> {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined || record.window.isDestroyed()) {
      return Promise.resolve();
    }
    if (record.window.isMaximized()) {
      record.window.unmaximize();
      return Promise.resolve();
    }
    record.window.maximize();
    return Promise.resolve();
  }

  forceCloseById(windowId: string): Promise<void> {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined) {
      return Promise.resolve();
    }
    this.unregister(record);
    if (!record.window.isDestroyed()) {
      record.window.destroy();
    }
    return Promise.resolve();
  }

  focusMru(): boolean {
    const windowId = this.mru.mostRecent();
    if (windowId === null) {
      return false;
    }
    return this.focusById(windowId);
  }

  focusById(windowId: string): boolean {
    const record = this.recordsByWindowId.get(windowId);
    if (record === undefined || record.window.isDestroyed()) {
      return false;
    }
    if (!record.window.isVisible()) {
      record.window.show();
    }
    record.window.focus();
    this.mru.touch(windowId);
    this.emitChange();
    return true;
  }

  list(): readonly WindowSummary[] {
    return Array.from(this.recordsByWindowId.values()).map((record) => ({
      windowId: record.windowId,
      title: readWindowTitle(record.window),
      isFocused: record.window.isFocused(),
      isVisible: record.window.isVisible(),
    }));
  }

  records(): readonly WindowRegistryRecord<TWindow>[] {
    return Array.from(this.recordsByWindowId.values());
  }

  getWindowById(windowId: string): TWindow | null {
    return this.recordsByWindowId.get(windowId)?.window ?? null;
  }

  getRecordById(windowId: string): WindowRegistryRecord<TWindow> | null {
    return this.recordsByWindowId.get(windowId) ?? null;
  }

  getRecordByWebContentsId(
    webContentsId: number,
  ): WindowRegistryRecord<TWindow> | null {
    const windowId = this.windowIdByWebContentsId.get(webContentsId);
    if (windowId === undefined) {
      return null;
    }
    return this.getRecordById(windowId);
  }

  getWebContentsById(windowId: string): TWindow["webContents"] | null {
    return this.recordsByWindowId.get(windowId)?.window.webContents ?? null;
  }

  mostRecentlyFocusedId(): string | null {
    return this.mru.mostRecent();
  }

  getMruRecord(): WindowRegistryRecord<TWindow> | null {
    const windowId = this.mru.mostRecent();
    if (windowId === null) {
      return null;
    }
    return this.getRecordById(windowId);
  }

  on(event: "change", listener: WindowRegistryListener): void {
    this.events.on(event, listener);
  }

  off(event: "change", listener: WindowRegistryListener): void {
    this.events.off(event, listener);
  }

  dispose(): void {
    for (const dispose of this.disposersByWindowId.values()) {
      dispose();
    }
    this.disposersByWindowId.clear();
    this.recordsByWindowId.clear();
    this.windowIdByWebContentsId.clear();
  }

  private emitChange(): void {
    this.events.emit("change");
  }

  private unregister(record: WindowRegistryRecord<TWindow>): void {
    this.recordsByWindowId.delete(record.windowId);
    this.windowIdByWebContentsId.delete(record.webContentsId);
    this.mru.remove(record.windowId);
    this.disposersByWindowId.get(record.windowId)?.();
    this.disposersByWindowId.delete(record.windowId);
    this.emitChange();
  }
}

function readWindowTitle(window: RegistryManagedWindow): string {
  const title = window.getTitle();
  return title.length === 0 ? "Traycer" : title;
}
