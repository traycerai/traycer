import type { BootstrapMarkerEntry } from "@traycer-clients/shared/platform/runner-host";

export interface BootstrapAttemptSummary {
  readonly attempt: BootstrapMarkerEntry;
  readonly outcome: BootstrapMarkerEntry | null;
}

/** When no follow-up exists, the host is mid- spawn or never published a terminal marker - surface that as
 * `outcome: null` and let the renderer say so. */
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
