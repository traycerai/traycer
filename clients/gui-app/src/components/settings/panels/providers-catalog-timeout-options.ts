import type { ConfigCatalogResponse } from "@traycer/protocol/host/config/schemas";

/** Offered values, in seconds; filtered to the host's bounds before render. */
const PRESET_SECONDS: readonly number[] = [60, 90, 120, 180];

/**
 * The menu's values: the presets inside the host's bounds, plus the stored
 * value as "N s (custom)" when it is not one of them (a hand-edited file), so
 * the current value is always a visible, selected row.
 */
export function catalogTimeoutOptions(
  state: ConfigCatalogResponse | null,
): ReadonlyArray<{ readonly seconds: number; readonly label: string }> {
  if (state === null) {
    return PRESET_SECONDS.map((seconds) => ({
      seconds,
      label: `${seconds} s`,
    }));
  }
  const { minSeconds, maxSeconds } = state.bounds;
  const presets = PRESET_SECONDS.filter(
    (seconds) => seconds >= minSeconds && seconds <= maxSeconds,
  ).map((seconds) => ({ seconds, label: `${seconds} s` }));
  if (presets.some((option) => option.seconds === state.probeTimeoutSeconds)) {
    return presets;
  }
  return [
    ...presets,
    {
      seconds: state.probeTimeoutSeconds,
      label: `${state.probeTimeoutSeconds} s (custom)`,
    },
  ].sort((a, b) => a.seconds - b.seconds);
}
