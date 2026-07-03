import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DisplayTopology } from "../../app/screen-monitor";
import type { JsonFileStore } from "../../app/json-file-store";
import {
  createFirstLaunchWindowPlacement,
  createWindowGeometryPersistence,
  installPrimaryWindowGeometryPersistence,
  loadInitialWindowGeometrySync,
  resolvePrimaryWindowPlacement,
  resolveSecondaryWindowPlacement,
  type PersistedGeometryWindow,
  type WindowGeometryBounds,
  type WindowGeometryState,
} from "../window-geometry";

const testState = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: (): string => testState.userDataDir,
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info", resolvePathFn: null },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const SINGLE_DISPLAY_TOPOLOGY: DisplayTopology = {
  primaryId: 1,
  displays: [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1,
      rotation: 0,
      internal: true,
      label: "Built-in",
      primary: true,
    },
  ],
};
class FakeGeometryWindow implements PersistedGeometryWindow {
  private readonly listeners = new Map<string, Set<() => void>>();
  private destroyed = false;
  private maximized = false;
  private bounds: WindowGeometryBounds;
  private normalBounds: WindowGeometryBounds;

  constructor(bounds: WindowGeometryBounds) {
    this.bounds = bounds;
    this.normalBounds = bounds;
  }

  getBounds(): WindowGeometryBounds {
    return this.bounds;
  }

  getNormalBounds(): WindowGeometryBounds {
    return this.normalBounds;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMaximized(): boolean {
    return this.maximized;
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

  setBounds(bounds: WindowGeometryBounds): void {
    this.bounds = bounds;
    if (!this.maximized) {
      this.normalBounds = bounds;
    }
  }

  setNormalBounds(bounds: WindowGeometryBounds): void {
    this.normalBounds = bounds;
  }

  setMaximized(maximized: boolean): void {
    this.maximized = maximized;
  }
}

class MemoryGeometryStore implements JsonFileStore<WindowGeometryState> {
  readonly saves: WindowGeometryState[] = [];

  load(): Promise<WindowGeometryState> {
    return Promise.resolve({ bounds: null, maximized: false });
  }

  save(value: WindowGeometryState): Promise<void> {
    this.saves.push(value);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

describe("window geometry", () => {
  beforeEach(() => {
    testState.userDataDir = mkdtempSync(join(tmpdir(), "traycer-user-data-"));
  });

  afterEach(() => {
    if (testState.userDataDir !== "") {
      rmSync(testState.userDataDir, { recursive: true, force: true });
      testState.userDataDir = "";
    }
  });

  it("keeps first launch maximized with the default initial size", () => {
    expect(createFirstLaunchWindowPlacement()).toEqual({
      x: null,
      y: null,
      width: 1280,
      height: 800,
      maximized: true,
    });
  });

  it("restores visible persisted bounds and maximized state", () => {
    const placement = resolvePrimaryWindowPlacement({
      saved: {
        bounds: { x: 240, y: 180, width: 1500, height: 900 },
        maximized: true,
      },
      topology: SINGLE_DISPLAY_TOPOLOGY,
    });

    expect(placement).toEqual({
      x: 240,
      y: 180,
      width: 1500,
      height: 900,
      maximized: true,
    });
  });

  it("clamps restored bounds to the fixed native minimum size", () => {
    const placement = resolvePrimaryWindowPlacement({
      saved: {
        bounds: { x: 240, y: 180, width: 500, height: 400 },
        maximized: false,
      },
      topology: SINGLE_DISPLAY_TOPOLOGY,
    });

    expect(placement).toEqual({
      x: 240,
      y: 180,
      width: 960,
      height: 600,
      maximized: false,
    });
  });

  it("falls back to centered maximized placement when saved bounds are off-screen", () => {
    const placement = resolvePrimaryWindowPlacement({
      saved: {
        bounds: { x: 9000, y: 9000, width: 1600, height: 1000 },
        maximized: false,
      },
      topology: SINGLE_DISPLAY_TOPOLOGY,
    });

    expect(placement).toEqual({
      x: 320,
      y: 120,
      width: 1280,
      height: 800,
      maximized: true,
    });
  });

  it("creates secondary placement from the source normal bounds with cascade", () => {
    const sourceWindow = new FakeGeometryWindow({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    });
    sourceWindow.setMaximized(true);
    sourceWindow.setNormalBounds({ x: 100, y: 120, width: 1500, height: 900 });

    const placement = resolveSecondaryWindowPlacement({
      sourceWindow,
      topology: SINGLE_DISPLAY_TOPOLOGY,
    });

    expect(placement).toEqual({
      x: 132,
      y: 152,
      width: 1500,
      height: 900,
      maximized: false,
    });
  });

  it("persists normal bounds while maximized and current bounds after unmaximize", async () => {
    const window = new FakeGeometryWindow({
      x: 20,
      y: 30,
      width: 1400,
      height: 900,
    });
    const store = new MemoryGeometryStore();
    const persistence = createWindowGeometryPersistence(store);
    installPrimaryWindowGeometryPersistence(window, persistence, null);

    window.setMaximized(true);
    window.setNormalBounds({ x: 90, y: 110, width: 1700, height: 1000 });
    window.emit("maximize");
    await store.flush();

    window.setMaximized(false);
    window.setBounds({ x: 90, y: 110, width: 1700, height: 1000 });
    window.emit("unmaximize");
    await store.flush();

    expect(store.saves).toEqual([
      {
        bounds: { x: 90, y: 110, width: 1700, height: 1000 },
        maximized: true,
      },
      {
        bounds: { x: 90, y: 110, width: 1700, height: 1000 },
        maximized: false,
      },
    ]);
  });

  it("coalesces high-frequency move and resize persistence", async () => {
    vi.useFakeTimers();
    try {
      const window = new FakeGeometryWindow({
        x: 20,
        y: 30,
        width: 1400,
        height: 900,
      });
      const store = new MemoryGeometryStore();
      const persistence = createWindowGeometryPersistence(store);
      installPrimaryWindowGeometryPersistence(window, persistence, null);

      window.setBounds({ x: 30, y: 40, width: 1400, height: 900 });
      window.emit("move");
      window.setBounds({ x: 30, y: 40, width: 1500, height: 950 });
      window.emit("resize");

      expect(store.saves).toEqual([]);

      await vi.advanceTimersByTimeAsync(350);
      await store.flush();

      expect(store.saves).toEqual([
        {
          bounds: { x: 30, y: 40, width: 1500, height: 950 },
          maximized: false,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the latest pending geometry without waiting for debounce", async () => {
    vi.useFakeTimers();
    try {
      const window = new FakeGeometryWindow({
        x: 20,
        y: 30,
        width: 1400,
        height: 900,
      });
      const store = new MemoryGeometryStore();
      const persistence = createWindowGeometryPersistence(store);
      installPrimaryWindowGeometryPersistence(window, persistence, null);

      window.setBounds({ x: 60, y: 70, width: 1600, height: 1000 });
      window.emit("resize");
      await persistence.flushLatest();

      expect(store.saves).toEqual([
        {
          bounds: { x: 60, y: 70, width: 1600, height: 1000 },
          maximized: false,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats non-finite persisted bounds as absent geometry", () => {
    writeFileSync(
      join(testState.userDataDir, "window-geometry.json"),
      `{"bounds":{"x":10,"y":20,"width":1e309,"height":800},"maximized":false}`,
    );

    expect(loadInitialWindowGeometrySync()).toEqual({
      bounds: null,
      maximized: false,
    });
  });
});
