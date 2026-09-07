import { readFileSync, writeFileSync } from "node:fs";
import { isWsl } from "./wsl";
import { log } from "./logger";

// Deliberately an env var, not a setting: re-enabling after the fact is otherwise a pre-crash, per-process `/proc/<pid>/coredump_filter` write across every Electron child.
const KEEP_KERNEL_CORE_DUMPS_ENV = "TRAYCER_KEEP_KERNEL_CORE_DUMPS";

const COREDUMP_FILTER_PATH = "/proc/self/coredump_filter";

/**
 * A piped core cannot seek, so the kernel materializes every untouched page as literal zero bytes.
 * Crash diagnostics are unaffected: crashpad (see `initCrashReporter`) snapshots crashes via ptrace into its own minidumps and never reads kernel cores.
 */
export function suppressWslKernelCoreDumps(): void {
  if (process.platform !== "linux") {
    return;
  }
  if (process.env[KEEP_KERNEL_CORE_DUMPS_ENV] === "1") {
    log.info("[core-dump-guard] kernel core dumps kept by env override", {
      env: KEEP_KERNEL_CORE_DUMPS_ENV,
    });
    return;
  }
  if (!isWsl()) {
    return;
  }
  try {
    writeFileSync(COREDUMP_FILTER_PATH, "0");
    // /proc writes can misreport partial application; trust the file, not
    // the write. The kernel renders the mask as hex (e.g. "00000000").
    const applied = parseInt(
      readFileSync(COREDUMP_FILTER_PATH, "utf-8").trim(),
      16,
    );
    if (applied === 0) {
      log.info("[core-dump-guard] kernel core dumps suppressed under WSL");
    } else {
      log.error(
        "[core-dump-guard] coredump_filter readback mismatch - giant WSL crash dumps remain possible",
        { applied },
      );
    }
  } catch (err) {
    if (isEnoent(err)) {
      log.info(
        "[core-dump-guard] coredump_filter absent - kernel cannot produce core dumps, nothing to suppress",
      );
    } else {
      log.error(
        "[core-dump-guard] failed to clear coredump_filter - giant WSL crash dumps remain possible",
        { err },
      );
    }
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
