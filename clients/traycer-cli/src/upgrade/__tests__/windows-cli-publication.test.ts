import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceLabelFor } from "../../service/label";
import type { ScheduledTaskXmlQuery } from "../../service/platforms/windows";

const BOOT_MARKER = Buffer.from(
  "traycer:windows-unattended-service:1:ed362e23-7428-47cf-b857-ff24ea69d5d2\n",
  "ascii",
);
const hiddenProbe = vi.hoisted(() => ({
  errorCode: null as "EACCES" | "EPERM" | null,
  calls: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      hiddenProbe.calls += 1;
      if (hiddenProbe.errorCode !== null) {
        throw Object.assign(new Error("permission denied"), {
          code: hiddenProbe.errorCode,
        });
      }
      return actual.open(...args);
    },
  };
});
const CALLER_SID = "S-1-5-21-1234-5678-9012-1001";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let workDir: string;

function peImage(payload: Buffer): Buffer {
  const header = Buffer.alloc(68);
  header.write("MZ", 0, "ascii");
  header.writeUInt32LE(64, 0x3c);
  header.write("PE\0\0", 64, "binary");
  return Buffer.concat([header, payload]);
}

async function withBootTask<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, "platform", { value: "win32" });
  const windows = await import("../../service/platforms/windows");
  const label = serviceLabelFor("production");
  const xml = windows.buildScheduledTaskXml(
    {
      label,
      cli: { command: "C:\\Traycer\\traycer.exe", args: [] },
      windowsBootRunLevel: "HighestAvailable",
    },
    CALLER_SID,
    true,
  );
  const query: ScheduledTaskXmlQuery = { kind: "xml", xml };
  windows.setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
  windows.setWindowsTaskHiddenProbeForTests(async () => false);
  windows.setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => query,
    predictCli: async () => {
      throw new Error("predictCli should not be called");
    },
    resolveCli: async () => {
      throw new Error("resolveCli should not be called");
    },
  });
  try {
    return await run();
  } finally {
    windows.setWindowsDefinitionDepsForTests(null);
    windows.setWindowsTaskHiddenProbeForTests(null);
    windows.setWindowsTaskUserSidReaderForTests(null);
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "traycer-windows-cli-publication-"));
  hiddenProbe.errorCode = null;
  hiddenProbe.calls = 0;
});

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("admitWindowsCliPublication", () => {
  it.each(["EACCES", "EPERM"] as const)(
    "recognizes a hidden task when its definition probe reports %s",
    async (errorCode) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      hiddenProbe.errorCode = errorCode;
      const windows = await import("../../service/platforms/windows");
      windows.setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
      windows.setWindowsDefinitionDepsForTests({
        queryTaskXml: async () => ({ kind: "absent" }),
        predictCli: async () => {
          throw new Error("predictCli should not be called");
        },
        resolveCli: async () => {
          throw new Error("resolveCli should not be called");
        },
      });
      try {
        await expect(
          windows.readWindowsServiceTaskOwnership(
            serviceLabelFor("production"),
          ),
        ).resolves.toMatchObject({ kind: "not-owned", reason: "other-owner" });
        expect(hiddenProbe.calls).toBe(1);
      } finally {
        windows.setWindowsDefinitionDepsForTests(null);
        windows.setWindowsTaskUserSidReaderForTests(null);
      }
    },
  );

  it("accepts an older release only when the feed digest authenticates a PE marker split across a read boundary", async () => {
    const markerOffset = 64 * 1024 - 9;
    const payload = Buffer.concat([
      Buffer.alloc(markerOffset - 68),
      BOOT_MARKER,
    ]);
    const staged = join(workDir, "candidate.exe");
    const image = peImage(payload);
    writeFileSync(staged, image);
    const sha256 = createHash("sha256").update(image).digest("hex");
    const { admitWindowsCliPublication } =
      await import("../windows-cli-publication");

    await expect(
      withBootTask(() =>
        admitWindowsCliPublication({
          label: serviceLabelFor("production"),
          stagedBinaryPath: staged,
          currentBinaryPath: null,
          installedVersion: "1.2.0",
          candidate: { kind: "release", version: "1.1.4", sha256 },
        }),
      ),
    ).resolves.toEqual({ kind: "admitted", sha256 });
  });

  it("authenticates self-publication against the running image's complete digest", async () => {
    const staged = join(workDir, "staged-self.exe");
    const running = join(workDir, "running-self.exe");
    const image = peImage(Buffer.concat([Buffer.alloc(32), BOOT_MARKER]));
    writeFileSync(staged, image);
    writeFileSync(running, image);
    const sha256 = createHash("sha256").update(image).digest("hex");
    const { admitWindowsCliPublication } =
      await import("../windows-cli-publication");

    await expect(
      withBootTask(() =>
        admitWindowsCliPublication({
          label: serviceLabelFor("production"),
          stagedBinaryPath: staged,
          currentBinaryPath: null,
          installedVersion: "99.0.0",
          candidate: { kind: "anchor", runningBinaryPath: running },
        }),
      ),
    ).resolves.toEqual({ kind: "admitted", sha256 });
  });

  it("refuses the released option string without the authenticated capability marker", async () => {
    const staged = join(workDir, "old-cli.exe");
    const image = peImage(Buffer.from('.option("--start-at-boot", "Example")'));
    writeFileSync(staged, image);
    const sha256 = createHash("sha256").update(image).digest("hex");
    const { admitWindowsCliPublication } =
      await import("../windows-cli-publication");
    const { CLI_ERROR_CODES } = await import("../../runner/errors");

    await expect(
      withBootTask(() =>
        admitWindowsCliPublication({
          label: serviceLabelFor("production"),
          stagedBinaryPath: staged,
          currentBinaryPath: null,
          installedVersion: "1.2.0",
          candidate: { kind: "release", version: "1.1.4", sha256 },
        }),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
    });
  });

  it("refuses when the staged bytes do not match the signed feed digest", async () => {
    const staged = join(workDir, "tampered.exe");
    writeFileSync(staged, peImage(Buffer.from("tampered")));
    const { admitWindowsCliPublication } =
      await import("../windows-cli-publication");
    const { CLI_ERROR_CODES } = await import("../../runner/errors");

    await expect(
      withBootTask(() =>
        admitWindowsCliPublication({
          label: serviceLabelFor("production"),
          stagedBinaryPath: staged,
          currentBinaryPath: null,
          installedVersion: "1.2.0",
          candidate: {
            kind: "release",
            version: "1.1.4",
            sha256: "0".repeat(64),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
    });
  });

  it("recognizes byte-identical live content without requiring a new publication", async () => {
    const staged = join(workDir, "staged.exe");
    const current = join(workDir, "current.exe");
    const image = peImage(Buffer.from("same image"));
    writeFileSync(staged, image);
    writeFileSync(current, image);
    const sha256 = createHash("sha256").update(image).digest("hex");
    const { admitWindowsCliPublication } =
      await import("../windows-cli-publication");

    await expect(
      withBootTask(() =>
        admitWindowsCliPublication({
          label: serviceLabelFor("production"),
          stagedBinaryPath: staged,
          currentBinaryPath: current,
          installedVersion: "1.2.0",
          candidate: { kind: "release", version: "1.1.4", sha256 },
        }),
      ),
    ).resolves.toEqual({ kind: "identical" });
  });
});
