import { rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { acquireCliConfigLock } from "../../cli-config-lock";
import { cliConfigPath } from "../../paths";
import { readCliConfig } from "../../store";

// Plays a second Traycer process (host, CLI or desktop) that follows the
// settings-lock protocol by hand: take the lock, read config.json, tell the
// parent, and only write once the parent says `go`. The parent uses the pause
// to run its own setter against the held lock.

function waitForGo(): Promise<void> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    lines.once("line", () => {
      // Settle first: closing emits `close` synchronously.
      resolve();
      lines.close();
    });
    lines.once("close", () => {
      reject(new Error("stdin closed before `go`"));
    });
  });
}

async function main(): Promise<void> {
  const target = cliConfigPath();
  const handle = await acquireCliConfigLock(`${target}.lock`);
  const doc = await readCliConfig();
  process.stdout.write("locked\n");
  await waitForGo();
  const next = {
    ...doc,
    envOverrides: { ...doc.envOverrides, CHILD_KEY: "c" },
  };
  const tmp = `${target}.child-${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, target);
  await handle.release();
  await new Promise<void>((resolve) => {
    process.stdout.write("released\n", () => {
      resolve();
    });
  });
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
