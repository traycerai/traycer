import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI_ERROR_CODES,
  EXPECTED_CLI_ERROR_CODES,
  toCliError,
} from "../../runner/errors";
import { withCliUpdateContenderContext } from "../update-contender";

// The contender's first write is `mkdir(hostHomeDir, { recursive: true })`.
// When a regular file sits on that path (TRAYCER-CLI-CY: `host restart` on
// Windows), Node rejects with ENOTDIR - or EEXIST when the file IS the
// target - and the runner reported it to Sentry as E_UNEXPECTED. A file where
// a folder belongs is the machine's state, not a CLI fault.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "traycer-home-unusable-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function restartContenderAt(hostHomeDir: string): Promise<unknown> {
  try {
    await withCliUpdateContenderContext(
      {
        environment: "production",
        hostHomeDir,
        reason: "host-restart",
        waitMs: 0,
        pollIntervalMs: 0,
        admission: "recovery-maintenance",
      },
      () => Promise.resolve("ran"),
    );
  } catch (error) {
    return error;
  }
  return null;
}

describe("withCliUpdateContenderContext - a file where the host home belongs", () => {
  it.each([
    ["an ancestor of the host home is a file (ENOTDIR)", "data-folder", "host"],
    ["the host home itself is a file (EEXIST)", "host", null],
  ])(
    "%s is an expected refusal naming the recovery",
    async (_, name, child) => {
      const blocker = join(root, name);
      await writeFile(blocker, "not a folder");
      const hostHomeDir = child === null ? blocker : join(blocker, child);

      const thrown = await restartContenderAt(hostHomeDir);

      const cliError = toCliError(thrown);
      expect(cliError.code).toBe(CLI_ERROR_CODES.HOST_HOME_UNUSABLE);
      expect(EXPECTED_CLI_ERROR_CODES.has(cliError.code)).toBe(true);
      expect(cliError.exitCode).toBe(1);
      // The message names the remedy and carries no path: the account's user
      // name is part of it.
      expect(cliError.message).toMatch(/rename or remove/i);
      expect(cliError.message).not.toContain(root);
    },
  );
});
