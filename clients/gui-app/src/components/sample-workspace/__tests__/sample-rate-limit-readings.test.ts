import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "@traycer/protocol/host";
import { sampleProviderRateLimits } from "@/components/sample-workspace/sample-rate-limit-readings";
import { sampleUsageReading } from "@/components/sample-workspace/sample-workspace-scene";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

const NOW = 1_700_000_000_000;
const MINUTE_MS = 60_000;
const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;
const MONTH = 30 * 24 * 60;

/**
 * `sampleProviderRateLimits` returns the whole union regardless of the
 * provider literal passed in, so a test that reads a provider-specific field
 * (grok's `period`, cursor's `cursorModels`) needs this narrowing first.
 */
function isProvider<Provider extends ProviderRateLimits["provider"]>(
  result: ProviderRateLimits | null,
  provider: Provider,
): result is Extract<ProviderRateLimits, { provider: Provider }> {
  return result !== null && result.provider === provider;
}

/**
 * Mirrors the source's own `sampleWindow`: the reading table's percentage for
 * this slot, and the reset placed where that much use of a window this long
 * would put it. Verifies the wiring (which slot each field reads, which
 * duration it carries) against the shared reading table, not a re-derivation
 * of the table itself.
 */
function expectedWindow(slot: number, durationMinutes: number) {
  const { usedPercent } = sampleUsageReading(slot);
  const resetsInMinutes = Math.round(
    (durationMinutes * (100 - usedPercent)) / 100,
  );
  return {
    usedPercent,
    durationMinutes,
    resetsAt: NOW + resetsInMinutes * MINUTE_MS,
  };
}

describe("sampleProviderRateLimits - windowed providers", () => {
  it("gives claude-code all four fixed windows, each the next slot along", () => {
    const claude = sampleProviderRateLimits("claude-code", 0, NOW);

    expect(claude).toMatchObject({
      provider: "claude-code",
      available: true,
      fiveHour: expectedWindow(0, FIVE_HOURS),
      sevenDay: expectedWindow(1, WEEK),
      sevenDayOpus: expectedWindow(2, WEEK),
      sevenDaySonnet: expectedWindow(3, WEEK),
      modelScoped: [],
    });
  });

  it("gives codex its two fixed windows and no extras", () => {
    const codex = sampleProviderRateLimits("codex", 0, NOW);

    expect(codex).toMatchObject({
      provider: "codex",
      available: true,
      primary: expectedWindow(0, FIVE_HOURS),
      secondary: expectedWindow(1, WEEK),
      extraWindows: [],
    });
  });

  it("gives opencode all three fixed windows, each ok", () => {
    const opencode = sampleProviderRateLimits("opencode", 0, NOW);

    expect(opencode).toMatchObject({
      provider: "opencode",
      available: true,
      fiveHour: { ...expectedWindow(0, FIVE_HOURS), status: "ok" },
      weekly: { ...expectedWindow(1, WEEK), status: "ok" },
      monthly: { ...expectedWindow(2, MONTH), status: "ok" },
    });
  });

  it("gives grok its one period window, with periodEnd matching it", () => {
    const grok = sampleProviderRateLimits("grok", 0, NOW);
    if (!isProvider(grok, "grok")) throw new Error("expected grok");

    expect(grok).toMatchObject({
      provider: "grok",
      available: true,
      period: expectedWindow(0, MONTH),
    });
    expect(grok.periodEnd).toBe(grok.period?.resetsAt);
  });

  it("gives cursor both buckets, sharing one reset instant with cycleEnd", () => {
    const cursor = sampleProviderRateLimits("cursor", 0, NOW);
    if (!isProvider(cursor, "cursor")) throw new Error("expected cursor");

    expect(cursor).toMatchObject({
      provider: "cursor",
      available: true,
      cursorModels: expectedWindow(0, MONTH),
    });
    expect(cursor.otherModels?.usedPercent).toBe(
      expectedWindow(1, MONTH).usedPercent,
    );
    expect(cursor.cycleEnd).toBe(cursor.cursorModels?.resetsAt);
    expect(cursor.otherModels?.resetsAt).toBe(cursor.cycleEnd);
  });
});

describe("sampleProviderRateLimits - providers without fixed windows", () => {
  const providersWithoutFixedWindows: ReadonlyArray<RateLimitProviderId> = [
    "openrouter",
    "kilocode",
    "huggingface",
    "antigravity",
  ];

  it.each(providersWithoutFixedWindows)("is null for %s", (providerId) => {
    expect(sampleProviderRateLimits(providerId, 0, NOW)).toBeNull();
  });
});

describe("sampleProviderRateLimits - slot rotation", () => {
  it("differs between neighbouring slots", () => {
    const first = sampleProviderRateLimits("codex", 0, NOW);
    const second = sampleProviderRateLimits("codex", 1, NOW);
    if (!isProvider(first, "codex") || !isProvider(second, "codex")) {
      throw new Error("expected codex");
    }

    expect(first.primary?.usedPercent).not.toBe(second.primary?.usedPercent);
  });
});
