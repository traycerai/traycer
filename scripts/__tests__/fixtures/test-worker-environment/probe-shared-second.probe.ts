import { expect, it } from "vitest";

const absentAtModuleEvaluation =
  process.env.TRAYCER_ENV_GUARD_PROBE === undefined;
if (!absentAtModuleEvaluation) {
  throw new Error("synthetic worker probe survived the shared file boundary");
}

it("scrubs the shared worker again before the next file", () => {
  expect(absentAtModuleEvaluation).toBe(true);
  expect(process.env.TRAYCER_ENV_GUARD_PROBE === undefined).toBe(true);
});
