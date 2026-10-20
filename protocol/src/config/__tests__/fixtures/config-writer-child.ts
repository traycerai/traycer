import { setCliConfigLockTimingForTests } from "../../cli-config-lock";
import { setEnvOverride } from "../../store";

// One writer process of the multi-process stress test: COUNT sequential
// `setEnvOverride` calls, keyed `<PREFIX>_<i>`, against the config.json under
// this process's HOME.

async function main(): Promise<void> {
  const prefix = process.env.PREFIX;
  const count = Number(process.env.COUNT);
  if (prefix === undefined || !Number.isInteger(count) || count < 0) {
    throw new Error("PREFIX and COUNT are required");
  }
  // Four writers contend for one lock on a busy runner; the default 15s wait
  // is sized for a person's settings click, not for this burst.
  setCliConfigLockTimingForTests({
    waitMs: 60_000,
    pollMs: 10,
    staleAgeMs: 30_000,
  });
  for (let i = 0; i < count; i += 1) {
    await setEnvOverride(`${prefix}_${i}`, String(i));
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    process.stderr.write(
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      () => {
        process.exit(1);
      },
    );
  },
);
