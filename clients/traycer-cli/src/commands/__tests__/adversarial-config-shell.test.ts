import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Temp home for the config file (protocol paths derive from os.homedir); real fs
// probes of real temp files so the executable gate runs honestly.
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});

import { buildConfigShellAddCommand } from "../config-shell-add";
import { buildConfigShellRemoveCommand } from "../config-shell-remove";
import { buildConfigShellRevertArgsCommand } from "../config-shell-revert-args";
import { buildConfigShellSetCommand } from "../config-shell-set";
import { configShellResetCommand } from "../config-shell-reset";
import { configShellListCommand } from "../config-shell-list";
import { configShellGetCommand } from "../config-shell-get";
import { readCliConfig } from "../../store/config-store";
import { makeCtx } from "./hook-test-helpers";

const skipOnWindows = process.platform === "win32";

let workdir = "";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-adv-shell-home-"));
  workdir = await mkdtemp(join(tmpdir(), "traycer-adv-shell-bin-"));
});

async function makeExecutable(name: string): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected command data to be a record");
}

function assertRecordArray(
  value: unknown,
): asserts value is readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error("expected command data to be an array of records");
  }
}

describe("adversarial: config shell add gate", () => {
  it.skipIf(skipOnWindows)(
    "accepts a symlink that points at an executable",
    async () => {
      const target = await makeExecutable("realsh");
      const link = join(workdir, "linksh");
      await symlink(target, link);
      const result = await buildConfigShellAddCommand({ path: link })(
        makeCtx(),
      );
      expect(result.data).toEqual({
        path: link,
        entries: [{ path: link, args: null }],
      });
    },
  );

  it.skipIf(skipOnWindows)(
    "rejects a directory as a shell program",
    async () => {
      // access(dir, X_OK) succeeds for a searchable directory on POSIX, but a
      // directory is not a launchable shell program and must still be rejected.
      const dir = join(workdir, "a-directory");
      await mkdir(dir);
      await expect(
        buildConfigShellAddCommand({ path: dir })(makeCtx()),
      ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
    },
  );
});

describe("adversarial: relative-path rejection across mutating commands", () => {
  it("remove rejects a relative path", async () => {
    await expect(
      buildConfigShellRemoveCommand({ path: "rel/sh" })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });

  it("revert-args rejects a relative path", async () => {
    await expect(
      buildConfigShellRevertArgsCommand({ path: "rel/sh" })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });

  it("set rejects a relative --path", async () => {
    await expect(
      buildConfigShellSetCommand({ path: "rel/sh", args: null })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });

  it("set rejects an empty invocation (no path, no args, no clear)", async () => {
    await expect(
      buildConfigShellSetCommand({ path: null, args: null })(makeCtx()),
    ).rejects.toMatchObject({ code: "E_CONFIG_INVALID_VALUE" });
  });
});

describe("adversarial: revert-args no-entry is a pure no-op", () => {
  it("reverts nothing and creates no entry for an unknown absolute path", async () => {
    const result = await buildConfigShellRevertArgsCommand({
      path: "/opt/never/added",
    })(makeCtx());
    expect(result.data).toEqual({ path: "/opt/never/added", reverted: false });
    expect((await readCliConfig()).shell.entries).toEqual([]);
  });
});

describe("adversarial: JSON envelope shape stability across all seven commands", () => {
  it("each command's data field carries exactly its documented keys", async () => {
    // set (path + args)
    const shPath = await makeExecutable("myshell");
    const setRes = await buildConfigShellSetCommand({
      path: shPath,
      args: ["-i"],
    })(makeCtx());
    assertRecord(setRes.data);
    expect(Object.keys(setRes.data).sort()).toEqual(["args", "path"]);

    // get
    const getRes = await configShellGetCommand(makeCtx());
    assertRecord(getRes.data);
    expect(Object.keys(getRes.data).sort()).toEqual([
      "args",
      "path",
      "synthesised",
    ]);

    // add
    const addPath = await makeExecutable("added");
    const addRes = await buildConfigShellAddCommand({ path: addPath })(
      makeCtx(),
    );
    assertRecord(addRes.data);
    expect(Object.keys(addRes.data).sort()).toEqual(["entries", "path"]);

    // revert-args
    const revRes = await buildConfigShellRevertArgsCommand({ path: addPath })(
      makeCtx(),
    );
    assertRecord(revRes.data);
    expect(Object.keys(revRes.data).sort()).toEqual(["path", "reverted"]);

    // remove
    const rmRes = await buildConfigShellRemoveCommand({ path: addPath })(
      makeCtx(),
    );
    assertRecord(rmRes.data);
    expect(Object.keys(rmRes.data).sort()).toEqual(["path", "removed"]);

    // reset
    const resetRes = await configShellResetCommand(makeCtx());
    assertRecord(resetRes.data);
    expect(Object.keys(resetRes.data).sort()).toEqual(["reset"]);

    // list
    const listRes = await configShellListCommand(makeCtx());
    assertRecordArray(listRes.data);
    for (const row of listRes.data) {
      expect(Object.keys(row).sort()).toEqual([
        "isDefault",
        "missing",
        "name",
        "path",
        "source",
      ]);
    }
  });
});
