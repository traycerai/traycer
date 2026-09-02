import { describe, expect, it } from "vitest";
import { readMacosKeychainPassphrase } from "../secret-providers/keychain-macos";
import { readLinuxSecretServicePassphrase } from "../secret-providers/secret-service-linux";
import { unprotectChromiumWindowsKey } from "../secret-providers/dpapi-windows";
import type {
  CommandRequest,
  CommandResult,
} from "../secret-providers/run-command";

/**
 * A `CommandRunner` fake that records every request it was handed and
 * answers with whatever the test queues up. Never spawns a process - the one
 * rule every case in this file has to hold.
 */
function fakeRunner(result: CommandResult): {
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
  readonly calls: CommandRequest[];
} {
  const calls: CommandRequest[] = [];
  const run = (request: CommandRequest): Promise<CommandResult> => {
    calls.push(request);
    return Promise.resolve(result);
  };
  return { run, calls };
}

describe("readMacosKeychainPassphrase", () => {
  it("returns the secret with a trailing newline stripped on exit code 0", async () => {
    const { run } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: "my-safe-storage-secret\n",
    });

    const result = await readMacosKeychainPassphrase("chrome", run);

    expect(result).toEqual({ ok: true, secret: "my-safe-storage-secret" });
  });

  it("returns unavailable on exit code 44 (errSecItemNotFound)", async () => {
    const { run } = fakeRunner({ kind: "exited", exitCode: 44, stdout: "" });

    const result = await readMacosKeychainPassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns denied on any other non-zero exit code", async () => {
    const { run } = fakeRunner({ kind: "exited", exitCode: 1, stdout: "" });

    const result = await readMacosKeychainPassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("returns unavailable when the runner reports timed-out", async () => {
    const { run } = fakeRunner({ kind: "timed-out" });

    const result = await readMacosKeychainPassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable when the runner reports spawn-failed", async () => {
    const { run } = fakeRunner({ kind: "spawn-failed", code: "ENOENT" });

    const result = await readMacosKeychainPassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable for an empty secret on exit code 0", async () => {
    const { run } = fakeRunner({ kind: "exited", exitCode: 0, stdout: "\n" });

    const result = await readMacosKeychainPassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("looks up the browser's own service/account, not a hardcoded one", async () => {
    const { run, calls } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: "brave-secret\n",
    });

    await readMacosKeychainPassphrase("brave", run);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected one call");
    expect(call.args).toEqual([
      "find-generic-password",
      "-w",
      "-s",
      "Brave Safe Storage",
      "-a",
      "Brave",
    ]);
  });
});

describe("readLinuxSecretServicePassphrase", () => {
  it("returns unavailable when the runner reports spawn-failed (secret-tool missing)", async () => {
    const { run } = fakeRunner({ kind: "spawn-failed", code: "ENOENT" });

    const result = await readLinuxSecretServicePassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable on empty stdout even with exit code 0", async () => {
    const { run } = fakeRunner({ kind: "exited", exitCode: 0, stdout: "" });

    const result = await readLinuxSecretServicePassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns unavailable on empty stdout that is only a trailing newline", async () => {
    const { run } = fakeRunner({ kind: "exited", exitCode: 0, stdout: "\n" });

    const result = await readLinuxSecretServicePassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns the secret with a trailing newline stripped on success", async () => {
    const { run } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: "keyring-secret\n",
    });

    const result = await readLinuxSecretServicePassphrase("chrome", run);

    expect(result).toEqual({ ok: true, secret: "keyring-secret" });
  });

  it("returns unavailable on a non-zero exit code", async () => {
    const { run } = fakeRunner({ kind: "exited", exitCode: 1, stdout: "" });

    const result = await readLinuxSecretServicePassphrase("chrome", run);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("unprotectChromiumWindowsKey", () => {
  it("returns null without invoking the CommandRunner when the blob lacks the DPAPI prefix", async () => {
    const { run, calls } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: Buffer.alloc(32, 1).toString("base64"),
    });
    const blobWithoutPrefix = Buffer.from("not-dpapi-sealed-bytes").toString(
      "base64",
    );

    const result = await unprotectChromiumWindowsKey(blobWithoutPrefix, run);

    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("passes the sealed payload via stdin, without the DPAPI prefix, and never on argv", async () => {
    const sealedTail = Buffer.from("sealed-bytes-after-prefix");
    const blob = Buffer.concat([Buffer.from("DPAPI", "latin1"), sealedTail]);
    const { run, calls } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: Buffer.alloc(32, 2).toString("base64"),
    });

    await unprotectChromiumWindowsKey(blob.toString("base64"), run);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected one call");
    expect(call.stdin).toBe(sealedTail.toString("base64"));
    for (const arg of call.args) {
      expect(arg).not.toContain(sealedTail.toString("base64"));
      expect(arg).not.toContain("DPAPI");
    }
  });

  it("accepts a 32-byte returned key", async () => {
    const blob = Buffer.concat([
      Buffer.from("DPAPI", "latin1"),
      Buffer.from("sealed"),
    ]);
    const key = Buffer.alloc(32, 7);
    const { run } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: key.toString("base64"),
    });

    const result = await unprotectChromiumWindowsKey(
      blob.toString("base64"),
      run,
    );

    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected a key");
    expect(result.equals(key)).toBe(true);
  });

  it("returns null when the returned key is not 32 bytes", async () => {
    const blob = Buffer.concat([
      Buffer.from("DPAPI", "latin1"),
      Buffer.from("sealed"),
    ]);
    const wrongLengthKey = Buffer.alloc(16, 7);
    const { run } = fakeRunner({
      kind: "exited",
      exitCode: 0,
      stdout: wrongLengthKey.toString("base64"),
    });

    const result = await unprotectChromiumWindowsKey(
      blob.toString("base64"),
      run,
    );

    expect(result).toBeNull();
  });

  it("returns null when PowerShell exits non-zero", async () => {
    const blob = Buffer.concat([
      Buffer.from("DPAPI", "latin1"),
      Buffer.from("sealed"),
    ]);
    const { run } = fakeRunner({ kind: "exited", exitCode: 1, stdout: "" });

    const result = await unprotectChromiumWindowsKey(
      blob.toString("base64"),
      run,
    );

    expect(result).toBeNull();
  });

  it("returns null when the runner reports spawn-failed or timed-out", async () => {
    const blob = Buffer.concat([
      Buffer.from("DPAPI", "latin1"),
      Buffer.from("sealed"),
    ]);

    const spawnFailed = fakeRunner({ kind: "spawn-failed", code: "ENOENT" });
    expect(
      await unprotectChromiumWindowsKey(
        blob.toString("base64"),
        spawnFailed.run,
      ),
    ).toBeNull();

    const timedOut = fakeRunner({ kind: "timed-out" });
    expect(
      await unprotectChromiumWindowsKey(blob.toString("base64"), timedOut.run),
    ).toBeNull();
  });
});
