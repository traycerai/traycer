import { vi, type Mock } from "vitest";
import type { CloseToTrayManagedWindow } from "../close-to-tray";
import { WindowRegistry } from "../window-registry";

export class RegistryFakeWindow implements CloseToTrayManagedWindow {
  readonly webContents: { readonly id: number };
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly closeListeners = new Set<
    (event: { preventDefault(): void }) => void
  >();
  private destroyed = false;
  private visible = true;
  hideCalls = 0;
  closeCalls = 0;
  showCalls = 0;
  focusCalls = 0;
  minimized = false;

  constructor(webContentsId: number) {
    this.webContents = { id: webContentsId };
  }
  onClose(listener: (event: { preventDefault(): void }) => void): void {
    this.closeListeners.add(listener);
  }
  close(): void {
    this.closeCalls += 1;
    let prevented = false;
    for (const listener of this.closeListeners) {
      listener({
        preventDefault: () => {
          prevented = true;
        },
      });
    }
    if (prevented) return;
    this.destroyed = true;
    this.emit("closed");
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("closed");
  }
  hide(): void {
    this.hideCalls += 1;
    this.visible = false;
    this.emit("hide");
  }
  focus(): void {
    this.focusCalls += 1;
    this.emit("focus");
  }
  getTitle(): string {
    return "";
  }
  isMaximized(): boolean {
    return false;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  minimize(): void {}
  maximize(): void {}
  unmaximize(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isFocused(): boolean {
    return false;
  }
  isVisible(): boolean {
    return this.visible;
  }
  show(): void {
    this.showCalls += 1;
    this.visible = true;
    this.emit("show");
  }
  on(event: string, listener: () => void): void {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }
  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  private emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

export interface RegistryRig {
  readonly registry: WindowRegistry<RegistryFakeWindow>;
  readonly created: RegistryFakeWindow[];
  readonly createWindow: Mock<() => RegistryFakeWindow>;
}

export function registryRig(): RegistryRig {
  const created: RegistryFakeWindow[] = [];
  const createWindow = vi.fn(() => {
    const window = new RegistryFakeWindow(created.length + 1);
    created.push(window);
    return window;
  });
  const registry = new WindowRegistry<RegistryFakeWindow>({
    createWindow,
    loadWindow: () => Promise.resolve(),
  });
  return { registry, created, createWindow };
}
