import type { ConfigCatalogBounds } from "@traycer/protocol/host/config/schemas";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";

/** Offered values, in seconds; filtered to the host's bounds before render. */
const PRESET_SECONDS: readonly number[] = [60, 90, 120, 180];

/**
 * The picker's segments: the presets inside the host's bounds and the bounds
 * themselves (so a host whose range moved past every preset still offers
 * choices), plus the shown value when it is none of those (a hand-edited
 * file), so the current value is always a visible, pressed segment.
 */
export function catalogTimeoutOptions(
  bounds: ConfigCatalogBounds | null,
  currentSeconds: number | null,
): ReadonlyArray<{ readonly seconds: number; readonly label: string }> {
  const offered = new Set(
    bounds === null
      ? PRESET_SECONDS
      : PRESET_SECONDS.filter(
          (seconds) =>
            seconds >= bounds.minSeconds && seconds <= bounds.maxSeconds,
        ),
  );
  if (bounds !== null) {
    offered.add(bounds.minSeconds);
    offered.add(bounds.maxSeconds);
  }
  if (currentSeconds !== null) offered.add(currentSeconds);
  return [...offered]
    .sort((a, b) => a - b)
    .map((seconds) => ({ seconds, label: `${seconds} s` }));
}

/**
 * Whether the scoped host can serve the per-provider rows: BOTH
 * `config.catalog.get` and `config.catalog.set` negotiated at 1.1 or later.
 * They negotiate independently, and a 1.0 host (traycer#2450) has the shared
 * value only, so its `set` cannot take a provider's own value.
 *
 * Tri-state, for `resolveAutoCleanupGate`: `null` while either is unknown (no
 * handshake yet), `false` when either is absent or older than 1.1.
 */
export function catalogTimeoutRowsSupported(
  get: NegotiatedMethodVersion,
  set: NegotiatedMethodVersion,
): boolean | null {
  if (get === false || set === false) return false;
  if (get === null || set === null) return null;
  return onV11Line(get.major, get.minor) && onV11Line(set.major, set.minor);
}

// Major 1 only: this client has no downgrade path to any other major, so a
// host on another line cannot take its requests.
function onV11Line(major: number, minor: number): boolean {
  return major === 1 && minor >= 1;
}
