import { readFileSync, writeFileSync } from "node:fs";
import { isWsl } from "./wsl";
import { log } from "./logger";

// Support-driven opt-out: set to "1" to keep WSL's kernel core dumps, e.g.
// to capture a full native core for a crash that only reproduces on one
// user's machine. Deliberately an env var, not a setting: re-enabling after
// the fact is otherwise a pre-crash, per-process `/proc/<pid>/coredump_filter`
// write across every Electron child - not something support can walk a user
// through. Whoever sets this accepts the giant-dump risk knowingly (WSL's
// `.wslconfig` `crashDumpFolder` can at least point it at a large drive).
const KEEP_KERNEL_CORE_DUMPS_ENV = "TRAYCER_KEEP_KERNEL_CORE_DUMPS";

const COREDUMP_FILTER_PATH = "/proc/self/coredump_filter";

/**
 * Suppresses kernel core dumps under WSL by clearing
 * `/proc/self/coredump_filter` - the kernel bitmask of which memory-mapping
 * kinds get serialized into a core (0 = none; the resulting core is headers
 * only, a few KB).
 *
 * Why: WSL sets `kernel.core_pattern` to pipe every core dump into its
 * `wsl-capture-crash` handler, which relays the stream to
 * `%TEMP%\wsl-crashes` on the Windows drive with a file-count cap but NO
 * size cap. A piped core cannot seek, so the kernel materializes every
 * untouched page as literal zero bytes - and an Electron process reserves
 * hundreds of GB of virtual address space (V8 sandbox + guard regions) that
 * is never backed by real memory. Observed in the field: one SIGTRAP after
 * an overnight sleep produced a 450 GB dump that filled the user's Windows
 * drive. `RLIMIT_CORE` is NOT enforced for piped cores, so `ulimit` is no
 * defense; `coredump_filter` IS honored, and is inherited across
 * `fork`/`execve`, so setting it here - before Chromium spawns any child -
 * covers every renderer/GPU/utility process too.
 *
 * Crash diagnostics are unaffected: crashpad (see `initCrashReporter`)
 * snapshots crashes via ptrace into its own minidumps and never reads
 * kernel cores. Outside WSL this is deliberately a no-op - desktop distros
 * cap core size in their own handlers (systemd-coredump/apport), and those
 * cores stay useful for local debugging.
 *
 * Must run pre-`whenReady` (see `runPreReady`) so children inherit the
 * filter; /proc is memory-backed, so the sync write cannot block on storage.
 *
 * Fail-open by design (settled in review): a failure here never blocks
 * launch. The only realistic failure is the /proc file being absent
 * (ENOENT), which means the kernel was built without ELF coredump support
 * and cannot produce the dumps we're defending against - refusing to launch
 * there would trade zero risk for a certain outage. Any other failure is
 * escalated to `log.error` after a read-back verifies whether the mask
 * actually stuck.
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
