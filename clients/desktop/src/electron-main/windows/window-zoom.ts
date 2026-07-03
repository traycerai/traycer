import { app, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createJsonFileStore,
  type JsonFileStore,
} from "../app/json-file-store";
import { log } from "../app/logger";
import {
  ZOOM_PERCENT_LADDER,
  type ZoomPercent,
} from "../../ipc-contracts/zoom-types";

const STORE_FILE_NAME = "window-zoom.json";

export { ZOOM_PERCENT_LADDER, type ZoomPercent };

interface ZoomPreference {
  readonly zoomPercent: ZoomPercent;
}

export interface ZoomHeuristicDisplay {
  readonly bounds: {
    readonly width: number;
  };
  readonly scaleFactor: number;
}

export interface ZoomManagedWindow {
  readonly webContents: {
    setZoomFactor(factor: number): void;
  };
  isDestroyed(): boolean;
}

export interface ZoomWindowRecord<
  TWindow extends ZoomManagedWindow = BrowserWindow,
> {
  readonly window: TWindow;
}

export interface ZoomWindowRegistry<
  TWindow extends ZoomManagedWindow = BrowserWindow,
> {
  records(): readonly ZoomWindowRecord<TWindow>[];
}

export interface WindowZoomControllerOptions<
  TWindow extends ZoomManagedWindow = BrowserWindow,
> {
  readonly windowRegistry: ZoomWindowRegistry<TWindow>;
  readonly initialZoomPercent: ZoomPercent;
  readonly store: JsonFileStore<ZoomPreference>;
}

const DEFAULT_ZOOM_PERCENT: ZoomPercent = 100;
const ZOOM_PERCENT_VALUES: ReadonlySet<number> = new Set(ZOOM_PERCENT_LADDER);
type ZoomChangeListener = (percent: ZoomPercent) => void;

export class WindowZoomController<
  TWindow extends ZoomManagedWindow = BrowserWindow,
> {
  private readonly windowRegistry: ZoomWindowRegistry<TWindow>;
  private readonly store: JsonFileStore<ZoomPreference>;
  private readonly listeners = new Set<ZoomChangeListener>();
  private zoomPercent: ZoomPercent;

  constructor(options: WindowZoomControllerOptions<TWindow>) {
    this.windowRegistry = options.windowRegistry;
    this.store = options.store;
    this.zoomPercent = options.initialZoomPercent;
  }

  getZoomPercent(): ZoomPercent {
    return this.zoomPercent;
  }

  getZoomFactor(): number {
    return zoomPercentToFactor(this.zoomPercent);
  }

  onChange(listener: ZoomChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async zoomIn(): Promise<ZoomPercent> {
    return await this.setZoomPercent(stepZoomPercent(this.zoomPercent, 1));
  }

  async zoomOut(): Promise<ZoomPercent> {
    return await this.setZoomPercent(stepZoomPercent(this.zoomPercent, -1));
  }

  async reset(): Promise<ZoomPercent> {
    return await this.setZoomPercent(DEFAULT_ZOOM_PERCENT);
  }

  async setZoomPercent(percent: number): Promise<ZoomPercent> {
    const nextPercent = normalizeZoomPercent(percent);
    this.zoomPercent = nextPercent;
    applyZoomToWindows(this.windowRegistry.records(), nextPercent);
    await this.store.save({ zoomPercent: nextPercent });
    log.info("[zoom] preference saved", { zoomPercent: nextPercent });
    this.emitChange(nextPercent);
    return nextPercent;
  }

  private emitChange(percent: ZoomPercent): void {
    for (const listener of this.listeners) {
      listener(percent);
    }
  }
}

export function createWindowZoomController<
  TWindow extends ZoomManagedWindow = BrowserWindow,
>(
  windowRegistry: ZoomWindowRegistry<TWindow>,
  initialZoomPercent: ZoomPercent,
): WindowZoomController<TWindow> {
  return new WindowZoomController({
    windowRegistry,
    initialZoomPercent,
    store: createZoomPreferenceStore(),
  });
}

export function loadInitialZoomPercentSync(
  display: ZoomHeuristicDisplay | null,
): ZoomPercent {
  return loadInitialZoomPercentFromFileSync(storePath(), display);
}

export function loadInitialZoomPercentFromFileSync(
  filePath: string,
  display: ZoomHeuristicDisplay | null,
): ZoomPercent {
  try {
    const raw = readFileSync(filePath, "utf8");
    return parsePreference(JSON.parse(raw)).zoomPercent;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("[zoom] preference load failed; preserving existing file", {
        filePath,
        err,
      });
      return DEFAULT_ZOOM_PERCENT;
    }
  }

  const zoomPercent = defaultZoomPercentForDisplay(display);
  saveInitialZoomPreferenceSync(filePath, { zoomPercent });
  log.info("[zoom] first-run default saved", { zoomPercent });
  return zoomPercent;
}

export function zoomPercentToFactor(percent: ZoomPercent): number {
  return percent / 100;
}

function createZoomPreferenceStore(): JsonFileStore<ZoomPreference> {
  return createJsonFileStore<ZoomPreference>(
    storePath(),
    { zoomPercent: DEFAULT_ZOOM_PERCENT },
    parsePreference,
  );
}

function defaultZoomPercentForDisplay(
  display: ZoomHeuristicDisplay | null,
): ZoomPercent {
  if (display === null || display.scaleFactor !== 1) {
    return DEFAULT_ZOOM_PERCENT;
  }

  if (display.bounds.width >= 3840) {
    return 150;
  }

  if (display.bounds.width >= 2560) {
    return 125;
  }

  return DEFAULT_ZOOM_PERCENT;
}

function saveInitialZoomPreferenceSync(
  filePath: string,
  preference: ZoomPreference,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(preference, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, filePath);
  } catch (err) {
    log.warn("[zoom] first-run default persist failed", { filePath, err });
  }
}

function storePath(): string {
  return join(app.getPath("userData"), STORE_FILE_NAME);
}

function parsePreference(value: unknown): ZoomPreference {
  if (isRecord(value)) {
    const percent = value.zoomPercent;
    if (typeof percent === "number") {
      return { zoomPercent: normalizeZoomPercent(percent) };
    }
  }
  return { zoomPercent: DEFAULT_ZOOM_PERCENT };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeZoomPercent(percent: number): ZoomPercent {
  if (isZoomPercent(percent)) {
    return percent;
  }
  return ZOOM_PERCENT_LADDER.reduce((nearest, candidate) =>
    Math.abs(candidate - percent) < Math.abs(nearest - percent)
      ? candidate
      : nearest,
  );
}

function isZoomPercent(value: number): value is ZoomPercent {
  return ZOOM_PERCENT_VALUES.has(value);
}

function stepZoomPercent(percent: ZoomPercent, delta: 1 | -1): ZoomPercent {
  const index = ZOOM_PERCENT_LADDER.indexOf(percent);
  const nextIndex = Math.min(
    ZOOM_PERCENT_LADDER.length - 1,
    Math.max(0, index + delta),
  );
  return ZOOM_PERCENT_LADDER[nextIndex];
}

function applyZoomToWindows<TWindow extends ZoomManagedWindow>(
  records: readonly ZoomWindowRecord<TWindow>[],
  percent: ZoomPercent,
): void {
  const factor = zoomPercentToFactor(percent);
  records
    .map((record) => record.window)
    .filter((window) => !window.isDestroyed())
    .forEach((window) => {
      window.webContents.setZoomFactor(factor);
    });
}
