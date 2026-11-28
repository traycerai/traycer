import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_CLI_AUTH_PATH } from "@traycer/protocol/host/managed-cli-auth";
import { loginCommand } from "../../commands/login";
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
const AUTHN_AUTHORITY = "https://auth-fixture.example.test";
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

async function writeMachineCredential(
  userId: string,
  expiresAt: number,
): Promise<string> {
  const identityDir = join(hostHomeDir(config.environment), "identity");
  await mkdir(identityDir, { recursive: true });
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ aud: "host", hostId: "host", id: userId, exp: expiresAt })).toString("base64url")}.sig`;
  await writeFile(
    join(identityDir, "device-credentials.json"),
    JSON.stringify({ token, refreshToken: null }),
  );
  return token;
}

async function publishLiveHost(): Promise<void> {
  const path = hostPidMetadataPath(config.environment);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      hostId: "host",
      version: "test-host",
      websocketUrl: "ws://127.0.0.1:42831/rpc",
      startedAt: new Date().toISOString(),
    }),
  );
}

async function runCli(args: string[]) {
  const program = buildProgramWithAgentRoles(false);
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();
  let stdout = "";
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });
  try {
    await program.parseAsync(args, { from: "user" });
    return { stdout, exitCode: exitCalls.values.at(-1) };
  } finally {
    writeSpy.mockRestore();
    process.exitCode = undefined;
  }
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
    await writeMachineCredential(
      "machine-user",
      Math.floor(Date.now() / 1000) + 60,
    );
    await mkdir(dirname(cliCredentialsPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      cliCredentialsPath(config.environment),
      JSON.stringify(planted),
    );
    const result = await whoamiLocalCommand(context(false));
    expect(result.data).toMatchObject({
      status: "stored-managed",
      validated: false,
      credentialUpdate: "none",
      identity: { kind: "user", id: "machine-user" },
    });
    expect(JSON.stringify(result.data)).not.toContain("person-1");
  });

  it.each(["-", "person-secret"])(
    "rejects managed --token %s before stdin even when the account is available",
    async (value) => {
      await publishLiveHost();
      await writeMachineCredential(
        "machine-user",
        Math.floor(Date.now() / 1000) + 60,
      );
      const stdin = vi
        .spyOn(process.stdin, Symbol.asyncIterator)
        .mockImplementation(() => {
          throw new Error("stdin must not be read");
        });
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_input, init) =>
          init?.method === "HEAD"
            ? new Response(null, {
                status: 204,
                headers: { "x-traycer-host-id": "host" },
              })
            : new Response(
                JSON.stringify({
                  kind: "user",
                  id: "machine-user",
                  label: "Machine",
                  user: { id: "machine-user", email: "", name: "Machine" },
                  authnBaseUrl: AUTHN_AUTHORITY,
                }),
              ),
        );
      const denied = await runCli(["login", "--token", value, "--json"]);
      expect(denied.exitCode).toBe(1);
      expect(denied.stdout).toContain("Sign-in is managed for this machine.");
      expect(stdin).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(await loginCommand(context(false))).toMatchObject({
        exitCode: 0,
        human: "Signed in as Machine. Sign-in is managed for this machine.",
      });
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
    await writeMachineCredential(
      "machine-user",
      Math.floor(Date.now() / 1000) + 60,
    );
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
    const hostToken = await writeMachineCredential(
      "machine-user",
      Math.floor(Date.now() / 1000) + 60,
    );
    await mkdir(dirname(cliCredentialsPath(config.environment)), {
      recursive: true,
    });
    await writeFile(
      cliCredentialsPath(config.environment),
      JSON.stringify(planted),
    );
    await publishLiveHost();
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
        JSON.stringify({
          kind: "user",
          id: "machine-user",
          label: "Machine",
          user: { id: "machine-user", email: "", name: "Machine" },
          authnBaseUrl: AUTHN_AUTHORITY,
        }),
        { status: 200 },
      );
    });
    const result = await whoamiCommand(context(false));
    expect(result.data).toEqual({
      status: "valid",
      validated: true,
      identity: { kind: "user", id: "machine-user", label: "Machine" },
      user: { id: "machine-user", email: "", name: "Machine" },
      authnBaseUrl: AUTHN_AUTHORITY,
      credentialUpdate: "none",
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

  it.each(["absent", "malformed"] as const)(
    "keeps local whoami ordinary when the marker is %s",
    async (mode) => {
      const marker = join(hostHomeDir(config.environment), "cli-auth-mode");
      if (mode === "absent") await rm(marker, { force: true });
      else await writeFile(marker, "managed");
      await writeMachineCredential(
        "machine-user",
        Math.floor(Date.now() / 1000) + 60,
      );
      const result = await runCli(["whoami", "--local", "--json"]);
      expect(result.stdout).toContain('"status":"no-credentials"');
      expect(result.stdout).toContain('"validated":false');
      expect(result.exitCode).toBe(1);
    },
  );

  it("refuses sign-in changes when the marker cannot be read", async () => {
    const marker = join(hostHomeDir(config.environment), "cli-auth-mode");
    await rm(marker, { force: true });
    await mkdir(marker);
    const result = await runCli(["login", "--json"]);
    expect(result.stdout).toContain(
      "Could not confirm this machine's Traycer account.",
    );
    expect(result.exitCode).toBe(1);
    expect(loginFlow.runDeviceAuthFlow).not.toHaveBeenCalled();
    await expect(logoutCommand(context(false))).rejects.toMatchObject({
      code: "E_AUTH_REJECTED",
      message: "Could not confirm this machine's Traycer account.",
    });
  });

  it.each(["missing", "expired", "unreadable"] as const)(
    "reports a retryable wait without dialing for a %s record while running",
    async (state) => {
      await publishLiveHost();
      if (state === "expired")
        await writeMachineCredential(
          "machine-user",
          Math.floor(Date.now() / 1000) - 60,
        );
      if (state === "unreadable") {
        await mkdir(
          join(
            hostHomeDir(config.environment),
            "identity",
            "device-credentials.json",
          ),
          { recursive: true },
        );
      }
      const request = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected dial"));
      vi.stubEnv("TRAYCER_EPIC_ID", "fixture-epic");
      try {
        for (const command of [["whoami"], ["workspace", "list"]]) {
          const result = await runCli([...command, "--json"]);
          expect(result.exitCode).toBe(1);
          expect(result.stdout).toContain("E_HOST_UNREACHABLE");
          expect(result.stdout).toContain(
            "Waiting for this machine's Traycer account.",
          );
        }
        expect(request).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("uses the same not-running line for whoami and workspace with no process", async () => {
    vi.stubEnv("TRAYCER_EPIC_ID", "fixture-epic");
    try {
      for (const command of [["whoami"], ["workspace", "list"]]) {
        // whoami prints a result line, workspace prints an error line. Capture
        // both streams without allowing either to write to the test terminal.
        const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
        try {
          const result = await runCli(command);
          expect(result.exitCode).toBe(1);
          const human = [
            result.stdout,
            ...output.mock.calls.map(([chunk]) => String(chunk)),
          ].join("");
          expect(human).toContain(
            "Traycer is not running on this machine. Run `traycer host ensure`.",
          );
          expect(human).not.toContain("Waiting for");
        } finally {
          output.mockRestore();
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      status: 503,
      retry: true,
      expected: "Could not confirm this machine's Traycer account. Try again.",
    },
    {
      status: 401,
      retry: false,
      expected: "Could not confirm this machine's Traycer account.",
    },
  ])(
    "reports the running machine's $status verdict through whoami",
    async ({ status, retry, expected }) => {
      await publishLiveHost();
      await writeMachineCredential(
        "machine-user",
        Math.floor(Date.now() / 1000) + 60,
      );
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
        init?.method === "HEAD"
          ? new Response(null, {
              status: 204,
              headers: { "x-traycer-host-id": "host" },
            })
          : new Response(null, { status }),
      );
      const handler = await runCli(["whoami", "--json"]);
      expect(handler.exitCode).toBe(1);
      if (retry) {
        expect(handler.stdout).toContain("E_HOST_UNREACHABLE");
        expect(handler.stdout).toContain(expected);
      } else {
        expect(handler.stdout).toContain('"status":"unconfirmed"');
        expect(handler.stdout).not.toContain("Try again.");
        expect(await whoamiCommand(context(false))).toMatchObject({
          human: expected,
        });
      }
    },
  );

  it("reports a verified team without a user field", async () => {
    await publishLiveHost();
    await writeMachineCredential("fixture", Math.floor(Date.now() / 1000) + 60);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      init?.method === "HEAD"
        ? new Response(null, {
            status: 204,
            headers: { "x-traycer-host-id": "host" },
          })
        : new Response(
            JSON.stringify({ kind: "team", id: "team-1", label: "Test" }),
          ),
    );
    const result = await whoamiCommand(context(true));
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      status: "valid-team",
      identity: { kind: "team", id: "team-1", label: "Test" },
      validated: true,
      credentialUpdate: "none",
    });
  });
});
