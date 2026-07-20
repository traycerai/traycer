import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import devDesktop from "../dev-desktop.js";

// `dev-desktop.js` lives at <repo>/scripts/dev-desktop.js; resolve repo
// root once so the assertions can pin absolute paths inside the dev
// orchestrator's CLI argv without having to spawn anything.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CLI_ENTRY = path.join(
  REPO_ROOT,
  "clients",
  "traycer-cli",
  "src",
  "index.ts",
);

describe("dev-desktop CLI argv construction", () => {
  it("`host install` runs from source with --release + --allow-self-invocation when no cached archive is used", () => {
    expect(devDesktop.buildHostInstallArgs({ release: "1.2.3" })).toEqual([
      "run",
      CLI_ENTRY,
      "host",
      "install",
      "--release",
      "1.2.3",
      "--allow-self-invocation",
    ]);
    expect(devDesktop.buildHostInstallArgs({})).toEqual([
      "run",
      CLI_ENTRY,
      "host",
      "install",
      "--allow-self-invocation",
    ]);
  });

  it("`host install --from` installs a local archive, bypassing the network", () => {
    expect(devDesktop.buildHostInstallFromArgs("/tmp/example.tgz")).toEqual([
      "run",
      CLI_ENTRY,
      "host",
      "install",
      "--from",
      "/tmp/example.tgz",
      "--allow-self-invocation",
    ]);
  });

  it("`host uninstall` carries --all so the dev service is deregistered", () => {
    expect(devDesktop.buildHostUninstallArgs()).toEqual([
      "run",
      CLI_ENTRY,
      "host",
      "uninstall",
      "--all",
    ]);
  });

  it("`--release <version>` parses; omitted argv resolves to null (latest)", () => {
    expect(
      devDesktop.parseReleaseArg(["bun", "script", "--release", "1.2.3"]),
    ).toBe("1.2.3");
    expect(devDesktop.parseReleaseArg(["bun", "script"])).toBeNull();
  });
});

describe("dev-desktop slot resolution", () => {
  it("`--slot <name>` parses; omitted argv resolves to null", () => {
    expect(devDesktop.parseSlotArg(["bun", "script", "--slot", "foo"])).toBe(
      "foo",
    );
    expect(devDesktop.parseSlotArg(["bun", "script"])).toBeNull();
  });

  it("derives a deterministic sanitized slot from the repo root when no override is given", async () => {
    const slotA = await devDesktop.resolveDevDesktopSlot(
      ["bun", "script"],
      {},
    );
    const slotB = await devDesktop.resolveDevDesktopSlot(
      ["bun", "script"],
      {},
    );
    expect(slotA).toBe(slotB);
    expect(slotA).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/);
  });

  it("prefers an explicit --slot over DEV_DESKTOP_SLOT, and sanitizes either", async () => {
    expect(
      await devDesktop.resolveDevDesktopSlot(
        ["bun", "script", "--slot", "My Custom Slot!!"],
        { DEV_DESKTOP_SLOT: "env-slot" },
      ),
    ).toBe("my-custom-slot");
    expect(
      await devDesktop.resolveDevDesktopSlot(["bun", "script"], {
        DEV_DESKTOP_SLOT: "Env Slot",
      }),
    ).toBe("env-slot");
  });
});

describe("dev-desktop port allocation", () => {
  it("preferredPortForSlot is deterministic per slot and differs across slots", () => {
    const a1 = devDesktop.preferredPortForSlot("slot-a");
    const a2 = devDesktop.preferredPortForSlot("slot-a");
    const b = devDesktop.preferredPortForSlot("slot-b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toBeGreaterThanOrEqual(19000);
    expect(a1).toBeLessThan(23000);
  });
});

describe("dev-desktop concurrent stack entries", () => {
  it("passes the dev slot + renderer port to Desktop and tails the run-specific host log", () => {
    const entries = devDesktop.buildDevDesktopEntries(
      "/tmp/traycer/example-slot/host.log",
      "example-slot",
      19123,
    );
    const electronEntry = entries.find((e) => e.name === "electron");
    const hostEntry = entries.find((e) => e.name === "host");
    expect(electronEntry).toBeDefined();
    expect(electronEntry.command).toBe(
      "DEV_DESKTOP_SLOT='example-slot' PORT='19123' bun run --cwd clients/desktop dev",
    );
    expect(hostEntry?.command).toContain(
      "/tmp/traycer/example-slot/host.log",
    );
  });

  it("makes concurrent shutdown triggers await the same teardown", async () => {
    let finishTeardown;
    const onTeardown = vi.fn(
      () =>
        new Promise((resolve) => {
          finishTeardown = resolve;
        }),
    );
    const teardown = devDesktop.createTeardown(onTeardown);

    const first = teardown();
    const second = teardown();

    expect(onTeardown).toHaveBeenCalledOnce();
    expect(second).toBe(first);

    finishTeardown();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe("dev-desktop slot env for CLI subprocess calls", () => {
  it("carries DEV_DESKTOP_SLOT alongside the rest of process.env", () => {
    const env = devDesktop.buildDevDesktopSlotEnv("example-slot");
    expect(env.DEV_DESKTOP_SLOT).toBe("example-slot");
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe("dev-desktop host archive cache", () => {
  it("findCachedArchive returns null when no cache dir exists for the version", () => {
    expect(devDesktop.findCachedArchive("0.0.0-does-not-exist")).toBeNull();
  });
});

describe("dev-desktop same-slot live guard", () => {
  it("isProcessAlive is true for the current process and false for a bogus pid", () => {
    expect(devDesktop.isProcessAlive(process.pid)).toBe(true);
    expect(devDesktop.isProcessAlive(2147483647)).toBe(false);
    expect(devDesktop.isProcessAlive(0)).toBe(false);
    expect(devDesktop.isProcessAlive(-1)).toBe(false);
  });

  it("readHostPidMetadata returns null for a missing or malformed pid.json", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-desktop-hosthome-"));
    try {
      expect(devDesktop.readHostPidMetadata(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, "pid.json"), "not json");
      expect(devDesktop.readHostPidMetadata(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readHostPidMetadata returns the parsed pid when present and well-formed", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-desktop-hosthome-"));
    try {
      fs.writeFileSync(
        path.join(dir, "pid.json"),
        JSON.stringify({ pid: process.pid }),
      );
      expect(devDesktop.readHostPidMetadata(dir)).toEqual({
        pid: process.pid,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertSlotNotActive is a no-op when no pid.json exists", () => {
    expect(() =>
      devDesktop.assertSlotNotActive("my-slot", "/nonexistent/host/home"),
    ).not.toThrow();
  });

  it("assertSlotNotActive is a no-op when pid.json references a dead pid", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-desktop-hosthome-"));
    try {
      fs.writeFileSync(
        path.join(dir, "pid.json"),
        JSON.stringify({ pid: 2147483647 }),
      );
      expect(() =>
        devDesktop.assertSlotNotActive("my-slot", dir),
      ).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assertSlotNotActive throws a clear, actionable error when the slot's host is live", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-desktop-hosthome-"));
    try {
      fs.writeFileSync(
        path.join(dir, "pid.json"),
        JSON.stringify({ pid: process.pid }),
      );
      expect(() => devDesktop.assertSlotNotActive("my-slot", dir)).toThrow(
        /already active for slot "my-slot".*--slot/s,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
