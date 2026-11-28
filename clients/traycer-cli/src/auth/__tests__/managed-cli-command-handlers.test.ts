import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_CLI_AUTH_PATH } from "@traycer/protocol/host/managed-cli-auth";
import { loginCommand, buildLoginCommand } from "../../commands/login";
import { logoutCommand } from "../../commands/logout";
import { whoamiCommand, whoamiLocalCommand } from "../../commands/whoami";
import {
  hostHomeDir,
  cliCredentialsPath,
  hostPidMetadataPath,
} from "../../store/paths";
import { resolveRuntimeContext } from "../../runner/runtime";
import { createOutput } from "../../runner/output";
import type { CommandContext } from "../../runner/runner";
import * as loginFlow from "../login-flow";
import * as installAuth from "../../host/install-auth";
import { config } from "../../config";
import { buildProgramWithAgentRoles } from "../../index";
import { runSignInPreflight } from "../../host/install-auth";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const exitCalls = vi.hoisted(() => ({ values: [] as number[] }));
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join: joinPath } = await import("node:path");
  if (osHome.current === "")
    osHome.current = mkdtempSync(
      joinPath(actual.tmpdir(), "managed-cli-command-home-"),
    );
  return { ...actual, homedir: () => osHome.current };
});
vi.mock("../../logger", () => ({
  createCliLogger: () => logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));
vi.mock("../../runner/exit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/exit")>();
  return {
    ...actual,
    finishAndExit: async (exitCode: number) => {
      exitCalls.values.push(exitCode);
    },
  };
});

let root = "";
const planted = {
  token: "person-access-token",
  refreshToken: "person-refresh-token",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "person-1", email: "person@example.test", name: "Person" },
};

function context(json: boolean): CommandContext {
  const runtime = resolveRuntimeContext(
    { json, quiet: false, noProgress: false, noBootstrap: false },
    {},
  );
  const output = createOutput(runtime);
  return { runtime, output, progress: (info) => output.progress(info) };
}

async function installManagedMarker(): Promise<void> {
  const directory = hostHomeDir(config.environment);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cli-auth-mode"), "managed\n");
}

async function writeMachineCredential(userId: string): Promise<string> {
  const identityDir = join(hostHomeDir(config.environment), "identity");
  await mkdir(identityDir, { recursive: true });
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ aud: "host", hostId: "host", id: userId })).toString("base64url")}.sig`;
  await writeFile(
    join(identityDir, "device-credentials.json"),
    JSON.stringify({ token, refreshToken: null }),
  );
  return token;
}

function findCommand(parent: Command, name: string): Command | null {
  return parent.commands.find((command) => command.name() === name) ?? null;
}

beforeEach(async () => {
  exitCalls.values.length = 0;
  root = join(osHome.current, randomUUID());
  await mkdir(root, { recursive: true });
  osHome.current = root;
  await installManagedMarker();
  vi.spyOn(loginFlow, "runDeviceAuthFlow").mockRejectedValue(
    new Error("OAuth must not run"),
  );
  vi.spyOn(installAuth, "provisionRunningHostCredential").mockRejectedValue(
    new Error("host credential provisioning must not run"),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("managed machine CLI authentication command handlers", () => {
  it("ignores a planted person credential and reports only the machine account claim locally", async () => {
    await writeMachineCredential("machine-user");
    await mkdir(dirname(cliCredentialsPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      cliCredentialsPath(config.environment),
      JSON.stringify(planted),
    );
    const result = await whoamiLocalCommand(context(false));
    expect(result.data).toMatchObject({
      status: "stored",
      validated: false,
      credentialUpdate: "none",
      identity: { kind: "user", id: "machine-user" },
    });
    expect(JSON.stringify(result.data)).not.toContain("person-1");
  });

  it.each([
    ["interactive login", loginCommand],
    ["stdin token login", buildLoginCommand({ token: "-" })],
    ["literal --token login", buildLoginCommand({ token: "person-secret" })],
  ])(
    "refuses %s before reading or writing personal sign-in state",
    async (_label, command) => {
      await mkdir(dirname(cliCredentialsPath(config.environment)), {
        recursive: true,
      });
      await writeFile(
        cliCredentialsPath(config.environment),
        JSON.stringify(planted),
      );
      const before = await readFile(
        cliCredentialsPath(config.environment),
        "utf8",
      );
      const result = await command(context(false));
      expect(result.data).toMatchObject({ status: "waiting" });
      expect(
        await readFile(cliCredentialsPath(config.environment), "utf8"),
      ).toBe(before);
      expect(loginFlow.runDeviceAuthFlow).not.toHaveBeenCalled();
      expect(installAuth.provisionRunningHostCredential).not.toHaveBeenCalled();
    },
  );

  it("refuses logout before it mutates personal credentials", async () => {
    await mkdir(dirname(cliCredentialsPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      cliCredentialsPath(config.environment),
      JSON.stringify(planted),
    );
    const before = await readFile(
      cliCredentialsPath(config.environment),
      "utf8",
    );
    await expect(logoutCommand(context(false))).rejects.toMatchObject({
      code: "E_AUTH_REJECTED",
    });
    expect(await readFile(cliCredentialsPath(config.environment), "utf8")).toBe(
      before,
    );
  });

  it("keeps inline ensure, install, and service sign-in preflight managed", async () => {
    await mkdir(dirname(cliCredentialsPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      cliCredentialsPath(config.environment),
      JSON.stringify(planted),
    );
    const before = await readFile(
      cliCredentialsPath(config.environment),
      "utf8",
    );
    const preflight = await runSignInPreflight(context(false), false);
    expect(preflight).toEqual({ state: "managed", reason: null });
    expect(await readFile(cliCredentialsPath(config.environment), "utf8")).toBe(
      before,
    );
    expect(loginFlow.runDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("requires a live local host for validating whoami and uses the host account door", async () => {
    await writeMachineCredential("machine-user");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no running host"));
    const result = await whoamiCommand(context(false));
    expect(result.data).toMatchObject({
      status: "stopped",
      validated: false,
      credentialUpdate: "none",
    });
    expect(result.human).toContain("traycer host ensure");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(MANAGED_CLI_AUTH_PATH).toBe("/cli-auth/v1");
  });

  it("validates whoami through the confirmed local host using only its host bearer", async () => {
    const hostToken = await writeMachineCredential("machine-user");
    await mkdir(dirname(cliCredentialsPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      cliCredentialsPath(config.environment),
      JSON.stringify(planted),
    );
    await mkdir(dirname(hostPidMetadataPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      hostPidMetadataPath(config.environment),
      JSON.stringify({
        pid: process.pid,
        hostId: "host",
        version: "test-host",
        websocketUrl: "ws://127.0.0.1:42831/rpc",
        startedAt: new Date().toISOString(),
      }),
    );
    const requests: Array<{
      method: string;
      authorization: string | null;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ method, authorization: headers.get("authorization") });
      if (url.pathname !== MANAGED_CLI_AUTH_PATH)
        throw new Error("unexpected endpoint");
      if (method === "HEAD") {
        return new Response(null, {
          status: 204,
          headers: { "x-traycer-host-id": "host" },
        });
      }
      return new Response(
        JSON.stringify({ kind: "user", id: "machine-user", label: "Machine" }),
        { status: 200 },
      );
    });
    const result = await whoamiCommand(context(false));
    expect(result.data).toMatchObject({
      status: "valid",
      validated: true,
      identity: { kind: "user", id: "machine-user" },
    });
    expect(requests.map(({ method }) => method)).toEqual(["HEAD", "GET"]);
    expect(
      requests.filter(({ authorization }) => authorization !== null),
    ).toEqual([{ method: "GET", authorization: `Bearer ${hostToken}` }]);
    expect(
      requests.every(
        ({ authorization }) => authorization !== `Bearer ${planted.token}`,
      ),
    ).toBe(true);
  });

  it("keeps ordinary local whoami at no-credentials even when host identity bytes exist", async () => {
    const markerPath = join(hostHomeDir(config.environment), "cli-auth-mode");
    await rm(markerPath, { force: true });
    await mkdir(join(hostHomeDir(config.environment), "identity"), {
      recursive: true,
    });
    await writeFile(
      join(
        hostHomeDir(config.environment),
        "identity",
        "device-credentials.json",
      ),
      JSON.stringify({ token: "host-owned-bytes", refreshToken: null }),
    );
    const program = buildProgramWithAgentRoles(false);
    program.exitOverride();
    const whoami = findCommand(program, "whoami");
    if (whoami === null) throw new Error("whoami command not registered");
    whoami.exitOverride();
    let stdout = "";
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stdout +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        return true;
      });
    try {
      await program.parseAsync(["whoami", "--local", "--json"], {
        from: "user",
      });
    } finally {
      writeSpy.mockRestore();
      process.exitCode = undefined;
    }
    expect(stdout).toContain('"status":"no-credentials"');
    expect(stdout).toContain('"validated":false');
    expect(exitCalls.values).toEqual([1]);
  });
});
