import type { BootstrapMarkerEntry } from "@traycer-clients/shared/platform/runner-host";

/**
 * Pure reduction of the bootstrap marker file, kept out of
 * `bootstrap-attempt-details.tsx` so that component file exports only a
 * component and keeps fast refresh (the same split `tab-chrome-tokens.ts`
 * makes for the header tabs).
 */
export interface BootstrapAttemptSummary {
  readonly attempt: BootstrapMarkerEntry;
  readonly outcome: BootstrapMarkerEntry | null;
}

/**
 * Picks the most recent `phase=starting` marker and its terminal follow-up
 * (`exited` / `crashed` / `killed` / `failed-to-spawn`). The marker file is
 * append-only, so the relevant pair is "the last `starting` and the next
 * non-`starting` after it". When no follow-up exists, the host is mid-
 * spawn or never published a terminal marker - surface that as `outcome:
 * null` and let the renderer say so.
 */
export function summariseBootstrapAttempts(
  markers: readonly BootstrapMarkerEntry[],
): BootstrapAttemptSummary | null {
  let lastStartIdx = -1;
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i]?.phase === "starting") {
      lastStartIdx = i;
      break;
    }
  }
  if (lastStartIdx === -1) return null;
  const attempt = markers[lastStartIdx];
  for (let i = lastStartIdx + 1; i < markers.length; i++) {
    const m = markers[i];
    if (m.phase !== "starting") {
      return { attempt, outcome: m };
    }
  }
  return { attempt, outcome: null };
}

export function describeOutcome(marker: BootstrapMarkerEntry): string {
  const fields = marker.fields;
  switch (marker.phase) {
    case "exited": {
      const code = fields.code ?? "?";
      return `Host exited with code ${code}.`;
    }
    case "crashed": {
      const code = fields.code ?? "?";
      const signal =
        fields.signal !== undefined ? ` (signal ${fields.signal})` : "";
      return `Host crashed with code ${code}${signal}.`;
    }
    case "killed": {
      const signal = fields.signal ?? "unknown";
      return `Host was killed with signal ${signal}.`;
    }
    case "failed-to-spawn": {
      const error = fields.error ?? "spawn failed";
      return `Failed to spawn shell: ${error}`;
    }
    case "starting":
      return "";
  }
}
