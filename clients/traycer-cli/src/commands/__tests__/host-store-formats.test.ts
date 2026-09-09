import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../runner/runner";
import type { HostInstallRecord } from "../../manifest/host-install";
import { EPIC_STATE_DIRNAME } from "../../host/chat-store-survey";

const mocks = vi.hoisted(() => ({
  hostHome: { current: "" },
  readHostInstallRecordMock: vi.fn(),
}));

// The command resolves `hostHomeDir(environment)` itself - there is no
// argument to point it at a temp dir - so `store/paths` is mocked to keep
// this hermetic, same treatment as `host-install-lock.test.ts`'s `node:os`
// redirect. `readHostInstallRecord` is mocked too: the STRICT reader
// `readInstalledDeclaredFormats` uses, unmocked, would read the operator's
// real `~/.traycer/host/production/install/install.json`.
vi.mock("../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/paths")>();
  return {
    ...actual,
    hostHomeDir: () => mocks.hostHome.current,
  };
});

vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return {
    ...actual,
    readHostInstallRecord: mocks.readHostInstallRecordMock,
  };
});

import { buildHostStoreFormatsCommand } from "../host-store-formats";

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function sampleRecord(
  overrides: Partial<HostInstallRecord>,
): HostInstallRecord {
  return {
    installId: "install-1",
    version: "1.7.2",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "1.7.2" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/nonexistent/traycer-host",
    executableSha256: null,
    ...overrides,
  };
}

async function writeStampedChatDb(
  epicId: string,
  schemaVersion: number,
): Promise<void> {
  const dir = join(mocks.hostHome.current, EPIC_STATE_DIRNAME, epicId, "chat");
  await mkdir(dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "chat.db"));
  try {
    db.exec(
      "CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO chat_db_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(schemaVersion),
    );
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  mocks.hostHome.current = await mkdtemp(
    join(tmpdir(), "host-store-formats-test-"),
  );
  mocks.readHostInstallRecordMock.mockResolvedValue(null);
});

afterEach(async () => {
  await rm(mocks.hostHome.current, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("buildHostStoreFormatsCommand", () => {
  it("reports an empty machine with no installed host", async () => {
    const command = buildHostStoreFormatsCommand();
    const result = await command(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      installedVersion: null,
      maxChatDbFormatOnDisk: null,
      epics: [],
      failures: [],
    });
  });

  it("sorts epics descending by chatDb format and reports the max", async () => {
    await writeStampedChatDb("epic-a", 8);
    await writeStampedChatDb("epic-b", 9);

    const command = buildHostStoreFormatsCommand();
    const result = await command(fakeCtx());

    const data = result.data as {
      readonly maxChatDbFormatOnDisk: number | null;
      readonly epics: readonly { epicId: string; chatDbFormat: number }[];
    };
    expect(data.maxChatDbFormatOnDisk).toBe(9);
    expect(data.epics.map((e) => e.epicId)).toEqual(["epic-b", "epic-a"]);
  });

  it("reports an unreadable store under failures and still exits 0", async () => {
    const dir = join(
      mocks.hostHome.current,
      EPIC_STATE_DIRNAME,
      "epic-bad",
      "chat",
    );
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "chat.db"), "not a sqlite file", "utf8");

    const command = buildHostStoreFormatsCommand();
    const result = await command(fakeCtx());

    expect(result.exitCode).toBe(0);
    const data = result.data as {
      readonly failures: readonly { epicId: string; reason: string }[];
    };
    expect(data.failures).toHaveLength(1);
    expect(data.failures[0]?.epicId).toBe("epic-bad");
  });

  it("carries the installed tree's own declared chatDb format", async () => {
    const executableDir = await mkdtemp(
      join(tmpdir(), "host-store-formats-declared-"),
    );
    try {
      await writeFile(
        join(executableDir, "version.json"),
        JSON.stringify({ version: "1.7.2", storeFormats: { chatDb: 9 } }),
        "utf8",
      );
      mocks.readHostInstallRecordMock.mockResolvedValue(
        sampleRecord({
          version: "1.7.2",
          executablePath: join(executableDir, "traycer-host"),
        }),
      );

      const command = buildHostStoreFormatsCommand();
      const result = await command(fakeCtx());

      const data = result.data as {
        readonly installedDeclaredChatDbFormat: number | null;
      };
      expect(data.installedDeclaredChatDbFormat).toBe(9);
    } finally {
      await rm(executableDir, { recursive: true, force: true });
    }
  });

  it("reports null installedDeclaredChatDbFormat when the tree declares nothing", async () => {
    const executableDir = await mkdtemp(
      join(tmpdir(), "host-store-formats-undeclared-"),
    );
    try {
      // No version.json at all - the ordinary state of an archive built
      // before archives declared their own formats.
      mocks.readHostInstallRecordMock.mockResolvedValue(
        sampleRecord({
          version: "1.7.2",
          executablePath: join(executableDir, "traycer-host"),
        }),
      );

      const command = buildHostStoreFormatsCommand();
      const result = await command(fakeCtx());

      const data = result.data as {
        readonly installedDeclaredChatDbFormat: number | null;
      };
      expect(data.installedDeclaredChatDbFormat).toBeNull();
    } finally {
      await rm(executableDir, { recursive: true, force: true });
    }
  });

  it("surfaces not-a-released-version as the installed formats unknown reason for an off-ladder install with no declaration", async () => {
    const executableDir = await mkdtemp(
      join(tmpdir(), "host-store-formats-offladder-"),
    );
    try {
      mocks.readHostInstallRecordMock.mockResolvedValue(
        sampleRecord({
          version: "production.1757000000000.abc1234",
          executablePath: join(executableDir, "traycer-host"),
        }),
      );

      const command = buildHostStoreFormatsCommand();
      const result = await command(fakeCtx());

      const data = result.data as {
        readonly installedFormatsUnknownReason: string | null;
      };
      expect(data.installedFormatsUnknownReason).toBe("not-a-released-version");
    } finally {
      await rm(executableDir, { recursive: true, force: true });
    }
  });
});
