import { describe, expect, it } from "vitest";
import { WindowRegistry, type RegistryManagedWindow } from "../window-registry";

class FakeWindow implements RegistryManagedWindow {
  readonly webContents: { readonly id: number };
  private readonly listeners = new Map<string, Set<() => void>>();
  private destroyed = false;
  private visible = false;
  private focused = false;
  private maximized = false;
  private title = "";
  closeCalls = 0;
  destroyCalls = 0;
  focusCalls = 0;
  maximizeCalls = 0;
  minimizeCalls = 0;
  showCalls = 0;
  unmaximizeCalls = 0;

  constructor(webContentsId: number) {
    this.webContents = { id: webContentsId };
  }

  close(): void {
    this.closeCalls += 1;
    this.destroyed = true;
    this.emit("closed");
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.emit("closed");
  }

  focus(): void {
    this.focusCalls += 1;
    this.focused = true;
    this.emit("focus");
  }

  getTitle(): string {
    return this.title;
  }

  isMaximized(): boolean {
    return this.maximized;
  }

  minimize(): void {
    this.minimizeCalls += 1;
  }

  maximize(): void {
    this.maximizeCalls += 1;
    this.maximized = true;
  }

  unmaximize(): void {
    this.unmaximizeCalls += 1;
    this.maximized = false;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFocused(): boolean {
    return this.focused;
  }

  isVisible(): boolean {
    return this.visible;
  }

  show(): void {
    this.showCalls += 1;
    this.visible = true;
    this.emit("show");
  }

  setTitle(next: string): void {
    this.title = next;
    this.emit("page-title-updated");
  }

  hide(): void {
    this.visible = false;
    this.emit("hide");
  }

  on(event: string, listener: () => void): void {
    const bucket = this.listeners.get(event) ?? new Set<() => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

describe("WindowRegistry", () => {
  it("tracks windows, webContents ids, MRU focus, and close removal", async () => {
    let nextWebContentsId = 10;
    const created: FakeWindow[] = [];
    const registry = new WindowRegistry<FakeWindow>({
      createWindow: () => {
        const window = new FakeWindow(nextWebContentsId);
        nextWebContentsId += 1;
        created.push(window);
        return window;
      },
      loadWindow: async () => undefined,
    });
    const changes: number[] = [];
    registry.on("change", () => {
      changes.push(registry.list().length);
    });

    const windowA = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    const windowB = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    created[0].setTitle("Alpha");
    created[1].setTitle("Beta");

    expect(registry.records().map((record) => record.windowId)).toEqual([
      windowA,
      windowB,
    ]);
    expect(registry.getRecordByWebContentsId(10)?.windowId).toBe(windowA);
    expect(registry.mostRecentlyFocusedId()).toBe(windowB);

    expect(registry.focusById(windowA)).toBe(true);
    expect(created[0].showCalls).toBe(1);
    expect(created[0].focusCalls).toBe(1);
    expect(registry.mostRecentlyFocusedId()).toBe(windowA);
    expect(registry.list()).toContainEqual({
      windowId: windowA,
      title: "Alpha",
      isFocused: true,
      isVisible: true,
    });

    await registry.closeById(windowA);
    expect(created[0].closeCalls).toBe(1);
    expect(registry.getRecordById(windowA)).toBeNull();
    expect(registry.mostRecentlyFocusedId()).toBe(windowB);
    expect(changes.length).toBeGreaterThan(0);
  });

  it("force-closes a hidden window that intercepted normal close", async () => {
    let nextWebContentsId = 20;
    const created: FakeWindow[] = [];
    const registry = new WindowRegistry<FakeWindow>({
      createWindow: () => {
        const window = new FakeWindow(nextWebContentsId);
        nextWebContentsId += 1;
        created.push(window);
        return window;
      },
      loadWindow: async () => undefined,
    });

    const windowId = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });
    created[0].close = (): void => {
      created[0].closeCalls += 1;
      created[0].hide();
    };

    await registry.closeById(windowId);
    expect(created[0].closeCalls).toBe(1);
    expect(registry.getRecordById(windowId)).not.toBeNull();

    await registry.forceCloseById(windowId);
    expect(created[0].destroyCalls).toBe(1);
    expect(registry.getRecordById(windowId)).toBeNull();
  });

  it("minimizes and toggles zoom for registered windows", async () => {
    let nextWebContentsId = 25;
    const created: FakeWindow[] = [];
    const registry = new WindowRegistry<FakeWindow>({
      createWindow: () => {
        const window = new FakeWindow(nextWebContentsId);
        nextWebContentsId += 1;
        created.push(window);
        return window;
      },
      loadWindow: async () => undefined,
    });

    const windowId = await registry.create({
      initialRoute: "/",
      beforeLoad: null,
    });

    await registry.minimizeById(windowId);
    await registry.zoomById(windowId);
    await registry.zoomById(windowId);

    expect(created[0].minimizeCalls).toBe(1);
    expect(created[0].maximizeCalls).toBe(1);
    expect(created[0].unmaximizeCalls).toBe(1);
  });

  it("registers an explicit persisted id and defers load until loadById", async () => {
    let nextWebContentsId = 30;
    const created: FakeWindow[] = [];
    const loadCalls: Array<{
      webContentsId: number;
    }> = [];
    const beforeLoadCalls: string[] = [];
    const registry = new WindowRegistry<FakeWindow>({
      createWindow: () => {
        const window = new FakeWindow(nextWebContentsId);
        nextWebContentsId += 1;
        created.push(window);
        return window;
      },
      loadWindow: async (window) => {
        loadCalls.push({ webContentsId: window.webContents.id });
      },
    });

    const windowId = registry.createWithId({
      windowId: "persisted-window-a",
      initialRoute: "/epics/epic-a/tab-a",
      beforeLoad: (id) => beforeLoadCalls.push(id),
    });

    expect(windowId).toBe("persisted-window-a");
    expect(registry.getRecordById("persisted-window-a")?.windowId).toBe(
      "persisted-window-a",
    );
    expect(beforeLoadCalls).toEqual(["persisted-window-a"]);
    // create/register only - no renderer load yet.
    expect(loadCalls).toEqual([]);

    await registry.loadById("persisted-window-a");
    expect(loadCalls).toEqual([{ webContentsId: 30 }]);
    expect(registry.mostRecentlyFocusedId()).toBe("persisted-window-a");
  });

  it("rejects duplicate live window ids", async () => {
    let nextWebContentsId = 40;
    const registry = new WindowRegistry<FakeWindow>({
      createWindow: () => {
        const window = new FakeWindow(nextWebContentsId);
        nextWebContentsId += 1;
        return window;
      },
      loadWindow: async () => undefined,
    });

    registry.createWithId({
      windowId: "dup-window",
      initialRoute: "/",
      beforeLoad: null,
    });

    expect(() =>
      registry.createWithId({
        windowId: "dup-window",
        initialRoute: "/",
        beforeLoad: null,
      }),
    ).toThrow(/already registered/);
    expect(() => registry.register("dup-window", new FakeWindow(99))).toThrow(
      /already registered/,
    );
    await expect(registry.loadById("missing-window")).rejects.toThrow(
      /not registered/,
    );
  });
});
