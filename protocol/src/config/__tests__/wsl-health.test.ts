// The probe's contract is exit-code + line-count classification, never message
// text - wsl.exe output is localised and (on older builds and the installer
// stub) UTF-16LE. Tests inject a fake runner, so no test ever spawns wsl.exe.
import { describe, expect, it } from "vitest";
import type { DetectedShell } from "../schema";
import {
  annotateWslHealth,
  decodeWslOutput,
  probeWslHealth,
} from "../wsl-health";

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

describe("annotateWslHealth", () => {
  function row(path: string, name: string): DetectedShell {
    return {
      name,
      path,
      isDefault: false,
      source: "detected",
      missing: false,
    };
  }

  it("probes each distinct wsl.exe path rather than one for the basename", async () => {
    // An added row can point at a DIFFERENT wsl.exe than System32's, with its
    // own health - answering for one with the other's verdict would flag a
    // working shell or clear a broken one.
    const asked: string[] = [];
    const rows = [
      row("C:\\Windows\\System32\\wsl.exe", "WSL"),
      row("C:\\tools\\wrapped\\wsl.exe", "WSL"),
      row("C:\\Windows\\System32\\cmd.exe", "cmd.exe"),
    ];
    const annotated = await annotateWslHealth(rows, async (path) => {
      asked.push(path);
      return path.includes("System32") ? "not-installed" : undefined;
    });

    expect(asked.sort()).toEqual(
      ["C:\\Windows\\System32\\wsl.exe", "C:\\tools\\wrapped\\wsl.exe"].sort(),
    );
    expect(annotated[0]?.wslHealth).toBe("not-installed");
    // Healthy path stays selectable; non-WSL rows are never touched.
    expect(annotated[1]?.wslHealth).toBeUndefined();
    expect(annotated[2]?.wslHealth).toBeUndefined();
  });

  it("spawns once for the same path listed twice, case-insensitively", async () => {
    const asked: string[] = [];
    const rows = [
      row("C:\\Windows\\System32\\wsl.exe", "WSL"),
      row("c:\\windows\\system32\\WSL.EXE", "WSL"),
    ];
    const annotated = await annotateWslHealth(rows, async (path) => {
      asked.push(path);
      return "no-distro";
    });

    expect(asked).toHaveLength(1);
    expect(annotated.every((r) => r.wslHealth === "no-distro")).toBe(true);
  });

  it("leaves rows unannotated when a probe rejects", async () => {
    const rows = [row("C:\\Windows\\System32\\wsl.exe", "WSL")];
    const annotated = await annotateWslHealth(rows, () =>
      Promise.reject(new Error("spawn failed")),
    );
    expect(annotated[0]?.wslHealth).toBeUndefined();
  });

  it("never probes when no row is a wsl.exe", async () => {
    const rows = [row("/bin/zsh", "zsh")];
    let called = false;
    const annotated = await annotateWslHealth(rows, async () => {
      called = true;
      return "not-installed";
    });
    expect(called).toBe(false);
    expect(annotated).toBe(rows);
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
