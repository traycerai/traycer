import { describe, expect, it } from "vitest";
import { sandboxReadinessLine } from "@/lib/sandboxes/sandbox-readiness";
import {
  durationSentence,
  READINESS_SIZE,
  READY_SENTENCE,
  readinessCatalogue,
  servedMinutes,
} from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";

const SERVED_MS = servedMinutes(7);

function line(
  warm: number | null,
  coldCreateMeasuredMs: number | null | undefined,
): string | null {
  return sandboxReadinessLine(
    readinessCatalogue({ warm, coldCreateMeasuredMs }),
    READINESS_SIZE,
  );
}

describe("sandboxReadinessLine", () => {
  it.each([1, 2, 40])(
    "says ready when %s warm slot(s) remain, whatever duration the server recorded",
    (warm) => {
      expect(line(warm, SERVED_MS)).toBe(READY_SENTENCE);
      expect(line(warm, null)).toBe(READY_SENTENCE);
      expect(line(warm, undefined)).toBe(READY_SENTENCE);
    },
  );

  it.each([0, null])(
    "falls back to the entry's served duration when the warm count is %s",
    (warm) => {
      expect(line(warm, SERVED_MS)).toBe(durationSentence(SERVED_MS));
    },
  );

  it.each([
    [0, 1],
    [20_000, 1],
    [29_999, 1],
    [30_000, 1],
    [89_999, 1],
    [90_000, 2],
    [149_999, 2],
    [150_000, 3],
    [60_000 * 11 + 29_999, 11],
  ])(
    "rounds a served %s ms to %s whole minutes, never below one",
    (servedMs, minutes) => {
      expect(line(0, servedMs)).toBe(durationSentence(servedMinutes(minutes)));
    },
  );

  it("uses the singular for exactly one minute and the plural otherwise", () => {
    expect(line(null, servedMinutes(1))).toBe(
      durationSentence(servedMinutes(1)),
    );
    expect(line(null, servedMinutes(2))).toBe(
      durationSentence(servedMinutes(2)),
    );
  });

  it.each([null, undefined])(
    "says nothing when no warm slot is reported and the measurement is %s",
    (measured) => {
      expect(line(0, measured)).toBeNull();
      expect(line(null, measured)).toBeNull();
    },
  );

  it("says nothing when the served readiness answers another region the provider also offers", () => {
    const [provider] = readinessCatalogue({
      warm: 3,
      coldCreateMeasuredMs: SERVED_MS,
    }).providers;
    const catalogue = {
      providers: [
        {
          ...provider,
          regions: [
            ...provider.regions,
            { ...provider.regions[0], id: "us-west", label: "US West" },
          ],
        },
      ],
    };

    expect(sandboxReadinessLine(catalogue, READINESS_SIZE)).toBe(
      READY_SENTENCE,
    );
    expect(
      sandboxReadinessLine(catalogue, { ...READINESS_SIZE, region: "us-west" }),
    ).toBeNull();
  });

  it("says nothing when the served readiness answers a different shape than the one staged", () => {
    const catalogue = readinessCatalogue({
      warm: 3,
      coldCreateMeasuredMs: SERVED_MS,
    });
    expect(
      sandboxReadinessLine(catalogue, { ...READINESS_SIZE, cpus: 4 }),
    ).toBeNull();
    expect(
      sandboxReadinessLine(catalogue, { ...READINESS_SIZE, region: "eu" }),
    ).toBeNull();
    expect(sandboxReadinessLine(catalogue, null)).toBeNull();
  });
});
