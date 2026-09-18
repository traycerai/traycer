import { describe, expect, it } from "vitest";
import { statusBarPreviewSample } from "@/components/sample-workspace/sample-rate-limit-readings";
import { statusBarSegmentKey } from "@/components/layout/status-bar/status-bar-usage-display";
import type {
  StatusBarProviderSegmentModel,
  StatusBarProviderSegmentState,
  StatusBarRateLimitCluster,
  StatusBarRateLimitWindow,
} from "@/hooks/rate-limits/use-status-bar-rate-limit-segments";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function segment(
  providerId: StatusBarProviderSegmentModel["providerId"],
  state: StatusBarProviderSegmentState,
  profileId: string | null,
): StatusBarProviderSegmentModel {
  const reading: StatusBarRateLimitWindow = {
    windowKey: `${providerId}:real`,
    label: "5h",
    labelIsDuration: true,
    kind: "session",
    usedPercent: 12,
    resetsAt: NOW + HOUR,
    severity: "healthy",
  };
  const carriesReading = state === "live" || state === "degraded";
  return {
    providerId,
    profileId,
    account: null,
    hidden: false,
    state,
    reason: null,
    windows: carriesReading ? [reading] : [],
    shown: carriesReading ? [reading] : [],
    tightest: carriesReading ? reading : null,
  };
}

function clusterOf(
  ...segments: ReadonlyArray<StatusBarProviderSegmentModel>
): StatusBarRateLimitCluster {
  return { kind: "segments", segments };
}

function segmentsOf(
  cluster: StatusBarRateLimitCluster,
): ReadonlyArray<StatusBarProviderSegmentModel> {
  if (cluster.kind !== "segments") throw new Error("expected segments");
  return cluster.segments;
}

describe("statusBarPreviewSample - when the sample must NOT speak", () => {
  it("is null for the non-segment clusters", () => {
    expect(statusBarPreviewSample({ kind: "no-providers" }, NOW)).toBeNull();
    expect(statusBarPreviewSample({ kind: "hidden" }, NOW)).toBeNull();
  });

  it("is null when any provider has a live reading (never invent numbers beside a real one)", () => {
    const cluster = clusterOf(
      segment("claude-code", "cold", null),
      segment("codex", "live", null),
    );
    expect(statusBarPreviewSample(cluster, NOW)).toBeNull();
  });

  it("is null when any provider is degraded", () => {
    const cluster = clusterOf(
      segment("claude-code", "cold", null),
      segment("codex", "degraded", null),
    );
    expect(statusBarPreviewSample(cluster, NOW)).toBeNull();
  });

  it("is null when nothing is cold (providers that ANSWERED are not 'nothing fetched')", () => {
    const cluster = clusterOf(
      segment("claude-code", "unavailable", null),
      segment("codex", "unavailable", null),
    );
    expect(statusBarPreviewSample(cluster, NOW)).toBeNull();
  });

  it("is null for an empty segment list", () => {
    expect(statusBarPreviewSample(clusterOf(), NOW)).toBeNull();
  });
});

describe("statusBarPreviewSample - when it speaks", () => {
  const claude = segment("claude-code", "cold", null);
  const codex = segment("codex", "cold", null);
  const codexWork = segment("codex", "cold", "work");

  it("substitutes the two invented readings onto the first two cold segments, in order", () => {
    const sample = statusBarPreviewSample(clusterOf(claude, codex), NOW);

    expect(sample).not.toBeNull();
    const [first, second] = segmentsOf(sample?.cluster ?? { kind: "hidden" });
    expect(first).toMatchObject({
      providerId: "claude-code",
      state: "live",
      reason: null,
    });
    expect(first.tightest).toMatchObject({
      usedPercent: 57,
      label: "5h",
      kind: "session",
    });
    expect(second).toMatchObject({ providerId: "codex", state: "live" });
    expect(second.tightest).toMatchObject({
      usedPercent: 82,
      label: "wk",
      kind: "weekly",
    });
  });

  it("reports whose line the caption now covers, in strip order", () => {
    const sample = statusBarPreviewSample(clusterOf(claude, codex), NOW);

    expect(sample?.segmentKeys).toEqual([
      statusBarSegmentKey(claude),
      statusBarSegmentKey(codex),
    ]);
  });

  it("dates each reading relative to `now`", () => {
    const sample = statusBarPreviewSample(clusterOf(claude, codex), NOW);
    const [first, second] = segmentsOf(sample?.cluster ?? { kind: "hidden" });

    expect(first.tightest?.resetsAt).toBe(
      NOW + 4 * HOUR + 15 * MINUTE + 30_000,
    );
    expect(second.tightest?.resetsAt).toBe(NOW + 2 * DAY + 12 * HOUR);
  });

  it("makes the invented window the whole selection", () => {
    const sample = statusBarPreviewSample(clusterOf(claude), NOW);
    const [only] = segmentsOf(sample?.cluster ?? { kind: "hidden" });

    expect(only.windows).toHaveLength(1);
    expect(only.shown).toEqual(only.windows);
    expect(only.tightest).toBe(only.windows[0]);
    expect(only.tightest?.labelIsDuration).toBe(true);
    expect(only.tightest?.windowKey).toBe("claude-code:sample");
  });

  it("tints the sample with the strip's own classifier (a real severity, heavier for 82% than 57%)", () => {
    const sample = statusBarPreviewSample(clusterOf(claude, codex), NOW);
    const [first, second] = segmentsOf(sample?.cluster ?? { kind: "hidden" });
    const severities = ["healthy", "warning", "critical", "exhausted"];

    expect(severities).toContain(first.tightest?.severity);
    expect(severities).toContain(second.tightest?.severity);
    expect(
      severities.indexOf(second.tightest?.severity ?? ""),
    ).toBeGreaterThanOrEqual(
      severities.indexOf(first.tightest?.severity ?? ""),
    );
  });

  it("stops at two: further cold segments stay cold and untouched (same object)", () => {
    const third = segment("claude-code", "cold", "other");
    const sample = statusBarPreviewSample(clusterOf(claude, codex, third), NOW);
    const segments = segmentsOf(sample?.cluster ?? { kind: "hidden" });

    expect(segments).toHaveLength(3);
    expect(segments[2]).toBe(third);
    expect(sample?.segmentKeys).toHaveLength(2);
  });

  it("only substitutes COLD segments, leaving unavailable ones exactly as they were", () => {
    const unavailable = segment("claude-code", "unavailable", null);
    const sample = statusBarPreviewSample(clusterOf(unavailable, codex), NOW);
    const segments = segmentsOf(sample?.cluster ?? { kind: "hidden" });

    expect(segments[0]).toBe(unavailable);
    expect(segments[1]).toMatchObject({ providerId: "codex", state: "live" });
    expect(sample?.segmentKeys).toEqual([statusBarSegmentKey(codex)]);
  });

  it("keys by segment, not provider: one provider with two accounts is two cold tracks, each with its own number", () => {
    const sample = statusBarPreviewSample(clusterOf(codex, codexWork), NOW);
    const [first, second] = segmentsOf(sample?.cluster ?? { kind: "hidden" });

    expect(first.profileId).toBeNull();
    expect(second.profileId).toBe("work");
    expect(first.tightest?.usedPercent).toBe(57);
    expect(second.tightest?.usedPercent).toBe(82);
    expect(sample?.segmentKeys).toEqual(["codex:", "codex:work"]);
  });

  it("keeps provider count, order and identity fields", () => {
    const sample = statusBarPreviewSample(
      clusterOf(claude, codex, codexWork),
      NOW,
    );
    const segments = segmentsOf(sample?.cluster ?? { kind: "hidden" });

    expect(segments.map(statusBarSegmentKey)).toEqual([
      "claude-code:",
      "codex:",
      "codex:work",
    ]);
    expect(segments.every((entry) => !entry.hidden)).toBe(true);
  });

  it("does not mutate its input", () => {
    const input = clusterOf(claude, codex);
    const snapshot = JSON.stringify(input);

    statusBarPreviewSample(input, NOW);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
