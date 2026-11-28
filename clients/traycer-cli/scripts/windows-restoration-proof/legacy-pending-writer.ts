import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  updateCliManifest,
  writeCliManifest,
} from "legacy-windows-restoration-manifest";

async function main(): Promise<void> {
  const [rootArg, liveArg, stagedArg] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    rootArg === undefined ||
    liveArg === undefined ||
    stagedArg === undefined
  ) {
    throw new Error("An isolated Windows old-writer fixture is required");
  }
  const root = resolve(rootArg);
  const id = readFileSync(join(root, "fixture.id"), "utf8");
  const live = resolve(liveArg),
    staged = resolve(stagedArg);
  if (
    !/^[a-f0-9]{32}$/.test(id) ||
    !root.endsWith(`traycer-win-restore-${id}`) ||
    dirname(live) !== root ||
    dirname(staged) !== root ||
    live === staged
  ) {
    throw new Error("The disposable manifest locations do not match");
  }
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.DEV_DESKTOP_SLOT = `restoreproof-${id}`;
  const now = new Date().toISOString();
  await writeCliManifest("dev", {
    version: "1.4.0",
    installedAt: now,
    binaryPath: live,
    source: "manual",
    pendingUpgrade: null,
  });
  await updateCliManifest("dev", {
    pendingUpgrade: {
      version: "1.5.0",
      stagedBinaryPath: staged,
      stagedAt: now,
      reason: "binary-locked",
      allowDowngrade: false,
    },
  });
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "The old writer failed",
  );
  process.exitCode = 1;
});
