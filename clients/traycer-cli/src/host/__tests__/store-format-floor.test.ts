import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { EPIC_STATE_DIRNAME } from "../chat-store-survey";

const fetchTextMock = vi.fn();
vi.mock("../../registry/fetch-resource", () => ({
  fetchText: (...args: unknown[]) => fetchTextMock(...args),
}));

import {
  assertHostStoreFormatFloor,
  assertStoreFormatFloorAtCommit,
  gateStoreFormatFloor,
  STORE_FORMAT_FLOOR_LISTED_EPICS,
  ungatedStoreFormatFloorEvidence,
} from "../store-format-floor";

interface RecordedCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields;
}

function fakeLogger(): ILogger & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    debug: (message, fields) => {
      calls.push({ level: "debug", message, fields });
    },
    info: (message, fields) => {
      calls.push({ level: "info", message, fields });
    },
    warn: (message, fields) => {
      calls.push({ level: "warn", message, fields });
    },
    error: (message, fields) => {
      calls.push({ level: "error", message, fields });
    },
  };
}

let hostHome: string;

beforeEach(async () => {
  hostHome = await mkdtemp(join(tmpdir(), "store-format-floor-test-"));
  fetchTextMock.mockReset();
});

afterEach(async () => {
  await rm(hostHome, { recursive: true, force: true });
});

/**
 * A `chat.db` that FAILS to be read - garbage bytes at the expected path.
 * Used to prove "no disk walk happened": if the gate resolved despite this
 * being on disk, it never asked, because reading it would have surfaced an
 * indeterminate/blocked refusal.
 */
async function writeGarbageChatDb(epicId: string): Promise<void> {
  const dir = join(hostHome, EPIC_STATE_DIRNAME, epicId, "chat");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat.db"), "not a sqlite file", "utf8");
}

async function writeStampedChatDb(
  epicId: string,
  schemaVersion: number,
): Promise<void> {
  const dir = join(hostHome, EPIC_STATE_DIRNAME, epicId, "chat");
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

describe("assertHostStoreFormatFloor", () => {
  it("clears an upgrade without touching disk", async () => {
    await writeGarbageChatDb("epic-would-fail-if-walked");
    const logger = fakeLogger();

    await expect(
      assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.4.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        acceptStoreFormatLoss: false,
        site: "host update",
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("clears from formats alone on an rc rollback, without touching disk", async () => {
    await writeGarbageChatDb("epic-would-fail-if-walked");
    const logger = fakeLogger();

    await expect(
      assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.3.0-rc.4",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.1",
        acceptStoreFormatLoss: false,
        site: "host update",
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a downgrade whose target reads an older chat store format than one on disk", async () => {
    await writeStampedChatDb("epic-newer-store", 9);
    const logger = fakeLogger();

    let thrown: unknown;
    try {
      await assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.2.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        acceptStoreFormatLoss: false,
        site: "host install",
        logger,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.code).toBe(CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR);
    expect(err.message).toContain("1.2.0");
    expect(err.message).toContain("1.3.0-rc.4");
    expect(err.message).toContain("format 8");
    expect(err.message).toContain("epic-newer-store");
    expect(err.message).toContain("--accept-store-format-loss");
    const details = err.details as {
      readonly blockedEpics: readonly {
        readonly epicId: string;
        readonly schemaVersion: number;
      }[];
    };
    expect(details.blockedEpics).toEqual([
      { epicId: "epic-newer-store", schemaVersion: 9 },
    ]);
  });

  it("lists at most STORE_FORMAT_FLOOR_LISTED_EPICS blocked epics, collapsing the rest into +N more", async () => {
    for (let i = 0; i < 15; i += 1) {
      await writeStampedChatDb(`epic-${String(i).padStart(2, "0")}`, 9);
    }
    const logger = fakeLogger();

    let thrown: unknown;
    try {
      await assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.2.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        acceptStoreFormatLoss: false,
        site: "host install",
        logger,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.message).toContain("+5 more");
    const details = err.details as {
      readonly blockedEpicCount: number;
      readonly blockedEpics: readonly unknown[];
    };
    expect(details.blockedEpicCount).toBe(15);
    expect(details.blockedEpics).toHaveLength(STORE_FORMAT_FLOOR_LISTED_EPICS);
  });

  it("refuses indeterminate when a store on disk cannot be read, naming it and its reason", async () => {
    await writeStampedChatDb("epic-readable", 8);
    await writeGarbageChatDb("epic-unreadable");
    const logger = fakeLogger();

    let thrown: unknown;
    try {
      await assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.2.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        acceptStoreFormatLoss: false,
        site: "host install",
        logger,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    expect(err.message).toContain("epic-unreadable");
    const details = err.details as { readonly verdict: string };
    expect(details.verdict).toBe("indeterminate");
  });

  it("refuses indeterminate when the target's chat store format cannot be named", async () => {
    // A non-empty survey is required - `decideStoreFormatFloor` reads an
    // EMPTY survey as unconditionally `clear`, regardless of the target.
    await writeStampedChatDb("epic-on-disk", 9);
    const logger = fakeLogger();

    let thrown: unknown;
    try {
      await assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.5.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.9.0",
        acceptStoreFormatLoss: false,
        site: "host install",
        logger,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const err = thrown as CliError;
    const details = err.details as { readonly verdict: string };
    expect(details.verdict).toBe("indeterminate");
    expect(err.message).toContain("1.5.0");
  });

  it("resolves the target from published store formats when the table cannot name it", async () => {
    await writeStampedChatDb("epic-matching", 9);
    const logger = fakeLogger();

    await expect(
      assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.5.0",
        publishedStoreFormats: { chatDb: 9 },
        declaredStoreFormats: null,
        installedVersion: "1.9.0",
        acceptStoreFormatLoss: false,
        site: "host install",
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("--accept-store-format-loss bypasses a blocked refusal and logs the same facts at warn", async () => {
    await writeStampedChatDb("epic-newer-store", 9);
    const logger = fakeLogger();

    await expect(
      assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.2.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        acceptStoreFormatLoss: true,
        site: "host install",
        logger,
      }),
    ).resolves.toBeUndefined();

    const warnCall = logger.calls.find((call) => call.level === "warn");
    expect(warnCall).toBeDefined();
    expect(warnCall?.fields.blockedEpics).toEqual([
      { epicId: "epic-newer-store", schemaVersion: 9 },
    ]);
  });

  it("--accept-store-format-loss bypasses an indeterminate refusal and logs the same facts at warn", async () => {
    await writeStampedChatDb("epic-readable", 8);
    await writeGarbageChatDb("epic-unreadable");
    const logger = fakeLogger();

    await expect(
      assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.2.0",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        acceptStoreFormatLoss: true,
        site: "host install",
        logger,
      }),
    ).resolves.toBeUndefined();

    const warnCall = logger.calls.find((call) => call.level === "warn");
    expect(warnCall).toBeDefined();
    expect(warnCall?.fields.unreadableEpicCount).toBe(1);
    const unreadableEpics = warnCall?.fields.unreadableEpics as readonly {
      readonly epicId: string;
    }[];
    expect(unreadableEpics[0]?.epicId).toBe("epic-unreadable");
  });

  describe("off-ladder targets", () => {
    const OFF_LADDER_TARGET = "production.1757000000000.abc1234";

    it("stands aside for an off-ladder target with no declaration, logging info", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      await expect(
        assertHostStoreFormatFloor({
          environment: "production",
          hostHome,
          targetVersion: OFF_LADDER_TARGET,
          publishedStoreFormats: null,
          declaredStoreFormats: null,
          installedVersion: "1.3.0-rc.4",
          acceptStoreFormatLoss: false,
          site: "host install",
          logger,
        }),
      ).resolves.toBeUndefined();

      const infoCall = logger.calls.find((call) => call.level === "info");
      expect(infoCall).toBeDefined();
      expect(infoCall?.message.toLowerCase()).toContain("stood aside");
      // Debug is the "not consulted" path for an ordinary upgrade - standing
      // aside for an off-ladder target must not be silently folded into it.
      expect(logger.calls.some((call) => call.level === "debug")).toBe(false);
    });

    it("refuses an off-ladder target that declares a format lower than what is on disk", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      let thrown: unknown;
      try {
        await assertHostStoreFormatFloor({
          environment: "production",
          hostHome,
          targetVersion: OFF_LADDER_TARGET,
          publishedStoreFormats: null,
          declaredStoreFormats: { chatDb: 8 },
          installedVersion: "1.3.0-rc.4",
          acceptStoreFormatLoss: false,
          site: "host install",
          logger,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe(
        CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR,
      );
    });

    it("clears an off-ladder target that declares a format matching what is on disk", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      await expect(
        assertHostStoreFormatFloor({
          environment: "production",
          hostHome,
          targetVersion: OFF_LADDER_TARGET,
          publishedStoreFormats: null,
          declaredStoreFormats: { chatDb: 9 },
          installedVersion: "1.3.0-rc.4",
          acceptStoreFormatLoss: false,
          site: "host install",
          logger,
        }),
      ).resolves.toBeUndefined();
    });

    it("still refuses a RELEASED downgrade target over an off-ladder installed version - the exemption is not blanket", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      let thrown: unknown;
      try {
        await assertHostStoreFormatFloor({
          environment: "production",
          hostHome,
          targetVersion: "1.2.0",
          publishedStoreFormats: null,
          declaredStoreFormats: null,
          installedVersion: OFF_LADDER_TARGET,
          acceptStoreFormatLoss: false,
          site: "host install",
          logger,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe(
        CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR,
      );
    });
  });
});

describe("gateStoreFormatFloor", () => {
  it("does not consult the registry on an upgrade, even when asked to", async () => {
    const logger = fakeLogger();

    const evidence = await gateStoreFormatFloor({
      environment: "production",
      hostHome,
      targetVersion: "1.4.0",
      installedVersion: "1.3.0-rc.4",
      consultRegistry: true,
      acceptStoreFormatLoss: false,
      site: "host install",
      logger,
    });

    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(evidence.clearedVersion).toBe("1.4.0");
  });

  it("does not consult the registry on a downgrade when consultRegistry is false, and the fixed table decides", async () => {
    const logger = fakeLogger();

    const evidence = await gateStoreFormatFloor({
      environment: "production",
      hostHome,
      targetVersion: "1.3.0-rc.1",
      installedVersion: "1.3.0-rc.4",
      consultRegistry: false,
      acceptStoreFormatLoss: false,
      site: "host update",
      logger,
    });

    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(evidence.clearedVersion).toBe("1.3.0-rc.1");
    expect(evidence.publishedStoreFormats).toBeNull();
  });
});

describe("ungatedStoreFormatFloorEvidence", () => {
  it("returns clearedVersion: null", () => {
    const evidence = ungatedStoreFormatFloorEvidence("host install", false);
    expect(evidence).toEqual({
      clearedVersion: null,
      publishedStoreFormats: null,
      acceptStoreFormatLoss: false,
      site: "host install",
    });
  });
});

describe("assertStoreFormatFloorAtCommit", () => {
  it("drops the published formats and re-checks against the fixed table when the committing bytes differ from what was gated", async () => {
    // A non-empty survey is required - an empty one is unconditionally
    // `clear` regardless of the target, which would pass this test for the
    // wrong reason.
    await writeStampedChatDb("epic-on-disk", 9);
    const logger = fakeLogger();

    let thrown: unknown;
    try {
      await assertStoreFormatFloorAtCommit({
        environment: "production",
        hostHome,
        committingVersion: "1.5.0",
        declaredStoreFormats: null,
        installedVersion: "1.9.0",
        evidence: {
          clearedVersion: "1.4.0",
          publishedStoreFormats: { chatDb: 9 },
          acceptStoreFormatLoss: false,
          site: "host install",
        },
        logger,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const warnedAboutDifferentBytes = logger.calls.some(
      (call) =>
        call.level === "warn" &&
        call.message.toLowerCase().includes("different bytes"),
    );
    expect(warnedAboutDifferentBytes).toBe(true);
  });

  it("uses the published formats when the committing bytes match what was gated", async () => {
    await writeStampedChatDb("epic-matching", 9);
    const logger = fakeLogger();

    await expect(
      assertStoreFormatFloorAtCommit({
        environment: "production",
        hostHome,
        committingVersion: "1.5.0",
        declaredStoreFormats: null,
        installedVersion: "1.9.0",
        evidence: {
          clearedVersion: "1.5.0",
          publishedStoreFormats: { chatDb: 9 },
          acceptStoreFormatLoss: false,
          site: "host install",
        },
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("still applies a DECLARED format even when the committing bytes differ from what was gated - the declaration describes the actual bytes", async () => {
    await writeStampedChatDb("epic-matching", 9);
    const logger = fakeLogger();

    // clearedVersion differs from committingVersion, so the PUBLISHED formats
    // would be dropped - but declaredStoreFormats is read off the bytes
    // actually landing, so it must still clear a target the table alone
    // (above the ceiling) could not vouch for.
    await expect(
      assertStoreFormatFloorAtCommit({
        environment: "production",
        hostHome,
        committingVersion: "1.5.0",
        declaredStoreFormats: { chatDb: 9 },
        installedVersion: "1.9.0",
        evidence: {
          clearedVersion: "1.4.0",
          publishedStoreFormats: null,
          acceptStoreFormatLoss: false,
          site: "host install",
        },
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});
