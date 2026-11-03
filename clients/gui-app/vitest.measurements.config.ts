import baseConfig from "./vitest.config";

// What the nightly `measurements.yml` runs: a file whose claim is a time or
// size budget at full scale, too long for the push run. A measurement is named
// `*.measure.ts`, which is why the push run's `include` does not reach it.
export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["src/**/__tests__/**/*.measure.ts"],
    // The push run's config lets a run with unhandled errors pass; the nightly
    // job has no fork-death check after it, so here a dead fork fails the run.
    dangerouslyIgnoreUnhandledErrors: false,
  },
};
