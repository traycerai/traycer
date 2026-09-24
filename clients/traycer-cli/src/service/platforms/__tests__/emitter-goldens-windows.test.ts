import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// The REAL, unmocked module - for locating/reading the golden files on THIS
// host's real filesystem. `node:path`'s top-level exports are mocked to
// win32 below (for the emitter's own internal path-building), so this
// suite's own file-system bookkeeping must go through `posix` explicitly:
// using the mocked top-level `join`/`dirname` here would build a
// backslash-joined string and hand it to `readFileSync` on a POSIX host,
// which treats a leading backslash as a literal filename character, not a
// path separator - silently missing the real `emitter-goldens/` directory
// entirely.
import { posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliInvocation } from "../../cli-binary";
import { serviceLabelFor } from "../../label";

/**
 * Windows' own file, separate from `emitter-goldens.test.ts`: its goldens
 * need `node:path` to run with WIN32 semantics (backslash separators), not
 * the POSIX semantics every other file in this suite gets from whatever OS
 * runs the tests (darwin/linux - CI is Linux). Forcing `node:path` here would
 * make every OTHER path in the process backslash-separated too, which is
 * wrong for the Linux/macOS goldens - hence the split.
 *
 * `buildScheduledTaskXml`'s launcher path
 * (`hiddenHostLauncherPath` -> `cliInstallHomeDir` -> protocol's
 * `installation.ts` -> `join(homedir(), ".traycer", "cli")`) is reached
 * through several modules, all importing the bare `"node:path"` specifier -
 * this file's `vi.mock("node:path", ...)` is hoisted before every one of
 * those imports resolves, so `join`/`dirname`/etc. are win32-flavoured
 * everywhere in the graph these two emitters reach, not just in
 * `windows.ts` itself. `node:os`'s `homedir()` is mocked the same way, to
 * the Windows placeholder home, so the WHOLE resolved path - not just its
 * separators - is deterministic and platform-independent.
 */

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => PLACEHOLDER_HOME_WINDOWS,
  };
});

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    ...actual.win32,
    win32: actual.win32,
    posix: actual.posix,
    default: actual.win32,
  };
});

const PLACEHOLDER_HOME_WINDOWS = "C:\\Users\\golden-user";

const HERE = posix.dirname(fileURLToPath(import.meta.url));
const GOLDENS_DIR = posix.join(HERE, "emitter-goldens");

function golden(name: string): string {
  return readFileSync(posix.join(GOLDENS_DIR, name), "utf8");
}

const productionLabel = serviceLabelFor("production");

const windowsCli: CliInvocation = {
  command: `${PLACEHOLDER_HOME_WINDOWS}\\.traycer\\cli\\bin\\traycer.exe`,
  args: [],
};

beforeEach(async () => {
  vi.stubEnv("USERDOMAIN", "");
  vi.stubEnv("USERNAME", "golden-user");
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("SYSTEMROOT", "C:\\Windows");
  // Hermeticity (SSH-USERDOMAIN-WORKGROUP): `resolveTaskUserId` now prefers
  // a real SID from `whoami /user`, and its environment fallback also reads
  // `COMPUTERNAME`/`USERDNSDOMAIN`. On a Windows dev machine, a real
  // COMPUTERNAME or a readable SID would change the resolved `<UserId>` and
  // this golden would stop matching the checked-in file. Stub both env
  // vars empty and force the SID reader to `null` so this suite's
  // `<UserId>` stays the bare `golden-user` the golden file was written
  // against, regardless of what machine runs it.
  vi.stubEnv("COMPUTERNAME", "");
  vi.stubEnv("USERDNSDOMAIN", "");
  const { setWindowsTaskUserSidReaderForTests } = await import("../windows");
  setWindowsTaskUserSidReaderForTests(() => null);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const { setWindowsTaskUserSidReaderForTests } = await import("../windows");
  setWindowsTaskUserSidReaderForTests(null);
});

describe("Windows: buildScheduledTaskXml and buildWindowsHiddenHostLauncher (win32 path semantics)", () => {
  it("matches emitter-goldens/task.xml byte-for-byte", async () => {
    const { buildScheduledTaskXml } = await import("../windows");

    const xml = buildScheduledTaskXml({
      label: productionLabel,
      cli: windowsCli,
    });

    expect(xml).toBe(golden("task.xml"));
  });

  it("matches emitter-goldens/hidden-host-launcher.vbs byte-for-byte", async () => {
    const { buildWindowsHiddenHostLauncher } = await import("../windows");

    const vbs = buildWindowsHiddenHostLauncher(windowsCli, productionLabel);

    expect(vbs).toBe(golden("hidden-host-launcher.vbs"));
  });
});
