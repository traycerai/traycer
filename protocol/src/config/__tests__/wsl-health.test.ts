// The probe's contract is exit-code + line-count classification, never message
// text - wsl.exe output is localised and (on older builds and the installer
// stub) UTF-16LE. Tests inject a fake runner, so no test ever spawns wsl.exe.
import { describe, expect, it } from "vitest";
import { decodeWslOutput, probeWslHealth } from "../wsl-health";

const WSL = "C:\\Windows\\System32\\wsl.exe";

function runner(
  responses: Readonly<
    Record<string, { readonly ok: boolean; readonly stdout: string }>
  >,
) {
  const calls: string[] = [];
  const run = (_path: string, args: readonly string[]) => {
    const key = args.join(" ");
    calls.push(key);
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected wsl args: ${key}`);
    return Promise.resolve(response);
  };
  return { run, calls };
}

describe("probeWslHealth", () => {
  it("healthy: distro list exits 0 with at least one name", async () => {
    const { run, calls } = runner({
      "--list --quiet": { ok: true, stdout: "Ubuntu\r\n" },
    });
    expect(await probeWslHealth(WSL, run)).toBeUndefined();
    // A healthy list never needs the --status confirmation spawn.
    expect(calls).toEqual(["--list --quiet"]);
  });

  it("no-distro: list fails but --status answers", async () => {
    const { run } = runner({
      "--list --quiet": { ok: false, stdout: "" },
      "--status": { ok: true, stdout: "Default Version: 2\r\n" },
    });
    expect(await probeWslHealth(WSL, run)).toBe("no-distro");
  });

  it("not-installed: the stub fails both (usage text, exit 1)", async () => {
    const usage = "Copyright (c) Microsoft Corporation.\r\nUsage: wsl.exe\r\n";
    const { run } = runner({
      "--list --quiet": { ok: false, stdout: usage },
      "--status": { ok: false, stdout: usage },
    });
    expect(await probeWslHealth(WSL, run)).toBe("not-installed");
  });

  it("a 0-exit list with only blank lines still means no distro", async () => {
    // Defensive: some builds print an empty list rather than failing.
    const { run } = runner({
      "--list --quiet": { ok: true, stdout: "\r\n" },
      "--status": { ok: true, stdout: "Default Version: 2\r\n" },
    });
    expect(await probeWslHealth(WSL, run)).toBe("no-distro");
  });
});

describe("decodeWslOutput", () => {
  it("decodes wsl.exe's UTF-16LE output via its NUL bytes", () => {
    expect(decodeWslOutput(Buffer.from("Ubuntu\r\n", "utf16le"))).toBe(
      "Ubuntu\r\n",
    );
  });

  it("passes WSL_UTF8-honouring UTF-8 output through", () => {
    expect(decodeWslOutput(Buffer.from("Ubuntu\r\n", "utf8"))).toBe(
      "Ubuntu\r\n",
    );
  });
});
