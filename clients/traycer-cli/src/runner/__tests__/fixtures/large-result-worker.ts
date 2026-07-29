import { runCommand } from "../../runner";

// Worker for `std-write.test.ts`. Emits a `result` payload of
// `WORKER_PAYLOAD_BYTES` through the REAL runner - `createOutput` ->
// `emitResult` -> `process.exit()` - so the test exercises the actual
// write-then-exit sequence rather than a hand-rolled imitation of it.
//
// `runCommand` owns the exit, so nothing after it runs.
const payloadBytes = Number(process.env.WORKER_PAYLOAD_BYTES);
if (!Number.isInteger(payloadBytes) || payloadBytes <= 0) {
  throw new Error(
    `WORKER_PAYLOAD_BYTES must be a positive integer, got ${String(
      process.env.WORKER_PAYLOAD_BYTES,
    )}`,
  );
}

await runCommand(
  async () => ({
    // One unsplittable JSON string, mirroring `host available`, whose
    // entire listing is a single `data.manifest` blob on one line.
    data: { filler: "x".repeat(payloadBytes) },
    human: null,
    exitCode: 0,
  }),
  {
    json: true,
    quiet: false,
    noProgress: true,
    noBootstrap: true,
  },
);
