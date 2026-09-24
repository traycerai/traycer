import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliInvocation } from "../../cli-binary";
import { serviceLabelFor } from "../../label";

/**
 * Byte-identical pins for what the Linux and macOS install emitters write,
 * for a FIXED production label and a FIXED packaged CLI invocation.
 * Purpose: `traycer-host`'s `cli-invocation/legacy-{linux,macos}.ts` readers
 * recover the CLI invocation from exactly these bytes - the host's
 * `cli-invocation/__tests__/emitter-goldens.test.ts` (traycer-internal) reads
 * these SAME golden files out of the pinned submodule and asserts the reader
 * recovers the invocation. So the goldens
 * are the emitters' EXACT output for the fixed inputs below, and this test
 * pins emitter output === golden bytes: any emitter change forces a golden
 * update, which is the signal that the host-side pin needs the same change.
 *
 * Windows has its own file, `emitter-goldens-windows.test.ts`: its goldens
 * need `node:path` running with WIN32 semantics (backslash separators),
 * which would be wrong for the POSIX paths this file pins - see that file's
 * header.
 *
 * Every home-derived path an emitter embeds is forced through a FIXED
 * placeholder home (`/home/golden-user`) rather than the machine's real
 * home, via `node:os`'s `homedir()` - mocked once, whole-module, for this
 * file only (other test files keep their own real or independently-mocked
 * `os`). `PATH` is stubbed the same way: `buildLaunchAgentPlist` bakes the
 * install-time `$PATH` into the plist, which may not vary with whatever
 * machine happens to run this suite.
 */

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => PLACEHOLDER_HOME_POSIX,
  };
});

const PLACEHOLDER_HOME_POSIX = "/home/golden-user";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDENS_DIR = join(HERE, "emitter-goldens");

function golden(name: string): string {
  return readFileSync(join(GOLDENS_DIR, name), "utf8");
}

const productionLabel = serviceLabelFor("production");

const posixCli: CliInvocation = {
  command: `${PLACEHOLDER_HOME_POSIX}/.traycer/cli/bin/traycer`,
  args: [],
};

beforeEach(() => {
  vi.stubEnv("PATH", "/home/golden-user/bin");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Linux: buildSystemdUnit", () => {
  it("matches emitter-goldens/systemd-unit.service byte-for-byte", async () => {
    const { buildSystemdUnit } = await import("../linux");

    const unit = buildSystemdUnit({ label: productionLabel, cli: posixCli });

    expect(unit).toBe(golden("systemd-unit.service"));
  });
});

describe("macOS: buildLaunchAgentPlist and buildHostStartLauncherScript", () => {
  it("matches emitter-goldens/launch-agent.plist byte-for-byte", async () => {
    const { buildLaunchAgentPlist } = await import("../macos");

    const plist = buildLaunchAgentPlist({
      label: productionLabel,
      cli: posixCli,
    });

    expect(plist).toBe(golden("launch-agent.plist"));
  });

  it("matches emitter-goldens/host-start-launcher.sh byte-for-byte", async () => {
    const { buildHostStartLauncherScript } =
      await import("../host-start-script");

    const script = buildHostStartLauncherScript(productionLabel.id);

    expect(script).toBe(golden("host-start-launcher.sh"));
  });
});
