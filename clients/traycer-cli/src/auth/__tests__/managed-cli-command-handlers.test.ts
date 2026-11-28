import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientFrameSchema, type HostFrame } from "@traycer/protocol/framework";
import {
  MANAGED_CLI_AUTH_PATH,
  MANAGED_CLI_HOST_HEADER,
  MANAGED_CLI_RPC_PATH,
  readManagedCliOpen,
  type ManagedCliOpen,
} from "@traycer/protocol/host/managed-cli-auth";
import { loginCommand } from "../../commands/login";
import { PROCESS_PROFILE_LOGIN_IO } from "../../commands/profile-login";
import { whoamiCommand } from "../../commands/whoami";
import * as hostRpc from "../../internal/host-rpc";
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
import * as credentialProvisioning from "../../host/credential-provisioning";
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
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
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
vi.mock("../../host/cgroup-relocation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/cgroup-relocation")>();
  return {
    ...actual,
    relocateOutOfHostCgroupIfNeeded: async () => ({ kind: "not-needed" }),
  };
});
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

async function plantPersonalSignIn(): Promise<string> {
  const path = cliCredentialsPath(config.environment);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(planted));
  return path;
}

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

async function setMarker(
  mode: "managed" | "unreadable" | "absent" | "malformed",
): Promise<void> {
  if (mode === "managed") return;
  const marker = join(hostHomeDir(config.environment), "cli-auth-mode");
  if (mode === "malformed") await writeFile(marker, "managed");
  else await rm(marker);
  if (mode === "unreadable") await mkdir(marker);
}

async function writeMachineCredential(
  owner: { id: string } | { principal: "team"; teamId: string },
  expiresAt: number,
): Promise<string> {
  const identityDir = join(hostHomeDir(config.environment), "identity");
  await mkdir(identityDir, { recursive: true });
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ aud: "host", hostId: "host", ...owner, exp: expiresAt })).toString("base64url")}.sig`;
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (root !== "") await rm(root, { recursive: true, force: true });
});

describe("managed machine CLI authentication command handlers", () => {
  it.each(["-", "person-secret"])(
    "rejects managed --token %s before stdin even when the account is available",
    async (value) => {
      await publishLiveHost();
      await writeMachineCredential(
        { id: "machine-user" },
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

  it.each(["managed", "unreadable", "absent"] as const)(
    "applies the %s marker only to the shared lifecycle sign-in and enrolment steps",
    async (mode) => {
      await setMarker(mode);
      const personalPath = await plantPersonalSignIn();
      const fileRead = vi.mocked(readFile).mockClear();
      const probe = vi
        .spyOn(credentialProvisioning, "provisionInstalledHostCredential")
        .mockResolvedValue({ kind: "active", minted: false });
      const ctx = context(false);
      const preflight = await runSignInPreflight(ctx, false);
      expect(preflight).toEqual(
        mode === "absent"
          ? { state: "signed-in", reason: null }
          : mode === "managed"
            ? { state: "managed", reason: null }
            : { state: "not-checked", reason: "account-unconfirmed" },
      );
      for (const [action, authPreflight] of [
        ["install", preflight],
        ["start", null],
        ["start", preflight],
      ] as const) {
        probe.mockClear();
        const result = await installAuth.maybeProvisionCredential(
          ctx,
          action,
          authPreflight,
        );
        expect(result).toEqual(
          mode === "absent" ? { kind: "active", minted: false } : null,
        );
        if (mode === "absent") {
          expect(probe).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              auth: expect.objectContaining({ token: planted.token }),
            }),
          );
        } else {
          expect(probe).not.toHaveBeenCalled();
        }
      }
      const seen = fileRead.mock.calls
        .map(([path]) => path)
        .includes(personalPath);
      expect(seen).toBe(mode === "absent");
      expect(loginFlow.runDeviceAuthFlow).not.toHaveBeenCalled();
      expect(await readFile(personalPath, "utf8")).toBe(
        JSON.stringify(planted),
      );
    },
  );

  it("validates whoami through the confirmed local host using only its host bearer", async () => {
    const hostToken = await writeMachineCredential(
      { id: "machine-user" },
      Math.floor(Date.now() / 1000) + 60,
    );
    await plantPersonalSignIn();
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

  it.each(["managed", "unreadable", "absent", "malformed"] as const)(
    "applies the %s marker to a personal RPC and local whoami",
    async (mode) => {
      await setMarker(mode);
      const personalPath = await plantPersonalSignIn();
      await writeMachineCredential(
        { id: "machine-user" },
        Math.floor(Date.now() / 1000) + 60,
      );
      await publishLiveHost();
      vi.stubEnv("TRAYCER_AGENT_ID", undefined);
      vi.stubEnv("TRAYCER_AGENT_SESSION_CAPABILITY", undefined);
      const fileRead = vi.mocked(readFile).mockClear();
      const network = vi.spyOn(globalThis, "fetch");
      const rpc = vi
        .spyOn(hostRpc, "callHostRpcAtResolvedEndpoint")
        .mockResolvedValue({
          roomInfo: null,
          task: null,
          initialTurnStarted: false,
        });
      const task = await runCli([
        "task",
        "create",
        "--message=fixture",
        "--harness=claude",
        "--model=fixture",
        "--profile=ambient",
        "--json",
      ]);
      const local = await runCli(["whoami", "--local", "--json"]);
      expect(network).not.toHaveBeenCalled();
      const ordinary = mode === "absent" || mode === "malformed";
      expect(task.exitCode).toBe(ordinary ? 0 : 1);
      expect(
        fileRead.mock.calls.filter(([path]) => path === personalPath),
      ).toHaveLength(ordinary ? 2 : 0);
      if (ordinary) {
        expect(
          rpc.mock.calls.map(([method, , , auth]) => [
            method,
            auth.token,
            auth.userId,
          ]),
        ).toEqual([["epic.create", planted.token, planted.user.id]]);
        expect(local.exitCode).toBe(0);
        expect(local.stdout).toContain('"status":"stored"');
        expect(local.stdout).toContain(planted.user.email);
      } else {
        expect(rpc).not.toHaveBeenCalled();
        expect(local.stdout).not.toContain(planted.user.email);
        if (mode === "managed") {
          expect(task.stdout).toContain("Sign-in is managed for this machine.");
          expect(local.exitCode).toBe(0);
          expect(local.stdout).toContain('"status":"stored-managed"');
          expect(local.stdout).toContain("machine-user");
        } else {
          const refusal = "Could not confirm this machine's Traycer account.";
          expect(task.stdout).toContain(refusal);
          expect(local.exitCode).toBe(1);
          expect(local.stdout).toContain(refusal);
        }
      }
    },
  );

  it.each(["managed", "unreadable"] as const)(
    "protects every personal sign-in or ownership entry with a %s marker",
    async (mode) => {
      await setMarker(mode);
      const personalPath = await plantPersonalSignIn();
      const fileRead = vi.mocked(readFile).mockClear();
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected network call"));
      const socket = vi.fn(() => {
        throw new Error("unexpected WebSocket");
      });
      vi.stubGlobal("WebSocket", socket);
      const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      try {
        for (const [args, accountReport] of [
          [["login"], true],
          [["login", "--token", "-"], false],
          [["login", "--token", "fixture"], false],
          [["logout"], false],
          [["whoami"], true],
          [["link-phone"], false],
          [["host", "claim", "--yes"], false],
          [["host", "use", "fixture-team"], false],
          [["host", "install", "--team", "fixture-team"], false],
          [["host", "ensure", "--team", "fixture-team"], false],
        ] as const) {
          exitCalls.values.length = 0;
          const result = await runCli([...args, "--json"]);
          expect(result.exitCode, args.join(" ")).toBe(1);
          expect(result.stdout, args.join(" ")).toContain(
            mode === "unreadable"
              ? "Could not confirm this machine's Traycer account."
              : accountReport
                ? '"status":"stopped"'
                : "Sign-in is managed for this machine.",
          );
        }
      } finally {
        if (tty === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
        else Object.defineProperty(process.stdin, "isTTY", tty);
      }
      expect(fileRead.mock.calls.map(([path]) => path)).not.toContain(
        personalPath,
      );
      expect(network).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
      expect(loginFlow.runDeviceAuthFlow).not.toHaveBeenCalled();
      expect(await readFile(personalPath, "utf8")).toBe(
        JSON.stringify(planted),
      );
    },
  );

  it.each(["managed", "unreadable", "absent"] as const)(
    "uses the personal provider sign-in fallback only with an absent marker (%s)",
    async (mode) => {
      await setMarker(mode);
      const personalPath = await plantPersonalSignIn();
      const fileRead = vi.mocked(readFile).mockClear();
      const operationId = "6f1c1d2e-4c0e-4d7a-9a55-3a1c0d6a8b11";
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_input, init) => {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Bearer ${planted.token}`,
          );
          return new Response(
            JSON.stringify({ operationId, endsAt: 1_700_000_000_000 }),
          );
        });
      const record =
        PROCESS_PROFILE_LOGIN_IO.signInRequests.recordSignInRequest(
          {
            operationId,
            environmentId: "fixture-environment",
            sourceHostId: "fixture-host",
            sourceSharingGeneration: 1,
            harnessId: "claude-code",
          },
          new AbortController().signal,
        );
      if (mode === "absent") {
        await expect(record).resolves.toEqual({ kind: "recorded" });
        expect(network).toHaveBeenCalledTimes(1);
        expect(fileRead.mock.calls.map(([path]) => path)).toContain(
          personalPath,
        );
      } else {
        await expect(record).rejects.toMatchObject({
          code: "E_AUTH_REJECTED",
          exitCode: 1,
          message:
            mode === "managed"
              ? "Sign-in is managed for this machine."
              : "Could not confirm this machine's Traycer account.",
        });
        expect(network).not.toHaveBeenCalled();
        expect(fileRead.mock.calls.map(([path]) => path)).not.toContain(
          personalPath,
        );
      }
    },
  );

  it.each(["fixture-live-task-capability", ""] as const)(
    "writes the team's live workspace open with session capability %s",
    async (capability) => {
      const taskId = "fixture-epic";
      vi.stubEnv("TRAYCER_EPIC_ID", taskId);
      vi.stubEnv("TRAYCER_AGENT_ID", "fixture-agent");
      vi.stubEnv("TRAYCER_AGENT_SESSION_CAPABILITY", capability);
      const token = await writeMachineCredential(
        { principal: "team", teamId: "fixture-team" },
        Math.floor(Date.now() / 1000) + 60,
      );
      await publishLiveHost();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(MANAGED_CLI_AUTH_PATH);
        expect(init?.method).toBe("HEAD");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return new Response(null, {
          status: 204,
          headers: { [MANAGED_CLI_HOST_HEADER]: "host" },
        });
      });
      const opens: Array<ManagedCliOpen | null> = [];
      const requests: unknown[] = [];
      class RecordingPeer extends EventTarget {
        constructor(url: string) {
          super();
          expect(new URL(url).pathname).toBe(MANAGED_CLI_RPC_PATH);
          queueMicrotask(() => this.dispatchEvent(new Event("open")));
        }
        send(data: string): void {
          const frame = clientFrameSchema.parse(JSON.parse(data));
          if (frame.kind === "open") {
            opens.push(readManagedCliOpen(frame.token));
            this.answer({
              kind: "openAck",
              manifest: frame.manifest,
              optionalManifest: frame.optionalManifest,
              capabilities: [],
            });
          } else if (frame.kind === "request") {
            requests.push({ method: frame.method, params: frame.params });
            this.answer({
              kind: "response",
              requestId: frame.requestId,
              method: frame.method,
              schemaVersion: frame.schemaVersion,
              result: { rows: [], folderlessCwd: null },
              error: null,
            });
          }
        }
        close(): void {}
        private answer(frame: HostFrame): void {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(frame) }),
            ),
          );
        }
      }
      vi.stubGlobal("WebSocket", RecordingPeer);
      const result = await runCli(["workspace", "list", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(requests).toEqual([
        { method: "worktree.listBindingsForEpic", params: { epicId: taskId } },
      ]);
      expect(opens).toEqual([{ token, taskCapability: capability || null }]);
    },
  );

  it.each(["missing", "expired", "unreadable"] as const)(
    "reports a retryable wait without dialing for a %s record while running",
    async (state) => {
      await publishLiveHost();
      if (state === "expired")
        await writeMachineCredential(
          { id: "machine-user" },
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
    const network = vi.spyOn(globalThis, "fetch");
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
      expect(network).not.toHaveBeenCalled();
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
        { id: "machine-user" },
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
    await writeMachineCredential(
      { id: "fixture" },
      Math.floor(Date.now() / 1000) + 60,
    );
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
