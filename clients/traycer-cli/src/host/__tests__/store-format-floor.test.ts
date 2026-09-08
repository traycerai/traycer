import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { EPIC_STATE_DIRNAME } from "../chat-store-survey";
import { SOURCE_TREE_HOST_VERSION } from "@traycer/protocol/host/store-formats";

const fetchTextMock = vi.fn();
vi.mock("../../registry/fetch-resource", () => ({
  fetchText: (...args: unknown[]) => fetchTextMock(...args),
}));

import {
  assertHostStoreFormatFloor,
  assertStoreFormatFloorAtCommit,
  gateStoreFormatFloor,
  storeFormatFloorTargetVersion,
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
        installedStoreFormats: null,
        acceptStoreFormatLoss: false,
        site: "host update",
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("clears from formats alone on an rc rollback, without touching disk", async () => {
    // Target OLDER than installed - rc.1 after rc.4 - so this is an actual
    // rollback that reaches the format comparison rather than an upgrade
    // `storeFloorApplicability` would send out before either version's
    // chatDb is ever looked at. With the versions the wrong way round this
    // test would stay green even if `storeFloorClearedByFormats` were
    // deleted outright - it would just resolve via `target-not-older`
    // instead, proving nothing about the short-circuit it claims to cover.
    await writeGarbageChatDb("epic-would-fail-if-walked");
    const logger = fakeLogger();

    await expect(
      assertHostStoreFormatFloor({
        environment: "production",
        hostHome,
        targetVersion: "1.3.0-rc.1",
        publishedStoreFormats: null,
        declaredStoreFormats: null,
        installedVersion: "1.3.0-rc.4",
        installedStoreFormats: null,
        acceptStoreFormatLoss: false,
        site: "host update",
        logger,
      }),
    ).resolves.toBeUndefined();

    // Both rc.1 and rc.4 write chatDb 9 (same era), so the format short-
    // circuit clears it - proven by the SPECIFIC debug line, not merely a
    // resolved promise, so this cannot pass via the wrong branch (the
    // "not consulted" line an upgrade would have logged instead).
    const clearedCall = logger.calls.find(
      (call) =>
        call.message === "Host store-format floor cleared without a disk walk",
    );
    expect(clearedCall).toBeDefined();
    expect(
      logger.calls.some(
        (call) => call.message === "Host store-format floor not consulted",
      ),
    ).toBe(false);
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
        installedStoreFormats: null,
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

  it("names the unreadable epics too on a blocked refusal, not only the proven ones", async () => {
    // `blocked` outranks `indeterminate` - the proven reading leads the
    // refusal - but a store that could not be read is still a store the
    // verdict cannot vouch for, and dropping it from the message/details
    // would under-report what the downgrade puts at risk.
    await writeStampedChatDb("epic-newer-store", 9);
    await writeGarbageChatDb("epic-unreadable-too");
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
        installedStoreFormats: null,
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
    expect(err.message).toContain("epic-newer-store");
    expect(err.message).toContain("epic-unreadable-too");
    const details = err.details as {
      readonly verdict: string;
      readonly blockedEpics: readonly { readonly epicId: string }[];
      readonly unreadableEpics: readonly { readonly epicId: string }[];
    };
    expect(details.verdict).toBe("blocked");
    expect(details.blockedEpics).toEqual([
      { epicId: "epic-newer-store", schemaVersion: 9 },
    ]);
    expect(details.unreadableEpics).toEqual([
      { epicId: "epic-unreadable-too", reason: "unreadable-chat-db" },
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
        installedStoreFormats: null,
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
        installedStoreFormats: null,
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
        installedStoreFormats: null,
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
        installedStoreFormats: null,
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
        installedStoreFormats: null,
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
        installedStoreFormats: null,
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
          installedStoreFormats: null,
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
          installedStoreFormats: null,
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
          installedStoreFormats: null,
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
          installedStoreFormats: null,
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

  describe("installed side declaration", () => {
    // Both tests carry a `writeGarbageChatDb` fixture, so a walk that
    // happens anyway cannot silently pass - it would surface as an
    // indeterminate refusal instead.
    const BUILD_STAMPED_INSTALLED = "production.1757000000000.abc1234";

    it("clears via the no-disk-walk short-circuit when the build-stamped installed side declares a format the target meets", async () => {
      await writeGarbageChatDb("epic-would-fail-if-walked");
      const logger = fakeLogger();

      await expect(
        assertHostStoreFormatFloor({
          environment: "production",
          hostHome,
          targetVersion: "1.3.0-rc.4",
          publishedStoreFormats: null,
          declaredStoreFormats: null,
          installedVersion: BUILD_STAMPED_INSTALLED,
          installedStoreFormats: { chatDb: 9 },
          acceptStoreFormatLoss: false,
          site: "host ensure",
          logger,
        }),
      ).resolves.toBeUndefined();

      // The regression this pins: without the declaration, `host ensure`
      // converging FORWARD onto its own bundled host - a build-stamped
      // version the fixed table can never place - could be refused by one
      // unreadable store, with no `--accept-store-format-loss` anywhere in
      // the desktop flow that reaches this site.
      const clearedCall = logger.calls.find(
        (call) =>
          call.message ===
          "Host store-format floor cleared without a disk walk",
      );
      expect(clearedCall).toBeDefined();
    });

    it("still walks disk (and refuses on the unreadable fixture) when the build-stamped installed side declares nothing", async () => {
      // Same installed version as above, but WITHOUT the declaration - pins
      // that the declaration is what changed the previous test's outcome,
      // not some blanket "a build-stamped install always skips the floor".
      await writeGarbageChatDb("epic-would-fail-if-walked");
      const logger = fakeLogger();

      let thrown: unknown;
      try {
        await assertHostStoreFormatFloor({
          environment: "production",
          hostHome,
          targetVersion: "1.3.0-rc.4",
          publishedStoreFormats: null,
          declaredStoreFormats: null,
          installedVersion: BUILD_STAMPED_INSTALLED,
          installedStoreFormats: null,
          acceptStoreFormatLoss: false,
          site: "host ensure",
          logger,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).code).toBe(
        CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR,
      );
      const details = (thrown as CliError).details as {
        readonly verdict: string;
      };
      expect(details.verdict).toBe("indeterminate");
    });

    it("refuses a released downgrade over the source-tree sentinel installed side, rather than skipping it as an upgrade", async () => {
      // R4: `0.0.0-dev` parses as SemVer and sorts below every release, so
      // ordering alone would call `1.2.0` an upgrade over it and skip the
      // floor entirely - while a build of today's source writes chatDb 9.
      // `storeFloorApplicability` has to name the sentinel explicitly for
      // this refusal to happen at all.
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
          installedVersion: SOURCE_TREE_HOST_VERSION,
          installedStoreFormats: null,
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
      installedStoreFormats: null,
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
      installedStoreFormats: null,
      consultRegistry: false,
      acceptStoreFormatLoss: false,
      site: "host update",
      logger,
    });

    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(evidence.clearedVersion).toBe("1.3.0-rc.1");
    expect(evidence.publishedStoreFormats).toBeNull();
  });

  it("logs the INFO 'stood aside' line on its own early return for an off-ladder target, not only inside assertHostStoreFormatFloor", async () => {
    // P2-10: this early return - a pre-stage site with no archive to
    // declare a format - used to return silently, so the "stood aside"
    // record the module promises appeared at a pre-stage site exactly
    // never. `assertHostStoreFormatFloor` is never reached on this path (no
    // formats to check), so only THIS call site can log it here.
    const logger = fakeLogger();

    const evidence = await gateStoreFormatFloor({
      environment: "production",
      hostHome,
      targetVersion: "local-something",
      installedVersion: "1.3.0-rc.4",
      installedStoreFormats: null,
      consultRegistry: true,
      acceptStoreFormatLoss: false,
      site: "host install",
      logger,
    });

    expect(fetchTextMock).not.toHaveBeenCalled();
    expect(evidence.publishedStoreFormats).toBeNull();
    const infoCall = logger.calls.find((call) => call.level === "info");
    expect(infoCall).toBeDefined();
    expect(infoCall?.message.toLowerCase()).toContain("stood aside");
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
        declaredRuntimeVersion: null,
        declaredStoreFormats: null,
        installedVersion: "1.9.0",
        installedStoreFormats: null,
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
        declaredRuntimeVersion: null,
        declaredStoreFormats: null,
        installedVersion: "1.9.0",
        installedStoreFormats: null,
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
        declaredRuntimeVersion: null,
        declaredStoreFormats: { chatDb: 9 },
        installedVersion: "1.9.0",
        installedStoreFormats: null,
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

  describe("--from a local archive of a released build (declaredRuntimeVersion resolution)", () => {
    // `host install --from` records `deriveLocalVersion(sourcePath)`, a
    // synthetic `local-<basename>-<timestamp>` string, as the install
    // RECORD's version. Judged by that string, a genuinely released 1.2.0
    // archive reads as off-ladder and the floor stands aside on precisely
    // the downgrade it exists to refuse - this is the bug the production
    // change fixes, and these tests pin the fix rather than the symptom.
    const LOCAL_COMMITTING_VERSION =
      "local-host-v1.2.0.tar.gz-2026-01-01T00-00-00-000Z";

    it("throws E_HOST_STORE_FORMAT_FLOOR, judging by the declared release rather than the local record string", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      let thrown: unknown;
      try {
        await assertStoreFormatFloorAtCommit({
          environment: "production",
          hostHome,
          committingVersion: LOCAL_COMMITTING_VERSION,
          declaredRuntimeVersion: "1.2.0",
          declaredStoreFormats: null,
          installedVersion: "1.3.0-rc.4",
          installedStoreFormats: null,
          evidence: ungatedStoreFormatFloorEvidence("host install", false),
          logger,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CliError);
      const err = thrown as CliError;
      expect(err.code).toBe(CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR);
      // The refusal must name the release the user will recognize, not the
      // synthetic local-install bookkeeping string - that is the whole point
      // of resolving through the declaration before judging.
      expect(err.message).toContain("1.2.0");
      expect(err.message).not.toContain("local-host-v1.2.0");
    });

    it("resolves when the archive declares a chatDb format that clears what is on disk", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      await expect(
        assertStoreFormatFloorAtCommit({
          environment: "production",
          hostHome,
          committingVersion: LOCAL_COMMITTING_VERSION,
          declaredRuntimeVersion: "1.2.0",
          declaredStoreFormats: { chatDb: 9 },
          installedVersion: "1.3.0-rc.4",
          installedStoreFormats: null,
          evidence: ungatedStoreFormatFloorEvidence("host install", false),
          logger,
        }),
      ).resolves.toBeUndefined();
    });

    it("stands aside, logging info, when the archive declares no runtime version at all (unchanged off-ladder behaviour)", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      await expect(
        assertStoreFormatFloorAtCommit({
          environment: "production",
          hostHome,
          committingVersion: LOCAL_COMMITTING_VERSION,
          declaredRuntimeVersion: null,
          declaredStoreFormats: null,
          installedVersion: "1.3.0-rc.4",
          installedStoreFormats: null,
          evidence: ungatedStoreFormatFloorEvidence("host install", false),
          logger,
        }),
      ).resolves.toBeUndefined();

      const infoCall = logger.calls.find((call) => call.level === "info");
      expect(infoCall).toBeDefined();
      expect(infoCall?.message.toLowerCase()).toContain("stood aside");
    });

    it("--accept-store-format-loss bypasses the refusal and warns with the same message the refusal would have shown", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      await expect(
        assertStoreFormatFloorAtCommit({
          environment: "production",
          hostHome,
          committingVersion: LOCAL_COMMITTING_VERSION,
          declaredRuntimeVersion: "1.2.0",
          declaredStoreFormats: null,
          installedVersion: "1.3.0-rc.4",
          installedStoreFormats: null,
          evidence: ungatedStoreFormatFloorEvidence("host install", true),
          logger,
        }),
      ).resolves.toBeUndefined();

      const warnCall = logger.calls.find(
        (call) =>
          call.level === "warn" &&
          call.message ===
            "Host store-format floor overridden by --accept-store-format-loss",
      );
      expect(warnCall).toBeDefined();
      const warnedMessage = warnCall?.fields.message;
      expect(warnedMessage).toContain("1.2.0");
      expect(warnedMessage).not.toContain("local-host-v1.2.0");
    });

    it("keeps the published formats when clearedVersion equals the DECLARED version, not the local record string", async () => {
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      await expect(
        assertStoreFormatFloorAtCommit({
          environment: "production",
          hostHome,
          committingVersion: LOCAL_COMMITTING_VERSION,
          declaredRuntimeVersion: "1.2.0",
          declaredStoreFormats: null,
          installedVersion: "1.3.0-rc.4",
          installedStoreFormats: null,
          evidence: {
            clearedVersion: "1.2.0",
            publishedStoreFormats: { chatDb: 9 },
            acceptStoreFormatLoss: false,
            site: "host install",
          },
          logger,
        }),
      ).resolves.toBeUndefined();

      const warnedAboutDifferentBytes = logger.calls.some(
        (call) =>
          call.level === "warn" &&
          call.message.toLowerCase().includes("different bytes"),
      );
      expect(warnedAboutDifferentBytes).toBe(false);
    });

    it("drops the published formats, warns, and refuses when clearedVersion equals the local RECORD string while the declaration differs", async () => {
      // This is the fail-closed direction, and the one a regression would
      // silently flip: an early gate that (incorrectly) cleared the local
      // record string must not have its published formats trusted for a
      // commit that resolves to a different, declared version.
      await writeStampedChatDb("epic-on-disk", 9);
      const logger = fakeLogger();

      let thrown: unknown;
      try {
        await assertStoreFormatFloorAtCommit({
          environment: "production",
          hostHome,
          committingVersion: LOCAL_COMMITTING_VERSION,
          declaredRuntimeVersion: "1.2.0",
          declaredStoreFormats: null,
          installedVersion: "1.3.0-rc.4",
          installedStoreFormats: null,
          evidence: {
            clearedVersion: LOCAL_COMMITTING_VERSION,
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
      expect((thrown as CliError).code).toBe(
        CLI_ERROR_CODES.HOST_STORE_FORMAT_FLOOR,
      );
      const warnedAboutDifferentBytes = logger.calls.some(
        (call) =>
          call.level === "warn" &&
          call.message.toLowerCase().includes("different bytes"),
      );
      expect(warnedAboutDifferentBytes).toBe(true);
    });
  });
});

describe("storeFormatFloorTargetVersion", () => {
  it("returns the declaration when present", () => {
    expect(
      storeFormatFloorTargetVersion(
        "1.2.0",
        "local-host-v1.2.0.tar.gz-2026-01-01T00-00-00-000Z",
      ),
    ).toBe("1.2.0");
  });

  it("returns the record version when the declaration is null", () => {
    expect(
      storeFormatFloorTargetVersion(
        null,
        "local-host-v1.2.0.tar.gz-2026-01-01T00-00-00-000Z",
      ),
    ).toBe("local-host-v1.2.0.tar.gz-2026-01-01T00-00-00-000Z");
  });
});
