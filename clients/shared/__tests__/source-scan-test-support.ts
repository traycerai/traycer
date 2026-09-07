import { expect } from "vitest";

 // One owner means a future fix to the offset math or the vacuous-pass guard below lands for both suites at once.

/**
 * A byte-offset slice of `sourceText` between two literal markers.
 * Fails the calling test (rather than returning an empty/undefined slice) when either marker is missing, so a renamed function or a moved comment fails loudly instead of producing a vacuously-passing empty region to scan.
 */
export function sliceFrom(
  sourceText: string,
  start: string,
  end: string | null,
): string {
  const startAt = sourceText.indexOf(start);
  expect(startAt, `missing source marker: ${start}`).toBeGreaterThan(-1);
  if (end === null) {
    return sourceText.slice(startAt);
  }
  const endAt = sourceText.indexOf(end, startAt + start.length);
  expect(endAt, `missing source marker: ${end}`).toBeGreaterThan(startAt);
  return sourceText.slice(startAt, endAt);
}

export function offsets(sourceText: string, pattern: RegExp): number[] {
  const flags = `${pattern.flags.replace(/[gy]/g, "")}g`;
  return Array.from(sourceText.matchAll(new RegExp(pattern.source, flags))).map(
    (match) => match.index ?? -1,
  );
}

/**
 * Asserts that every occurrence of `actuator` in `sourceText` is preceded - since the previous actuator occurrence (or the start of the text) - by at least one occurrence of `verifier`.
 * Non-vacuous by construction: a caller whose `actuator` pattern matches nothing (a renamed function, a moved call site, a typo'd regex) must fail this suite loudly rather than pass an empty loop silently.
 */
export function expectVerifierBeforeEvery(
  sourceText: string,
  actuator: RegExp,
  verifier: RegExp,
): void {
  const actuatorOffsets = offsets(sourceText, actuator);
  expect(
    actuatorOffsets.length,
    `expected at least one actuator match for ${actuator.source}, found none - a production rename must fail this suite, not pass it vacuously`,
  ).toBeGreaterThan(0);
  const verifierOffsets = offsets(sourceText, verifier);
  let previousActuatorOffset = -1;
  for (const actuatorOffset of actuatorOffsets) {
    expect(
      verifierOffsets.some(
        (verifierOffset) =>
          verifierOffset > previousActuatorOffset &&
          verifierOffset < actuatorOffset,
      ),
      `missing verifier before actuator at offset ${actuatorOffset}`,
    ).toBe(true);
    previousActuatorOffset = actuatorOffset;
  }
}
