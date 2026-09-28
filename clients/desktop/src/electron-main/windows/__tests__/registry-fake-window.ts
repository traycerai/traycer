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
  private visible: boolean;
  hideCalls = 0;
  closeCalls = 0;
  showCalls = 0;
  focusCalls = 0;
  minimized = false;

  /**
   * `shown: false` is a still-loading window - not visible, not
   * minimized, never hidden (distinct from one that WAS visible and got
   * `.hide()`d). Explicit and required: every caller states which one it
   * means.
   */
  constructor(webContentsId: number, shown: boolean) {
    this.webContents = { id: webContentsId };
    this.visible = shown;
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

/**
 * `shownQueue` supplies each created window's `shown` state, in creation
 * order; a window created past the end of the queue is `shown: true` (the
 * ordinary, already-loaded case every existing caller wants). Pass `[]` for
 * that default; pass `false` at an index to make that one window a
 * still-loading one.
 */
export function registryRig(shownQueue: readonly boolean[]): RegistryRig {
  const created: RegistryFakeWindow[] = [];
  const queue = [...shownQueue];
  const createWindow = vi.fn(() => {
    const next = queue.shift();
    const shown = next === undefined ? true : next;
    const window = new RegistryFakeWindow(created.length + 1, shown);
    created.push(window);
    return window;
  });
  const registry = new WindowRegistry<RegistryFakeWindow>({
    createWindow,
    loadWindow: () => Promise.resolve(),
  });
  return { registry, created, createWindow };
}
