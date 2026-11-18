import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostRpcError } from "@traycer/protocol/host-transport/remote/rpc-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetryEpisodeOutcomeUnknownError } from "../../../../shared/host-transport/retrying-messenger";

// Temp home for the config file (protocol paths derive from os.homedir); real fs
// probes of real temp files so the executable gate runs honestly.
const h = vi.hoisted(() => ({
  home: "",
  isAgentSession: vi.fn(),
  runByDesktop: vi.fn(),
  resolveHostAuth: vi.fn(),
  resolveEndpoint: vi.fn(),
  callHostRpcAtResolvedEndpoint: vi.fn(),
}));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => h.home };
});
vi.mock("../../agent-worktree-create", async (importActual) => {
  const actual =
    await importActual<typeof import("../../agent-worktree-create")>();
  return { ...actual, isAgentSession: h.isAgentSession };
});
vi.mock("../../host/update-contender", async (importActual) => {
  const actual =
    await importActual<typeof import("../../host/update-contender")>();
  return { ...actual, runByDesktop: h.runByDesktop };
});
vi.mock("../../internal/host-auth", async (importActual) => {
  const actual =
    await importActual<typeof import("../../internal/host-auth")>();
  return { ...actual, resolveHostAuth: h.resolveHostAuth };
});
vi.mock("../../internal/host-rpc", async (importActual) => {
  const actual = await importActual<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    resolveEndpoint: h.resolveEndpoint,
    callHostRpcAtResolvedEndpoint: h.callHostRpcAtResolvedEndpoint,
  };
});

import { buildConfigShellAddCommand } from "../config-shell-add";
import { buildConfigShellRemoveCommand } from "../config-shell-remove";
import { buildConfigShellRevertArgsCommand } from "../config-shell-revert-args";
import { buildConfigShellSetCommand } from "../config-shell-set";
import { buildConfigEnvDeleteCommand } from "../config-env-delete";
import { buildConfigEnvGetCommand } from "../config-env-get";
import { buildConfigEnvListCommand } from "../config-env-list";
import { buildConfigEnvSetCommand } from "../config-env-set";
import { buildConfigEnvUnsetCommand } from "../config-env-unset";
import { configShellResetCommand } from "../config-shell-reset";
import { configShellListCommand } from "../config-shell-list";
import { configShellGetCommand } from "../config-shell-get";
import {
  addShell,
  getEnvOverride,
  readCliConfig,
  setEnvOverride,
  setShell,
} from "../../store/config-store";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { PLAIN_DISPATCH } from "../../internal/host-rpc";
import type { CommandContext, CommandResult } from "../../runner/runner";
import { makeCtx } from "./hook-test-helpers";

const skipOnWindows = process.platform === "win32";

let workdir = "";

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), "traycer-adv-shell-home-"));
  workdir = await mkdtemp(join(tmpdir(), "traycer-adv-shell-bin-"));
  h.isAgentSession.mockReset();
  h.isAgentSession.mockReturnValue(false);
  h.runByDesktop.mockReset();
  h.runByDesktop.mockReturnValue(false);
  h.resolveHostAuth.mockReset();
  h.resolveHostAuth.mockResolvedValue(null);
  h.resolveEndpoint.mockReset();
  h.resolveEndpoint.mockResolvedValue({
    hostId: "host-1",
    websocketUrl: "ws://127.0.0.1:4321/rpc",
  });
  h.callHostRpcAtResolvedEndpoint.mockReset();
});

async function makeExecutable(name: string): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, "#!/bin/sh\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

interface ConfigHostWriteCase {
  readonly name: string;
  readonly method: string;
  readonly params: (shellPath: string) => Readonly<Record<string, unknown>>;
  readonly response: (shellPath: string) => Readonly<Record<string, unknown>>;
  readonly seed: (shellPath: string) => Promise<void>;
  readonly invoke: (
    shellPath: string,
    ctx: CommandContext,
  ) => Promise<CommandResult>;
  readonly expectedData: (shellPath: string) => unknown;
  readonly expectedHuman: (shellPath: string) => string;
}

const HOST_AUTH = {
  token: "test-host-token",
  authnBaseUrl: "https://authn.test.invalid",
  userId: "user-1",
};

const HOST_ENDPOINT = {
  hostId: "host-1",
  websocketUrl: "ws://127.0.0.1:4321/rpc",
};

const CONFIG_HOST_WRITES: readonly ConfigHostWriteCase[] = [
  {
    name: "shell set",
    method: "config.shell.set",
    params: (shellPath) => ({
      path: shellPath,
      args: ["--requested"],
      selection: { kind: "not_stated" },
    }),
    response: (shellPath) => ({ path: shellPath, args: ["--host"] }),
    seed: async () => {
      await setShell("/bin/previous-shell", ["--file"]);
    },
    invoke: (shellPath, ctx) =>
      buildConfigShellSetCommand({ path: shellPath, args: ["--requested"] })(
        ctx,
      ),
    expectedData: (shellPath) => ({ path: shellPath, args: ["--host"] }),
    expectedHuman: (shellPath) =>
      `shell config saved (path=${shellPath}, args=["--host"])`,
  },
  {
    name: "shell reset",
    method: "config.shell.reset",
    params: () => ({}),
    response: () => ({ reset: true }),
    seed: async () => {
      await setShell("/bin/previous-shell", ["--file"]);
    },
    invoke: (_shellPath, ctx) => configShellResetCommand(ctx),
    expectedData: () => ({ reset: true }),
    expectedHuman: () =>
      "shell selection reset to the system default; remembered shells kept",
  },
  {
    name: "shell add",
    method: "config.shell.add",
    params: (shellPath) => ({
      path: shellPath,
      selection: { kind: "not_stated" },
    }),
    response: (shellPath) => ({
      path: shellPath,
      entries: [{ path: shellPath, args: null }],
    }),
    seed: async () => {
      await setShell("/bin/previous-shell", null);
    },
    invoke: (shellPath, ctx) =>
      buildConfigShellAddCommand({ path: shellPath })(ctx),
    expectedData: (shellPath) => ({
      path: shellPath,
      entries: [{ path: shellPath, args: null }],
    }),
    expectedHuman: (shellPath) =>
      `shell added and selected (path=${shellPath})`,
  },
  {
    name: "shell remove",
    method: "config.shell.remove",
    params: (shellPath) => ({
      path: shellPath,
      selection: { kind: "not_stated" },
    }),
    response: () => ({ removed: false, path: null }),
    seed: async (shellPath) => {
      await addShell(shellPath);
      await setShell("/bin/previous-shell", null);
    },
    invoke: (shellPath, ctx) =>
      buildConfigShellRemoveCommand({ path: shellPath })(ctx),
    expectedData: () => ({ removed: false, path: null }),
    expectedHuman: (shellPath) =>
      `shell not in the added list; nothing to remove (${shellPath})`,
  },
  {
    name: "shell revert-args",
    method: "config.shell.revertArgs",
    params: (shellPath) => ({
      path: shellPath,
      selection: { kind: "not_stated" },
    }),
    response: (shellPath) => ({ path: shellPath, reverted: false }),
    seed: async (shellPath) => {
      await addShell(shellPath);
      await setShell(shellPath, ["--file"]);
    },
    invoke: (shellPath, ctx) =>
      buildConfigShellRevertArgsCommand({ path: shellPath })(ctx),
    expectedData: (shellPath) => ({ path: shellPath, reverted: false }),
    expectedHuman: (shellPath) => `no stored flags to restore (${shellPath})`,
  },
  {
    name: "env set",
    method: "config.env.set",
    params: () => ({
      key: "CONFIG_TEST",
      value: "written-by-host",
    }),
    response: () => ({ key: "CONFIG_TEST", value: "host-value" }),
    seed: async () => {
      await setEnvOverride("CONFIG_TEST", "file-value");
    },
    invoke: (_shellPath, ctx) =>
      buildConfigEnvSetCommand({
        key: "CONFIG_TEST",
        value: "written-by-host",
      })(ctx),
    expectedData: () => ({ key: "CONFIG_TEST", value: "written-by-host" }),
    expectedHuman: () => "CONFIG_TEST=written-by-host",
  },
  {
    name: "env unset",
    method: "config.env.set",
    params: () => ({
      key: "CONFIG_TEST",
      value: null,
    }),
    response: () => ({ key: "CONFIG_TEST", value: null }),
    seed: async () => {
      await setEnvOverride("CONFIG_TEST", "file-value");
    },
    invoke: (_shellPath, ctx) =>
      buildConfigEnvUnsetCommand({ key: "CONFIG_TEST" })(ctx),
    expectedData: () => ({ key: "CONFIG_TEST", value: null }),
    expectedHuman: () => "unset CONFIG_TEST",
  },
  {
    name: "env delete",
    method: "config.env.delete",
    params: () => ({ key: "CONFIG_TEST" }),
    response: () => ({ deleted: true }),
    seed: async () => {
      await setEnvOverride("CONFIG_TEST", "file-value");
    },
    invoke: (_shellPath, ctx) =>
      buildConfigEnvDeleteCommand({ key: "CONFIG_TEST" })(ctx),
    expectedData: () => ({ key: "CONFIG_TEST", deleted: true }),
    expectedHuman: () => "deleted CONFIG_TEST",
  },
];

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
      // `wslHealth` is present only on a Windows wsl.exe row whose WSL cannot
      // host a terminal - a live probe of THIS machine, so the suite cannot
      // pin its presence either way without becoming machine-dependent.
      const keys = Object.keys(row)
        .filter((key) => key !== "wslHealth")
        .sort();
      expect(keys).toEqual(["isDefault", "missing", "name", "path", "source"]);
      if ("wslHealth" in row) {
        expect(["not-installed", "no-distro"]).toContain(row.wslHealth);
      }
    }
  });
});

describe("config write commands use the running host", () => {
  it.each(CONFIG_HOST_WRITES)(
    "$name sends its established request and leaves the CLI config file alone",
    async (write) => {
      const shellPath = await makeExecutable("host-shell");
      await write.seed(shellPath);
      const before = await readCliConfig();
      h.resolveHostAuth.mockResolvedValue(HOST_AUTH);
      h.resolveEndpoint.mockResolvedValue(HOST_ENDPOINT);
      h.callHostRpcAtResolvedEndpoint.mockResolvedValue(
        write.response(shellPath),
      );
      const ctx = makeCtx();

      const result = await write.invoke(shellPath, ctx);

      expect(h.callHostRpcAtResolvedEndpoint).toHaveBeenCalledTimes(1);
      expect(h.callHostRpcAtResolvedEndpoint).toHaveBeenCalledWith(
        write.method,
        write.params(shellPath),
        HOST_ENDPOINT,
        HOST_AUTH,
        PLAIN_DISPATCH,
      );
      expect(result.data).toEqual(write.expectedData(shellPath));
      expect(result.human).toBe(write.expectedHuman(shellPath));
      expect(ctx.output.humanRequired).not.toHaveBeenCalled();
      expect(await readCliConfig()).toEqual(before);
    },
  );

  it("keeps signed-out environment writes on the file road", async () => {
    const result = await buildConfigEnvSetCommand({
      key: "CONFIG_TEST",
      value: "written-to-file",
    })(makeCtx());

    expect(result.data).toEqual({
      key: "CONFIG_TEST",
      value: "written-to-file",
    });
    expect(result.human).toBe("CONFIG_TEST=written-to-file");
    expect(await getEnvOverride("CONFIG_TEST")).toBe("written-to-file");
    expect(h.resolveEndpoint).not.toHaveBeenCalled();
    expect(h.callHostRpcAtResolvedEndpoint).not.toHaveBeenCalled();
  });

  it("keeps agent-session writes on the file road", async () => {
    h.isAgentSession.mockReturnValue(true);

    const result = await buildConfigShellSetCommand({
      path: "/bin/agent-shell",
      args: ["--agent"],
    })(makeCtx());

    expect(result.data).toEqual({
      path: "/bin/agent-shell",
      args: ["--agent"],
    });
    expect((await readCliConfig()).shell).toMatchObject({
      path: "/bin/agent-shell",
      args: ["--agent"],
    });
    expect(h.resolveHostAuth).not.toHaveBeenCalled();
    expect(h.callHostRpcAtResolvedEndpoint).not.toHaveBeenCalled();
  });

  it("keeps Desktop-initiated unset on the file road", async () => {
    await setEnvOverride("CONFIG_TEST", "before-unset");
    h.runByDesktop.mockReturnValue(true);

    const result = await buildConfigEnvUnsetCommand({ key: "CONFIG_TEST" })(
      makeCtx(),
    );

    expect(result.data).toEqual({ key: "CONFIG_TEST", value: null });
    expect(await getEnvOverride("CONFIG_TEST")).toBeNull();
    expect(h.resolveHostAuth).not.toHaveBeenCalled();
    expect(h.callHostRpcAtResolvedEndpoint).not.toHaveBeenCalled();
  });

  it("runs command validation before attempting a host write", async () => {
    h.resolveHostAuth.mockResolvedValue(HOST_AUTH);

    await expect(
      buildConfigShellAddCommand({ path: "relative-shell" })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE });
    await expect(
      buildConfigEnvSetCommand({ key: "bad-key", value: "test-value" })(
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.CONFIG_INVALID_VALUE });
    await expect(
      buildConfigEnvDeleteCommand({ key: "MISSING_TEST_KEY" })(makeCtx()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CONFIG_MISSING_KEY,
      message: "(no override for MISSING_TEST_KEY)",
    });

    expect(h.resolveHostAuth).not.toHaveBeenCalled();
    expect(h.resolveEndpoint).not.toHaveBeenCalled();
    expect(h.callHostRpcAtResolvedEndpoint).not.toHaveBeenCalled();
  });

  it("keeps shell and environment reads file-backed when signed in", async () => {
    const shellPath = await makeExecutable("file-shell");
    await setShell(shellPath, ["--file"]);
    await setEnvOverride("CONFIG_TEST", "file-value");
    h.resolveHostAuth.mockResolvedValue(HOST_AUTH);

    const shell = await configShellGetCommand(makeCtx());
    const shells = await configShellListCommand(makeCtx());
    const env = await buildConfigEnvGetCommand({ key: "CONFIG_TEST" })(
      makeCtx(),
    );
    const environment = await buildConfigEnvListCommand()(makeCtx());

    expect(shell.data).toMatchObject({ path: shellPath, args: ["--file"] });
    expect(shells.data).toContainEqual(
      expect.objectContaining({ path: shellPath }),
    );
    expect(env.data).toEqual({ key: "CONFIG_TEST", value: "file-value" });
    expect(environment.data).toContainEqual({
      key: "CONFIG_TEST",
      value: "file-value",
    });
    expect(h.resolveHostAuth).not.toHaveBeenCalled();
    expect(h.resolveEndpoint).not.toHaveBeenCalled();
    expect(h.callHostRpcAtResolvedEndpoint).not.toHaveBeenCalled();
  });

  it("preserves the bare viewer refusal and never falls back to the file", async () => {
    await setEnvOverride("CONFIG_TEST", "before-refusal");
    const before = await readCliConfig();
    h.resolveHostAuth.mockResolvedValue(HOST_AUTH);
    h.callHostRpcAtResolvedEndpoint.mockRejectedValue(
      new HostRpcError({
        code: "E_ROLE_FORBIDDEN",
        message: "E_ROLE_FORBIDDEN",
        requestId: "request-1",
        method: "config.env.set",
        fatalDetails: null,
      }),
    );

    await expect(
      buildConfigEnvSetCommand({
        key: "CONFIG_TEST",
        value: "must-not-fallback",
      })(makeCtx()),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.ROLE_FORBIDDEN,
      message: "traycer: E_ROLE_FORBIDDEN",
    });

    expect(await readCliConfig()).toEqual(before);
  });

  it("does not file-fallback when the host write outcome is unknown", async () => {
    await setEnvOverride("CONFIG_TEST", "before-unknown-outcome");
    const before = await readCliConfig();
    h.resolveHostAuth.mockResolvedValue(HOST_AUTH);
    h.callHostRpcAtResolvedEndpoint.mockRejectedValue(
      new RetryEpisodeOutcomeUnknownError(
        new HostRpcError({
          code: "E_ROLE_FORBIDDEN",
          message: "E_ROLE_FORBIDDEN",
          requestId: "request-2",
          method: "config.env.delete",
          fatalDetails: null,
        }),
      ),
    );

    await expect(
      buildConfigEnvDeleteCommand({ key: "CONFIG_TEST" })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.ROLE_FORBIDDEN });

    expect(await readCliConfig()).toEqual(before);
  });
});
