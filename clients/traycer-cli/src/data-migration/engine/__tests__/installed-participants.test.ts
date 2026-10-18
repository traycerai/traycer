import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_MIGRATION_PROTOCOL_VERSION } from "@traycer/protocol/config/data-migration-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installedCliBinaries,
  installedParticipantBlockers,
  regularFileSha256,
} from "../installed-participants";

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const HOST_BYTES = Buffer.from("host executable bytes");
const CLI_BYTES = Buffer.from("coordinator cli bytes");

describe("installedParticipantBlockers", () => {
  let base = "";
  let sourceRoot = "";
  let coordinator = "";

  beforeEach(async () => {
    base = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-participants-")),
    );
    sourceRoot = join(base, "source");
    await mkdir(sourceRoot);
    coordinator = join(base, "coordinator-traycer");
    await writeFile(coordinator, CLI_BYTES);
    await chmod(coordinator, 0o755);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** The slot home for a label: production is the component folder itself. */
  function slotHome(component: "host" | "cli", label: string): string {
    return label === "production"
      ? join(sourceRoot, component)
      : join(sourceRoot, component, ...label.split("/"));
  }

  function recordPath(label: string): string {
    return join(slotHome("host", label), "install", "install.json");
  }

  function cliPath(label: string): string {
    return join(slotHome("cli", label), "bin", "traycer");
  }

  type HostOptions = {
    readonly slot: string;
    readonly executablePath: string | null;
    readonly executableBytes: Buffer;
    readonly recordedSha256: string | null | "match";
    readonly runtimeVersion: string | null;
    readonly version: string;
    readonly versionJson: string | null;
  };

  const GOOD_HOST: HostOptions = {
    slot: "production",
    executablePath: null,
    executableBytes: HOST_BYTES,
    recordedSha256: "match",
    runtimeVersion: "9.9.9",
    version: "1.2.3",
    versionJson: JSON.stringify({
      version: "9.9.9",
      dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION,
    }),
  };

  /** A host slot under the source root: record, executable and version.json. */
  async function installHost(options: HostOptions): Promise<void> {
    const executable =
      options.executablePath ??
      join(slotHome("host", options.slot), "install", "bin", "traycer-host");
    await mkdir(dirname(executable), { recursive: true }).catch(
      () => undefined,
    );
    if (
      options.executablePath === null ||
      options.executablePath.startsWith(sourceRoot)
    ) {
      await writeFile(executable, options.executableBytes);
      if (options.versionJson !== null)
        await writeFile(
          join(dirname(executable), "version.json"),
          options.versionJson,
        );
    }
    const record = {
      installId: "install-1",
      version: options.version,
      runtimeVersion: options.runtimeVersion,
      platform: "linux",
      arch: "x64",
      installedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "registry", value: "test" },
      archiveSha256: null,
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "key",
      sizeBytes: options.executableBytes.length,
      executablePath: executable,
      executableSha256:
        options.recordedSha256 === "match"
          ? sha(HOST_BYTES)
          : options.recordedSha256,
    };
    await mkdir(dirname(recordPath(options.slot)), { recursive: true });
    await writeFile(recordPath(options.slot), JSON.stringify(record));
  }

  async function blockers(
    coordinatorExecutable: string | null,
  ): Promise<string[]> {
    const result = await installedParticipantBlockers({
      sourceRoot,
      platform: "posix",
      coordinatorExecutable,
    });
    return result.map((blocker) => blocker.code);
  }

  it("passes when nothing is installed", async () => {
    expect(await blockers(coordinator)).toEqual([]);
    expect(await blockers(null)).toEqual([]);
  });

  describe("host slot", () => {
    it("passes a good attested host that declares this protocol", async () => {
      await installHost(GOOD_HOST);
      expect(await blockers(coordinator)).toEqual([]);
    });

    it("falls back to the record's version when no runtime version is recorded", async () => {
      await installHost({
        ...GOOD_HOST,
        runtimeVersion: null,
        versionJson: JSON.stringify({
          version: "1.2.3",
          dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION,
        }),
      });
      expect(await blockers(coordinator)).toEqual([]);
    });

    it("participant-unreadable for a corrupt install record", async () => {
      await mkdir(dirname(recordPath("production")), { recursive: true });
      await writeFile(recordPath("production"), "{ not json");
      expect(await blockers(coordinator)).toEqual(["participant-unreadable"]);
    });

    it("participant-outside-source for an executable outside the data folder", async () => {
      await installHost({
        ...GOOD_HOST,
        executablePath: join(base, "elsewhere", "traycer-host"),
      });
      expect(await blockers(coordinator)).toEqual([
        "participant-outside-source",
      ]);
    });

    it("participant-unattested for a record without an executable digest", async () => {
      await installHost({ ...GOOD_HOST, recordedSha256: null });
      expect(await blockers(coordinator)).toEqual(["participant-unattested"]);
    });

    it("participant-changed when the executable no longer hashes to the record", async () => {
      await installHost({
        ...GOOD_HOST,
        executableBytes: Buffer.from("tampered"),
      });
      expect(await blockers(coordinator)).toEqual(["participant-changed"]);
    });

    it("participant-changed when the executable is gone", async () => {
      await installHost(GOOD_HOST);
      await rm(join(sourceRoot, "host", "install", "bin", "traycer-host"));
      expect(await blockers(coordinator)).toEqual(["participant-changed"]);
    });

    it("participant-unsupported when version.json is missing", async () => {
      await installHost({ ...GOOD_HOST, versionJson: null });
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
    });

    it("participant-unsupported when the protocol field is missing", async () => {
      await installHost({
        ...GOOD_HOST,
        versionJson: JSON.stringify({ version: "9.9.9" }),
      });
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
    });

    it("participant-unsupported for an older protocol", async () => {
      await installHost({
        ...GOOD_HOST,
        versionJson: JSON.stringify({
          version: "9.9.9",
          dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION - 1,
        }),
      });
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
    });

    it("participant-unsupported for a newer protocol", async () => {
      await installHost({
        ...GOOD_HOST,
        versionJson: JSON.stringify({
          version: "9.9.9",
          dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION + 1,
        }),
      });
      const result = await installedParticipantBlockers({
        sourceRoot,
        platform: "posix",
        coordinatorExecutable: coordinator,
      });
      expect(result.map((blocker) => blocker.code)).toEqual([
        "participant-unsupported",
      ]);
      expect(result[0]?.message).toContain("newer");
    });

    it("participant-unsupported when version.json names another version than the record", async () => {
      await installHost({
        ...GOOD_HOST,
        versionJson: JSON.stringify({
          version: "0.0.1",
          dataMigrationProtocol: DATA_MIGRATION_PROTOCOL_VERSION,
        }),
      });
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
    });
  });

  describe("CLI slot", () => {
    async function installCli(label: string, bytes: Buffer): Promise<void> {
      const path = cliPath(label);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    it("passes a CLI byte-identical to the coordinator", async () => {
      await installCli("production", CLI_BYTES);
      expect(await blockers(coordinator)).toEqual([]);
    });

    it("participant-unsupported for a different CLI", async () => {
      await installCli("production", Buffer.from("an older cli"));
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
    });

    it("participant-unsupported when the coordinator is not a packaged executable", async () => {
      await installCli("production", CLI_BYTES);
      expect(await blockers(null)).toEqual(["participant-unsupported"]);
    });

    it("judges each slot on its own", async () => {
      await installCli("production", CLI_BYTES);
      await installCli("staging", Buffer.from("other"));
      await installCli("dev", CLI_BYTES);
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
    });

    it("never executes the installed CLI (a script in the slot is only hashed)", async () => {
      const marker = join(base, "executed-marker");
      await installCli(
        "production",
        Buffer.from(`#!/bin/sh\ntouch ${marker}\n`),
      );
      await chmod(cliPath("production"), 0o755);
      expect(await blockers(coordinator)).toEqual(["participant-unsupported"]);
      await expect(realpath(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("slot inventory is read from the tree", () => {
    const DEV_SLOT_ENV = "DEV_DESKTOP_SLOT";
    let savedSlot: string | undefined;

    beforeEach(() => {
      savedSlot = process.env[DEV_SLOT_ENV];
    });

    afterEach(() => {
      if (savedSlot === undefined) delete process.env[DEV_SLOT_ENV];
      else process.env[DEV_SLOT_ENV] = savedSlot;
    });

    async function installCli(label: string, bytes: Buffer): Promise<void> {
      const path = cliPath(label);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    it.each([{ slotEnv: null }, { slotEnv: "other" }, { slotEnv: "current" }])(
      "a non-current dev-runs host without the capability blocks regardless of $slotEnv",
      async ({ slotEnv }) => {
        if (slotEnv === null) delete process.env[DEV_SLOT_ENV];
        else process.env[DEV_SLOT_ENV] = slotEnv;
        await installHost({
          ...GOOD_HOST,
          slot: "dev-runs/other",
          versionJson: JSON.stringify({ version: "9.9.9" }),
        });
        expect(await blockers(coordinator)).toEqual([
          "participant-unsupported",
        ]);
        expect(recordPath("dev-runs/other")).toBe(
          join(
            sourceRoot,
            "host",
            "dev-runs",
            "other",
            "install",
            "install.json",
          ),
        );
      },
    );

    it.each([{ slotEnv: null }, { slotEnv: "other" }, { slotEnv: "current" }])(
      "a non-current dev-runs CLI not identical to the coordinator blocks regardless of $slotEnv",
      async ({ slotEnv }) => {
        if (slotEnv === null) delete process.env[DEV_SLOT_ENV];
        else process.env[DEV_SLOT_ENV] = slotEnv;
        await installCli("dev-runs/other", Buffer.from("an old dev cli"));
        expect(cliPath("dev-runs/other")).toBe(
          join(sourceRoot, "cli", "dev-runs", "other", "bin", "traycer"),
        );
        expect(await blockers(coordinator)).toEqual([
          "participant-unsupported",
        ]);
      },
    );

    it("passes a dev-runs CLI identical to the coordinator and a good dev-runs host", async () => {
      await installCli("dev-runs/mine", CLI_BYTES);
      await installHost({ ...GOOD_HOST, slot: "dev-runs/mine" });
      expect(await blockers(coordinator)).toEqual([]);
    });

    it("checks the host/staging and host/dev slots", async () => {
      await installHost({ ...GOOD_HOST, slot: "staging", versionJson: null });
      await installHost({ ...GOOD_HOST, slot: "dev", recordedSha256: null });
      expect(await blockers(coordinator)).toEqual([
        "participant-unsupported",
        "participant-unattested",
      ]);
    });

    it.skipIf(process.platform === "win32")(
      "participant-alias for a slot folder that is a symlink",
      async () => {
        const elsewhere = join(base, "elsewhere");
        await mkdir(elsewhere);
        await symlink(elsewhere, join(sourceRoot, "cli"));
        await symlink(elsewhere, join(sourceRoot, "host"));
        expect(await blockers(coordinator)).toEqual([
          "participant-alias",
          "participant-alias",
        ]);
      },
    );

    it.skipIf(process.platform === "win32")(
      "participant-alias for a dev-runs entry that is a symlink",
      async () => {
        const elsewhere = join(base, "elsewhere");
        await mkdir(elsewhere);
        await mkdir(join(sourceRoot, "host", "dev-runs"), { recursive: true });
        await symlink(elsewhere, join(sourceRoot, "host", "dev-runs", "link"));
        expect(await blockers(coordinator)).toEqual(["participant-alias"]);
      },
    );

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "participant-unreadable for a dev-runs folder that cannot be listed",
      async () => {
        const runs = join(sourceRoot, "cli", "dev-runs");
        await mkdir(runs, { recursive: true });
        await chmod(runs, 0o000);
        try {
          expect(await blockers(coordinator)).toEqual([
            "participant-unreadable",
          ]);
        } finally {
          await chmod(runs, 0o700);
        }
      },
    );

    it("installedCliBinaries lists every installed binary with its slot label, in layout order", async () => {
      await installCli("production", CLI_BYTES);
      await installCli("dev", CLI_BYTES);
      await installCli("dev-runs/b", CLI_BYTES);
      await installCli("dev-runs/a", CLI_BYTES);
      const found = await installedCliBinaries(sourceRoot, "posix");
      expect(found.blockers).toEqual([]);
      expect(found.binaries).toEqual([
        { label: "production", path: cliPath("production") },
        { label: "dev", path: cliPath("dev") },
        { label: "dev-runs/a", path: cliPath("dev-runs/a") },
        { label: "dev-runs/b", path: cliPath("dev-runs/b") },
      ]);
    });

    it("installedCliBinaries finds nothing in an empty root", async () => {
      expect(await installedCliBinaries(sourceRoot, "posix")).toEqual({
        binaries: [],
        blockers: [],
      });
    });

    it("on win32 a traycer.exe and a traycer.cmd are both accounted for", async () => {
      const bin = join(sourceRoot, "cli", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, "traycer.exe"), "x");
      await writeFile(join(bin, "traycer.cmd"), "x");
      const found = await installedCliBinaries(sourceRoot, "win32");
      expect(found.binaries.map((binary) => binary.path)).toEqual([
        join(bin, "traycer.exe"),
        join(bin, "traycer.cmd"),
      ]);
    });

    it("regularFileSha256 hashes a regular file and refuses a link, a folder and a missing path", async () => {
      const file = join(base, "regular");
      await writeFile(file, CLI_BYTES);
      expect(await regularFileSha256(file)).toBe(sha(CLI_BYTES));
      expect(await regularFileSha256(base)).toBeNull();
      expect(await regularFileSha256(join(base, "missing"))).toBeNull();
      if (process.platform !== "win32") {
        const link = join(base, "link");
        await symlink(file, link);
        expect(await regularFileSha256(link)).toBeNull();
      }
    });
  });
});
