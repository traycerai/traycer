import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { JsonFileStore } from "../../app/json-file-store";
import {
  WindowZoomController,
  loadInitialZoomPercentFromFileSync,
  zoomPercentToFactor,
  type ZoomHeuristicDisplay,
  type ZoomManagedWindow,
  type ZoomPercent,
} from "../window-zoom";
import { initialWindowSize, minimumWindowSize } from "../window-layout";

vi.mock("electron", () => ({
  app: {
    getPath: (): string => "/tmp/traycer-user-data",
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

interface ZoomPreference {
  readonly zoomPercent: ZoomPercent;
}

class FakeZoomStore implements JsonFileStore<ZoomPreference> {
  readonly saved: ZoomPreference[] = [];

  load(): Promise<ZoomPreference> {
    return Promise.resolve({ zoomPercent: 100 });
  }

  save(value: ZoomPreference): Promise<void> {
    this.saved.push(value);
    return Promise.resolve();
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeZoomWindow implements ZoomManagedWindow {
  readonly factors: number[] = [];
  readonly minimumSizes: Array<{
    readonly width: number;
    readonly height: number;
  }> = [];
  readonly sizes: Array<{ readonly width: number; readonly height: number }> =
    [];
  readonly webContents = {
    setZoomFactor: (factor: number): void => {
      this.factors.push(factor);
    },
  };
  destroyed = false;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function testDisplay(width: number, scaleFactor: number): ZoomHeuristicDisplay {
  return { bounds: { width }, scaleFactor };
}

function withZoomPreferenceFile(run: (filePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "traycer-window-zoom-"));
  try {
    run(join(dir, "window-zoom.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readSavedZoomPercent(filePath: string): number {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "zoomPercent" in parsed &&
    typeof parsed.zoomPercent === "number"
  ) {
    return parsed.zoomPercent;
  }
  return 0;
}

describe("WindowZoomController", () => {
  it("steps on the Chromium ladder, persists percent, and broadcasts factor", async () => {
    const store = new FakeZoomStore();
    const windowA = new FakeZoomWindow(1600, 1000);
    const windowB = new FakeZoomWindow(1600, 1000);
    const controller = new WindowZoomController({
      windowRegistry: {
        records: () => [{ window: windowA }, { window: windowB }],
      },
      initialZoomPercent: 100,
      store,
    });

    await controller.zoomIn();
    await controller.zoomIn();
    await controller.zoomOut();
    await controller.reset();

    expect(store.saved).toEqual([
      { zoomPercent: 110 },
      { zoomPercent: 125 },
      { zoomPercent: 110 },
      { zoomPercent: 100 },
    ]);
    expect(windowA.factors).toEqual([1.1, 1.25, 1.1, 1]);
    expect(windowB.factors).toEqual([1.1, 1.25, 1.1, 1]);
  });

  it("clamps at ladder edges", async () => {
    const store = new FakeZoomStore();
    const controller = new WindowZoomController({
      windowRegistry: { records: () => [] },
      initialZoomPercent: 300,
      store,
    });

    await controller.zoomIn();
    await controller.setZoomPercent(42);

    expect(store.saved).toEqual([{ zoomPercent: 300 }, { zoomPercent: 67 }]);
  });

  it("changes only webContents zoom and leaves native window size alone", async () => {
    const store = new FakeZoomStore();
    const window = new FakeZoomWindow(1200, 700);
    const controller = new WindowZoomController({
      windowRegistry: { records: () => [{ window }] },
      initialZoomPercent: 100,
      store,
    });

    await controller.setZoomPercent(200);

    expect(window.factors).toEqual([2]);
    expect(window.width).toBe(1200);
    expect(window.height).toBe(700);
    expect(window.minimumSizes).toEqual([]);
    expect(window.sizes).toEqual([]);
  });
});

describe("first-run zoom heuristic", () => {
  it("defaults fresh 3840px 1x displays to 150%", () => {
    withZoomPreferenceFile((filePath) => {
      const percent = loadInitialZoomPercentFromFileSync(
        filePath,
        testDisplay(3840, 1),
      );

      expect(percent).toBe(150);
      expect(readSavedZoomPercent(filePath)).toBe(150);
    });
  });

  it("defaults fresh 2560px 1x displays to 125%", () => {
    withZoomPreferenceFile((filePath) => {
      const percent = loadInitialZoomPercentFromFileSync(
        filePath,
        testDisplay(2560, 1),
      );

      expect(percent).toBe(125);
      expect(readSavedZoomPercent(filePath)).toBe(125);
    });
  });

  it("defaults fresh 1920px 1x displays to 100%", () => {
    withZoomPreferenceFile((filePath) => {
      const percent = loadInitialZoomPercentFromFileSync(
        filePath,
        testDisplay(1920, 1),
      );

      expect(percent).toBe(100);
      expect(readSavedZoomPercent(filePath)).toBe(100);
    });
  });

  it("keeps fresh 2560px displays at 100% when OS scale is not 1x", () => {
    withZoomPreferenceFile((filePath) => {
      const percent = loadInitialZoomPercentFromFileSync(
        filePath,
        testDisplay(2560, 1.5),
      );

      expect(percent).toBe(100);
      expect(readSavedZoomPercent(filePath)).toBe(100);
    });
  });

  it("preserves an existing zoom preference file", () => {
    withZoomPreferenceFile((filePath) => {
      writeFileSync(filePath, JSON.stringify({ zoomPercent: 110 }), {
        encoding: "utf8",
        mode: 0o600,
      });

      const percent = loadInitialZoomPercentFromFileSync(
        filePath,
        testDisplay(3840, 1),
      );

      expect(percent).toBe(110);
      expect(readSavedZoomPercent(filePath)).toBe(110);
    });
  });
});

describe("window zoom sizing helpers", () => {
  it("keeps native window constraints independent from zoom percent", () => {
    expect(zoomPercentToFactor(150)).toBe(1.5);
    expect(minimumWindowSize()).toEqual({
      width: 960,
      height: 600,
    });
    expect(initialWindowSize()).toEqual({
      width: 1280,
      height: 800,
    });
  });
});
