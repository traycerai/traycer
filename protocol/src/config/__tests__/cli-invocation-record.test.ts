/**
 * Pins the frozen on-disk CLI invocation contract that the OSS CLI writer
 * and the host reader must share: filenames relative to the host runtime
 * home, schemaVersion 1 parse, platform mapping, and bounds.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_INVOCATION_LIFECYCLE_FILENAME,
  CLI_INVOCATION_RECORD_FILENAME,
  CLI_INVOCATION_RECORD_MAX_ARGS,
  CLI_INVOCATION_RECORD_MAX_ARG_LENGTH,
  CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES,
  CLI_INVOCATION_RECORD_STALE_FILENAME,
  CLI_INVOCATION_RECORD_STAGING_FILENAME,
  CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX,
  CLI_INVOCATION_RECORD_TXN_FILENAME,
  CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX,
  CLI_INVOCATION_STATE_DIRNAME,
  CLI_INVOCATION_TXN_ABANDON_AFTER_MS,
  cliInvocationLifecyclePath,
  cliInvocationStateDir,
  cliInvocationRecordOwnedStagingPath,
  cliInvocationRecordOwnedTransactionPath,
  cliInvocationRecordPath,
  cliInvocationRecordPlatformFor,
  cliInvocationRecordStaleMarkerPath,
  cliInvocationRecordStagingPath,
  cliInvocationRecordTransactionMarkerPath,
  cliInvocationStaleMarkerRemovableBy,
  cliInvocationTransactionAbandonedByAge,
  cliInvocationTransactionMarkerBasenamesFrom,
  cliInvocationLifecycleNewerThanLegacyExactMarker,
  cliInvocationStateDirIdentitiesMatch,
  cliInvocationStateDirIdentityFromStats,
  cliInvocationTransactionMarkerMatchesBasename,
  electCliInvocationTransactionOwnerBasename,
  isCliInvocationTransactionMarkerBasename,
  parseCliInvocationLifecycle,
  parseCliInvocationRecord,
  parseCliInvocationStaleMarker,
  parseCliInvocationTransactionMarker,
  serializeCliInvocationLifecycle,
  serializeCliInvocationRecord,
  serializeCliInvocationStaleMarker,
  serializeCliInvocationTransactionMarker,
  type CliInvocationRecord,
  type CliInvocationTransactionMarker,
} from "../cli-invocation-record";

const SAMPLE: CliInvocationRecord = {
  schemaVersion: 1,
  command: "/abs/node",
  args: ["/abs/traycer"],
  source: {
    kind: "service-registration",
    platform: "linux",
    serviceLabel: "ai.traycer.host",
  },
  recoveredAt: "2026-09-01T00:00:00.000Z",
};

describe("cli invocation record paths", () => {
  it("joins the frozen filenames under the private state child", () => {
    const dir = "/fake/host-home";
    const state = join(dir, CLI_INVOCATION_STATE_DIRNAME);
    expect(cliInvocationStateDir(dir)).toBe(state);
    expect(cliInvocationRecordPath(dir)).toBe(
      join(state, CLI_INVOCATION_RECORD_FILENAME),
    );
    expect(cliInvocationRecordStagingPath(dir)).toBe(
      join(state, CLI_INVOCATION_RECORD_STAGING_FILENAME),
    );
    expect(cliInvocationRecordTransactionMarkerPath(dir)).toBe(
      join(state, CLI_INVOCATION_RECORD_TXN_FILENAME),
    );
    expect(cliInvocationRecordStaleMarkerPath(dir)).toBe(
      join(state, CLI_INVOCATION_RECORD_STALE_FILENAME),
    );
    expect(cliInvocationLifecyclePath(dir)).toBe(
      join(state, CLI_INVOCATION_LIFECYCLE_FILENAME),
    );
    const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(cliInvocationRecordOwnedStagingPath(dir, token)).toBe(
      join(state, `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${token}`),
    );
    expect(cliInvocationRecordOwnedTransactionPath(dir, token)).toBe(
      join(state, `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}`),
    );
  });

  it("resolves relative to whatever directory it is given, not a baked-in home", () => {
    expect(cliInvocationRecordPath("/one/slot")).toBe(
      join("/one/slot", "cli-invocation", "cli-invocation.json"),
    );
    expect(cliInvocationRecordPath("/another/slot")).toBe(
      join("/another/slot", "cli-invocation", "cli-invocation.json"),
    );
  });
});

describe("cliInvocationStateDirIdentitiesMatch", () => {
  it("compares lstat dev/ino pairs", () => {
    const left = cliInvocationStateDirIdentityFromStats({ dev: 1, ino: 2 });
    if (left === null) {
      throw new Error("expected a verifiable identity for {dev:1, ino:2}");
    }
    expect(cliInvocationStateDirIdentitiesMatch(left, { dev: 1, ino: 2 })).toBe(
      true,
    );
    expect(cliInvocationStateDirIdentitiesMatch(left, { dev: 1, ino: 3 })).toBe(
      false,
    );
  });
});

describe("cliInvocationStateDirIdentityFromStats", () => {
  it("returns null when dev or ino carries no usable identity", () => {
    expect(cliInvocationStateDirIdentityFromStats({ dev: 0, ino: 5 })).toBe(
      null,
    );
    expect(cliInvocationStateDirIdentityFromStats({ dev: 5, ino: 0 })).toBe(
      null,
    );
    expect(cliInvocationStateDirIdentityFromStats({ dev: 1.5, ino: 2 })).toBe(
      null,
    );
  });

  it("returns the identity when both dev and ino are nonzero integers", () => {
    expect(cliInvocationStateDirIdentityFromStats({ dev: 5, ino: 7 })).toEqual({
      dev: 5,
      ino: 7,
    });
  });
});

describe("cliInvocationRecordPlatformFor", () => {
  it("maps Node platforms onto the frozen record enum", () => {
    expect(cliInvocationRecordPlatformFor("linux")).toBe("linux");
    expect(cliInvocationRecordPlatformFor("darwin")).toBe("macos");
    expect(cliInvocationRecordPlatformFor("win32")).toBe("windows");
    expect(cliInvocationRecordPlatformFor("freebsd")).toBe(null);
  });
});

describe("parseCliInvocationRecord", () => {
  it("round-trips a schemaVersion 1 record", () => {
    const parsed = parseCliInvocationRecord(
      JSON.parse(serializeCliInvocationRecord(SAMPLE)),
    );
    expect(parsed).toEqual(SAMPLE);
  });

  it("tolerates unknown keys on a well-formed schemaVersion 1 record", () => {
    const parsed = parseCliInvocationRecord({
      ...SAMPLE,
      extra: "ignored",
      source: { ...SAMPLE.source, extra: 1 },
    });
    expect(parsed).toEqual(SAMPLE);
  });

  it("accepts a Windows absolute command on any parse host", () => {
    const parsed = parseCliInvocationRecord({
      ...SAMPLE,
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\x\\traycer.js"],
      source: { ...SAMPLE.source, platform: "windows" },
    });
    expect(parsed?.command).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(parsed?.source.platform).toBe("windows");
  });

  it("rejects relative commands, NULs, unknown enums, and other schema versions", () => {
    expect(parseCliInvocationRecord({ ...SAMPLE, command: "node" })).toBeNull();
    expect(
      parseCliInvocationRecord({ ...SAMPLE, command: "/abs/node\0" }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({ ...SAMPLE, args: ["/abs/a", "b\0"] }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({ ...SAMPLE, schemaVersion: 2 }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({
        ...SAMPLE,
        source: { ...SAMPLE.source, kind: "mystery" },
      }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({
        ...SAMPLE,
        source: { ...SAMPLE.source, platform: "darwin" },
      }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({ ...SAMPLE, recoveredAt: "not-a-date" }),
    ).toBeNull();
  });

  it("rejects an argument longer than the frozen bound", () => {
    const tooLong = "a".repeat(CLI_INVOCATION_RECORD_MAX_ARG_LENGTH + 1);
    expect(
      parseCliInvocationRecord({ ...SAMPLE, args: [`/${tooLong}`] }),
    ).toBeNull();
  });

  it("rejects more arguments than the frozen bound", () => {
    const args = Array.from(
      { length: CLI_INVOCATION_RECORD_MAX_ARGS + 1 },
      (_, i) => `/abs/${i}`,
    );
    expect(parseCliInvocationRecord({ ...SAMPLE, args })).toBeNull();
  });

  it("accepts exactly the frozen argument-count bound", () => {
    const args = Array.from(
      { length: CLI_INVOCATION_RECORD_MAX_ARGS },
      (_, i) => `/abs/${i}`,
    );
    expect(parseCliInvocationRecord({ ...SAMPLE, args })?.args).toEqual(args);
  });

  it("rejects a serialized record over the frozen byte bound even with in-bounds fields", () => {
    const args = Array.from(
      { length: CLI_INVOCATION_RECORD_MAX_ARGS },
      (_, i) => `/${"a".repeat(CLI_INVOCATION_RECORD_MAX_ARG_LENGTH - 4)}${i}`,
    );
    expect(
      new TextEncoder().encode(
        serializeCliInvocationRecord({ ...SAMPLE, args }),
      ).length,
    ).toBeGreaterThan(CLI_INVOCATION_RECORD_MAX_SERIALIZED_BYTES);
    expect(parseCliInvocationRecord({ ...SAMPLE, args })).toBeNull();
  });

  it("rejects args that are not an array, or contain a non-string entry", () => {
    expect(
      parseCliInvocationRecord({ ...SAMPLE, args: "/abs/traycer" }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({ ...SAMPLE, args: ["/abs/a", 7] }),
    ).toBeNull();
  });

  it("rejects an empty or NUL-containing serviceLabel", () => {
    expect(
      parseCliInvocationRecord({
        ...SAMPLE,
        source: { ...SAMPLE.source, serviceLabel: "" },
      }),
    ).toBeNull();
    expect(
      parseCliInvocationRecord({
        ...SAMPLE,
        source: { ...SAMPLE.source, serviceLabel: "ai.traycer\0host" },
      }),
    ).toBeNull();
  });

  it("rejects when source is missing or not a plain object", () => {
    expect(
      parseCliInvocationRecord({ ...SAMPLE, source: undefined }),
    ).toBeNull();
    expect(parseCliInvocationRecord({ ...SAMPLE, source: [] })).toBeNull();
  });

  it("accepts every declared record platform", () => {
    for (const platform of ["linux", "macos", "windows"] as const) {
      expect(
        parseCliInvocationRecord({
          ...SAMPLE,
          source: { ...SAMPLE.source, platform },
        })?.source.platform,
      ).toBe(platform);
    }
  });
});

const TXN_TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TXN_SAMPLE: CliInvocationTransactionMarker = {
  schemaVersion: 1,
  kind: "transaction",
  owner: {
    pid: 4242,
    token: TXN_TOKEN,
    processStartIdentity: "darwin:Thu Jan  1 00:00:00 2026",
    startedAtMs: 1_700_000_000_000,
  },
  stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${TXN_TOKEN}`,
  operation: "install",
  serviceLabel: "ai.traycer.host",
  startedAt: "2026-09-01T00:00:00.000Z",
};

describe("parseCliInvocationTransactionMarker", () => {
  it("round-trips a schemaVersion 1 transaction marker", () => {
    expect(
      parseCliInvocationTransactionMarker(
        JSON.parse(serializeCliInvocationTransactionMarker(TXN_SAMPLE)),
      ),
    ).toEqual(TXN_SAMPLE);
  });

  it("tolerates unknown keys", () => {
    expect(
      parseCliInvocationTransactionMarker({
        ...TXN_SAMPLE,
        extra: true,
        owner: { ...TXN_SAMPLE.owner, extra: 1 },
      }),
    ).toEqual(TXN_SAMPLE);
  });

  it("rejects a stagingFile that does not match the owner token", () => {
    expect(
      parseCliInvocationTransactionMarker({
        ...TXN_SAMPLE,
        stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}ffffffff-ffff-4fff-8fff-ffffffffffff`,
      }),
    ).toBeNull();
  });

  it("rejects a path-like token", () => {
    expect(
      parseCliInvocationTransactionMarker({
        ...TXN_SAMPLE,
        owner: { ...TXN_SAMPLE.owner, token: "../escape" },
        stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}../escape`,
      }),
    ).toBeNull();
  });
});

describe("isCliInvocationTransactionMarkerBasename", () => {
  it("accepts the legacy exact name and unique uuid contenders only", () => {
    const token = TXN_TOKEN;
    expect(isCliInvocationTransactionMarkerBasename("cli-invocation.txn")).toBe(
      true,
    );
    expect(
      isCliInvocationTransactionMarkerBasename(
        `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}`,
      ),
    ).toBe(true);
    expect(
      isCliInvocationTransactionMarkerBasename(
        `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}.tmp`,
      ),
    ).toBe(false);
    expect(
      isCliInvocationTransactionMarkerBasename("cli-invocation.txnfoo"),
    ).toBe(false);
    expect(
      isCliInvocationTransactionMarkerBasename("cli-invocation.stale"),
    ).toBe(false);
    expect(
      isCliInvocationTransactionMarkerBasename("cli-invocation.lifecycle"),
    ).toBe(false);
    expect(
      cliInvocationTransactionMarkerBasenamesFrom([
        "cli-invocation.json",
        `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}.tmp`,
        `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}`,
        "cli-invocation.txn",
        "cli-invocation.stale",
      ]),
    ).toEqual([
      "cli-invocation.txn",
      `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${token}`,
    ]);
  });
});

describe("cliInvocationTransactionMarkerMatchesBasename", () => {
  it("requires the unique suffix to equal owner.token and allows the legacy exact name", () => {
    expect(
      cliInvocationTransactionMarkerMatchesBasename(
        TXN_SAMPLE,
        "cli-invocation.txn",
      ),
    ).toBe(true);
    expect(
      cliInvocationTransactionMarkerMatchesBasename(
        TXN_SAMPLE,
        `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}${TXN_TOKEN}`,
      ),
    ).toBe(true);
    expect(
      cliInvocationTransactionMarkerMatchesBasename(
        TXN_SAMPLE,
        `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}ffffffff-ffff-4fff-8fff-ffffffffffff`,
      ),
    ).toBe(false);
  });
});

const LIFECYCLE_SAMPLE = {
  schemaVersion: 1 as const,
  kind: "lifecycle" as const,
  generation: TXN_TOKEN,
  event: "uninstalled" as const,
  serviceLabel: "ai.traycer.host",
  at: "2026-09-01T00:00:00.000Z",
};

describe("cliInvocationLifecycleNewerThanLegacyExactMarker", () => {
  it("requires the lifecycle at stamp to be strictly after the later of startedAt and owner.startedAtMs", () => {
    expect(
      cliInvocationLifecycleNewerThanLegacyExactMarker(TXN_SAMPLE, {
        ...LIFECYCLE_SAMPLE,
        at: "2026-09-01T00:00:00.001Z",
      }),
    ).toBe(true);
    expect(
      cliInvocationLifecycleNewerThanLegacyExactMarker(TXN_SAMPLE, {
        ...LIFECYCLE_SAMPLE,
        at: TXN_SAMPLE.startedAt,
      }),
    ).toBe(false);
    expect(
      cliInvocationLifecycleNewerThanLegacyExactMarker(
        {
          ...TXN_SAMPLE,
          owner: {
            ...TXN_SAMPLE.owner,
            startedAtMs: Date.parse("2026-09-02T00:00:00.000Z"),
          },
        },
        { ...LIFECYCLE_SAMPLE, at: "2026-09-01T12:00:00.000Z" },
      ),
    ).toBe(false);
  });
});

describe("electCliInvocationTransactionOwnerBasename", () => {
  it("picks earliest mtime then basename, and does not use a later file", () => {
    const early = "cli-invocation.txn.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const lateSmaller =
      "cli-invocation.txn.00000000-0000-4000-8000-000000000000";
    expect(
      electCliInvocationTransactionOwnerBasename([
        { basename: lateSmaller, mtimeMs: 20 },
        { basename: early, mtimeMs: 10 },
      ]),
    ).toBe(early);
    expect(
      electCliInvocationTransactionOwnerBasename([
        { basename: lateSmaller, mtimeMs: 10 },
        { basename: early, mtimeMs: 10 },
      ]),
    ).toBe(lateSmaller);
    expect(electCliInvocationTransactionOwnerBasename([])).toBeNull();
  });
});

describe("cliInvocationTransactionAbandonedByAge", () => {
  it("uses a symmetric window around now", () => {
    const now = 1_000_000;
    expect(
      cliInvocationTransactionAbandonedByAge(
        now - CLI_INVOCATION_TXN_ABANDON_AFTER_MS,
        now,
      ),
    ).toBe(true);
    expect(
      cliInvocationTransactionAbandonedByAge(
        now + CLI_INVOCATION_TXN_ABANDON_AFTER_MS,
        now,
      ),
    ).toBe(true);
    expect(
      cliInvocationTransactionAbandonedByAge(
        now - CLI_INVOCATION_TXN_ABANDON_AFTER_MS + 1,
        now,
      ),
    ).toBe(false);
  });
});

describe("parseCliInvocationLifecycle", () => {
  it("round-trips a schemaVersion 1 lifecycle generation", () => {
    expect(
      parseCliInvocationLifecycle(
        JSON.parse(serializeCliInvocationLifecycle(LIFECYCLE_SAMPLE)),
      ),
    ).toEqual(LIFECYCLE_SAMPLE);
  });

  it("tolerates unknown keys", () => {
    expect(
      parseCliInvocationLifecycle({ ...LIFECYCLE_SAMPLE, extra: true }),
    ).toEqual(LIFECYCLE_SAMPLE);
  });

  it("rejects a non-uuid generation and an unknown event", () => {
    expect(
      parseCliInvocationLifecycle({
        ...LIFECYCLE_SAMPLE,
        generation: "not-a-uuid",
      }),
    ).toBeNull();
    expect(
      parseCliInvocationLifecycle({ ...LIFECYCLE_SAMPLE, event: "stale" }),
    ).toBeNull();
  });
});

describe("stale marker serialize/parse", () => {
  it("round-trips serviceLabel through serialize then parse", () => {
    const serialized = serializeCliInvocationStaleMarker({
      serviceLabel: "ai.traycer.host",
    });
    const parsed = parseCliInvocationStaleMarker(JSON.parse(serialized));
    expect(parsed).toEqual({
      schemaVersion: 1,
      kind: "stale",
      serviceLabel: "ai.traycer.host",
    });
  });

  it("parses a legacy body with no serviceLabel field as serviceLabel: null", () => {
    const legacyBody = '{"schemaVersion":1,"kind":"stale"}\n';
    const parsed = parseCliInvocationStaleMarker(JSON.parse(legacyBody));
    expect(parsed).toEqual({
      schemaVersion: 1,
      kind: "stale",
      serviceLabel: null,
    });
  });

  it("rejects a stale-marker-shaped object with a different kind", () => {
    expect(
      parseCliInvocationStaleMarker({
        schemaVersion: 1,
        kind: "lifecycle",
        serviceLabel: "ai.traycer.host",
      }),
    ).toBeNull();
  });

  it("rejects an empty or NUL-containing serviceLabel", () => {
    expect(
      parseCliInvocationStaleMarker({
        schemaVersion: 1,
        kind: "stale",
        serviceLabel: "",
      }),
    ).toBeNull();
    expect(
      parseCliInvocationStaleMarker({
        schemaVersion: 1,
        kind: "stale",
        serviceLabel: "ai.traycer\0host",
      }),
    ).toBeNull();
  });
});

describe("cliInvocationStaleMarkerRemovableBy", () => {
  it("a legacy marker (serviceLabel: null) is removable by any label", () => {
    const legacy = parseCliInvocationStaleMarker(
      JSON.parse('{"schemaVersion":1,"kind":"stale"}\n'),
    );
    if (legacy === null) throw new Error("expected the legacy marker to parse");
    expect(cliInvocationStaleMarkerRemovableBy(legacy, "ai.traycer.host")).toBe(
      true,
    );
    expect(
      cliInvocationStaleMarkerRemovableBy(legacy, "ai.traycer.host.other"),
    ).toBe(true);
  });

  it("an own-label marker is removable only when the argument matches", () => {
    const own = parseCliInvocationStaleMarker(
      JSON.parse(
        serializeCliInvocationStaleMarker({ serviceLabel: "ai.traycer.host" }),
      ),
    );
    if (own === null) throw new Error("expected the own-label marker to parse");
    expect(cliInvocationStaleMarkerRemovableBy(own, "ai.traycer.host")).toBe(
      true,
    );
    expect(
      cliInvocationStaleMarkerRemovableBy(own, "ai.traycer.host.other"),
    ).toBe(false);
  });
});
