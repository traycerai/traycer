const BASE_MIN_WIDTH = 960;
const BASE_MIN_HEIGHT = 600;
const DEFAULT_INITIAL_WIDTH = 1280;
const DEFAULT_INITIAL_HEIGHT = 800;

export function minimumWindowSize(): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: BASE_MIN_WIDTH,
    height: BASE_MIN_HEIGHT,
  };
}

export function initialWindowSize(): {
  readonly width: number;
  readonly height: number;
} {
  return {
    width: DEFAULT_INITIAL_WIDTH,
    height: DEFAULT_INITIAL_HEIGHT,
  };
}
