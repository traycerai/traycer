import { expect, it } from "vitest";

const absentAtModuleEvaluation =
  process.env.TRAYCER_ENV_GUARD_PROBE === undefined;
if (!absentAtModuleEvaluation) {
  throw new Error(
    "synthetic worker probe was present during module evaluation",
  );
}

it("starts the first shared file without the synthetic probe", () => {
  expect(absentAtModuleEvaluation).toBe(true);
  expect(process.env.TRAYCER_ENV_GUARD_PROBE === undefined).toBe(true);
  process.env.TRAYCER_ENV_GUARD_PROBE = "first-file-contamination";
});
