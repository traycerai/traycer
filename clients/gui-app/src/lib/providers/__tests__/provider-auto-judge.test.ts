import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { providersListReportsAutoJudge } from "@/lib/providers/provider-auto-judge";

/**
 * `providersListReportsAutoJudge` is the version half of
 * `providerAutoJudgeFor`'s `?? "traycer"` fallback: on `9.1`+ an absent
 * `autoJudge` means "nothing was ever chosen" and the fallback is correct; on
 * `9.0` it means "this line cannot say", and the same fallback would be a
 * guess. See the doc on the function in `provider-auto-judge.ts`.
 */
describe("providersListReportsAutoJudge", () => {
  it("is true at 9.1, the minor that introduced reporting autoJudge back", () => {
    expect(providersListReportsAutoJudge({ major: 9, minor: 1 })).toBe(true);
  });

  it("is true above 9.1, on the same major", () => {
    expect(providersListReportsAutoJudge({ major: 9, minor: 2 })).toBe(true);
  });

  it("is false at 9.0 - the line that strips the key on a within-major re-parse", () => {
    expect(providersListReportsAutoJudge({ major: 9, minor: 0 })).toBe(false);
  });

  // The major is PINNED rather than compared with `>`, so a `10.x` line -
  // whose relationship to this field is not knowable from here - must not be
  // read as "newer, therefore carries it". This is the case that would catch
  // a `version.major >= 9` typo replacing the pinned `=== 9` check.
  it("is false on a different (later) major, even with a high minor", () => {
    const laterMajor: SchemaVersion = { major: 10, minor: 5 };

    expect(providersListReportsAutoJudge(laterMajor)).toBe(false);
  });

  it("is false on an earlier major", () => {
    expect(providersListReportsAutoJudge({ major: 8, minor: 9 })).toBe(false);
  });

  it("is false when the handshake has not resolved (null) - withholds the claim rather than making one", () => {
    expect(providersListReportsAutoJudge(null)).toBe(false);
  });
});
