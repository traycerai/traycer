import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createJsonFileStore,
  type JsonFileStore,
} from "../app/json-file-store";
import { log } from "../app/logger";
import type { DisplaySnapshot, DisplayTopology } from "../app/screen-monitor";
import { initialWindowSize, minimumWindowSize } from "./window-layout";

const STORE_FILE_NAME = "window-geometry.json";
const CASCADE_OFFSET = 32;
const MINIMUM_VISIBLE_SIZE = 100;
const GEOMETRY_PERSIST_DEBOUNCE_MS = 350;

export interface WindowGeometryBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowGeometryState {
  readonly bounds: WindowGeometryBounds | null;
  readonly maximized: boolean;
}

export interface WindowGeometryPlacement {
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

export interface WindowGeometrySource {
  getBounds(): WindowGeometryBounds;
  getNormalBounds(): WindowGeometryBounds;
  isDestroyed(): boolean;
  isMaximized(): boolean;
}

export interface PersistedGeometryWindow extends WindowGeometrySource {
  on(event: string, listener: () => void): void;
  off(event: string, listener: () => void): void;
}

export type WindowGeometryStore = JsonFileStore<WindowGeometryState>;

export interface WindowGeometryPersistence {
  install(
    window: PersistedGeometryWindow,
    onPersist: ((state: WindowGeometryState) => void) | null,
  ): () => void;
  flushLatest(): Promise<void>;
}

const EMPTY_GEOMETRY_STATE: WindowGeometryState = {
  bounds: null,
  maximized: false,
};

export function createWindowGeometryStore(): WindowGeometryStore {
  return createJsonFileStore<WindowGeometryState>(
    storePath(),
    EMPTY_GEOMETRY_STATE,
    parseWindowGeometryState,
  );
}

export function createWindowGeometryPersistence(
  store: WindowGeometryStore,
): WindowGeometryPersistence {
  return new CoalescingWindowGeometryPersistence(store);
}

export function loadInitialWindowGeometrySync(): WindowGeometryState {
  try {
    const raw = readFileSync(storePath(), "utf8");
    return parseWindowGeometryState(JSON.parse(raw));
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) {
      log.warn("[window-geometry] load failed", { filePath: storePath(), err });
    }
    return EMPTY_GEOMETRY_STATE;
  }
}

export function createFirstLaunchWindowPlacement(): WindowGeometryPlacement {
  const initialSize = initialWindowSize();
  return {
    x: null,
    y: null,
    width: initialSize.width,
    height: initialSize.height,
    maximized: true,
  };
}

export function resolvePrimaryWindowPlacement(options: {
  readonly saved: WindowGeometryState;
  readonly topology: DisplayTopology;
}): WindowGeometryPlacement {
  const savedBounds = options.saved.bounds;
  if (savedBounds === null) {
    return createFirstLaunchWindowPlacement();
  }

  const bounds = withMinimumSize(savedBounds);
  if (isVisibleOnAnyDisplay(bounds, options.topology)) {
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: options.saved.maximized,
    };
  }

  const fallbackDisplay = nearestDisplay(bounds, options.topology);
  if (fallbackDisplay === null) {
    return createFirstLaunchWindowPlacement();
  }
  const centered = centerInWorkArea(
    initialWindowSize(),
    fallbackDisplay.workArea,
  );
  return {
    ...centered,
    maximized: true,
  };
}

export function resolveSecondaryWindowPlacement(options: {
  readonly sourceWindow: WindowGeometrySource;
  readonly topology: DisplayTopology;
}): WindowGeometryPlacement {
  const sourceBounds = readNormalBounds(options.sourceWindow);
  const cascaded = withMinimumSize({
    ...sourceBounds,
    x: sourceBounds.x + CASCADE_OFFSET,
    y: sourceBounds.y + CASCADE_OFFSET,
  });
  const display = nearestDisplay(sourceBounds, options.topology);
  const bounds =
    display === null
      ? cascaded
      : keepCascadeVisible(cascaded, display.workArea);
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: false,
  };
}

export function installPrimaryWindowGeometryPersistence(
  window: PersistedGeometryWindow,
  persistence: WindowGeometryPersistence,
  onPersist: ((state: WindowGeometryState) => void) | null,
): () => void {
  return persistence.install(window, onPersist);
}

class CoalescingWindowGeometryPersistence implements WindowGeometryPersistence {
  private readonly store: WindowGeometryStore;
  private debounceTimer: NodeJS.Timeout | null = null;
  private latestState: WindowGeometryState | null = null;

  constructor(store: WindowGeometryStore) {
    this.store = store;
  }

  install(
    window: PersistedGeometryWindow,
    onPersist: ((state: WindowGeometryState) => void) | null,
  ): () => void {
    const persistSoon = (): void => {
      const state = this.captureState(window, onPersist);
      if (state === null) {
        return;
      }
      this.latestState = state;
      this.scheduleFlush();
    };
    const persistNow = (): void => {
      const state = this.captureState(window, onPersist);
      if (state === null) {
        return;
      }
      this.latestState = state;
      void this.flushLatest();
    };

    window.on("move", persistSoon);
    window.on("resize", persistSoon);
    window.on("maximize", persistNow);
    window.on("unmaximize", persistNow);
    window.on("close", persistNow);

    return () => {
      window.off("move", persistSoon);
      window.off("resize", persistSoon);
      window.off("maximize", persistNow);
      window.off("unmaximize", persistNow);
      window.off("close", persistNow);
    };
  }

  async flushLatest(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    while (this.latestState !== null) {
      const state = this.latestState;
      this.latestState = null;
      await this.store.save(state);
    }
    await this.store.flush();
  }

  private captureState(
    window: PersistedGeometryWindow,
    onPersist: ((state: WindowGeometryState) => void) | null,
  ): WindowGeometryState | null {
    if (window.isDestroyed()) {
      return null;
    }
    const state = readPersistableGeometry(window);
    onPersist?.(state);
    return state;
  }

  private scheduleFlush(): void {
    if (this.debounceTimer !== null) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushLatest();
    }, GEOMETRY_PERSIST_DEBOUNCE_MS);
  }
}

export function placementToBrowserWindowBounds(
  placement: WindowGeometryPlacement,
): {
  readonly width: number;
  readonly height: number;
  readonly x: number | undefined;
  readonly y: number | undefined;
} {
  return {
    width: placement.width,
    height: placement.height,
    x: placement.x === null ? undefined : placement.x,
    y: placement.y === null ? undefined : placement.y,
  };
}

function readPersistableGeometry(
  window: WindowGeometrySource,
): WindowGeometryState {
  return {
    bounds: sanitizeBounds(readNormalBounds(window)),
    maximized: window.isMaximized(),
  };
}

function readNormalBounds(window: WindowGeometrySource): WindowGeometryBounds {
  const normalBounds = window.getNormalBounds();
  if (isValidBounds(normalBounds)) {
    return normalBounds;
  }
  return window.getBounds();
}

function parseWindowGeometryState(value: unknown): WindowGeometryState {
  if (!isRecord(value)) {
    return EMPTY_GEOMETRY_STATE;
  }
  const bounds = parseBounds(value.bounds);
  return {
    bounds,
    maximized: value.maximized === true,
  };
}

function parseBounds(value: unknown): WindowGeometryBounds | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  const bounds = { x, y, width, height };
  return isValidBounds(bounds) ? sanitizeBounds(bounds) : null;
}

function sanitizeBounds(bounds: WindowGeometryBounds): WindowGeometryBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(Math.max(1, bounds.width)),
    height: Math.round(Math.max(1, bounds.height)),
  };
}

function withMinimumSize(bounds: WindowGeometryBounds): WindowGeometryBounds {
  const minSize = minimumWindowSize();
  return {
    ...sanitizeBounds(bounds),
    width: Math.max(Math.round(bounds.width), minSize.width),
    height: Math.max(Math.round(bounds.height), minSize.height),
  };
}

function isVisibleOnAnyDisplay(
  bounds: WindowGeometryBounds,
  topology: DisplayTopology,
): boolean {
  return topology.displays.some((display) => {
    const intersectionWidth =
      Math.min(
        bounds.x + bounds.width,
        display.workArea.x + display.workArea.width,
      ) - Math.max(bounds.x, display.workArea.x);
    const intersectionHeight =
      Math.min(
        bounds.y + bounds.height,
        display.workArea.y + display.workArea.height,
      ) - Math.max(bounds.y, display.workArea.y);
    return (
      intersectionWidth >= MINIMUM_VISIBLE_SIZE &&
      intersectionHeight >= MINIMUM_VISIBLE_SIZE
    );
  });
}

function nearestDisplay(
  bounds: WindowGeometryBounds,
  topology: DisplayTopology,
): DisplaySnapshot | null {
  const displays = topology.displays;
  if (displays.length === 0) {
    return null;
  }
  const boundsCenter = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  return displays.reduce((nearest, display) => {
    const nearestDistance = distanceToWorkArea(boundsCenter, nearest.workArea);
    const displayDistance = distanceToWorkArea(boundsCenter, display.workArea);
    return displayDistance < nearestDistance ? display : nearest;
  });
}

function distanceToWorkArea(
  point: { readonly x: number; readonly y: number },
  workArea: WindowGeometryBounds,
): number {
  const clampedX = Math.min(
    Math.max(point.x, workArea.x),
    workArea.x + workArea.width,
  );
  const clampedY = Math.min(
    Math.max(point.y, workArea.y),
    workArea.y + workArea.height,
  );
  return (point.x - clampedX) ** 2 + (point.y - clampedY) ** 2;
}

function centerInWorkArea(
  size: { readonly width: number; readonly height: number },
  workArea: WindowGeometryBounds,
): WindowGeometryBounds {
  return {
    x: Math.round(workArea.x + Math.max(0, workArea.width - size.width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

function keepCascadeVisible(
  bounds: WindowGeometryBounds,
  workArea: WindowGeometryBounds,
): WindowGeometryBounds {
  const maxX = workArea.x + workArea.width;
  const maxY = workArea.y + workArea.height;
  if (
    bounds.x + MINIMUM_VISIBLE_SIZE <= maxX &&
    bounds.y + MINIMUM_VISIBLE_SIZE <= maxY
  ) {
    return bounds;
  }
  return {
    ...bounds,
    x:
      workArea.x +
      Math.min(
        CASCADE_OFFSET,
        Math.max(0, workArea.width - MINIMUM_VISIBLE_SIZE),
      ),
    y:
      workArea.y +
      Math.min(
        CASCADE_OFFSET,
        Math.max(0, workArea.height - MINIMUM_VISIBLE_SIZE),
      ),
  };
}

function isValidBounds(bounds: WindowGeometryBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function storePath(): string {
  return join(app.getPath("userData"), STORE_FILE_NAME);
}
