export const RESOLUTION_TEST_USER_DATA_DIR_ENV =
  "TRAYCER_RESOLUTION_TEST_USER_DATA_DIR";

const WINDOW_BOUNDS_ENV = "TRAYCER_RESOLUTION_TEST_WINDOW_BOUNDS";
const DISPLAY_BOUNDS_ENV = "TRAYCER_RESOLUTION_TEST_DISPLAY_BOUNDS";
const DISPLAY_SCALE_FACTOR_ENV = "TRAYCER_RESOLUTION_TEST_DISPLAY_SCALE_FACTOR";
const DISABLE_MAXIMIZE_ENV = "TRAYCER_RESOLUTION_TEST_DISABLE_MAXIMIZE";
const USE_BUILT_RENDERER_ENV = "TRAYCER_RESOLUTION_TEST_USE_BUILT_RENDERER";

export interface ResolutionTestWindowBounds {
  readonly width: number;
  readonly height: number;
}

export interface ResolutionTestWindowConfig {
  readonly bounds: ResolutionTestWindowBounds | null;
  readonly disableMaximize: boolean;
}

export interface ResolutionTestDisplay {
  readonly bounds: {
    readonly width: number;
  };
  readonly scaleFactor: number;
}

export function readResolutionTestWindowConfig(
  env: NodeJS.ProcessEnv,
): ResolutionTestWindowConfig {
  return {
    bounds: parseWindowBounds(env[WINDOW_BOUNDS_ENV] ?? null),
    disableMaximize: env[DISABLE_MAXIMIZE_ENV] === "1",
  };
}

export function readResolutionTestDisplay(
  env: NodeJS.ProcessEnv,
): ResolutionTestDisplay | null {
  const bounds = parseWindowBounds(env[DISPLAY_BOUNDS_ENV] ?? null);
  if (bounds === null) return null;
  const scaleFactor = Number(env[DISPLAY_SCALE_FACTOR_ENV]);
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  return {
    bounds: { width: bounds.width },
    scaleFactor,
  };
}

export function shouldUseBuiltRendererForResolutionTest(
  env: NodeJS.ProcessEnv,
): boolean {
  return env[USE_BUILT_RENDERER_ENV] === "1";
}

function parseWindowBounds(
  raw: string | null,
): ResolutionTestWindowBounds | null {
  if (raw === null) return null;
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return null;
  }
  if (width < 1 || height < 1) return null;
  return { width, height };
}
