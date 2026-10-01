import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { z } from "zod";
import {
  defineRecordContract,
  defineVersionedRecordRegistry,
  defineVersionedRpcRegistry,
  validateVersionedRecordRegistry,
  validateVersionedRpcRegistry,
  type UncheckedVersionedRecordRegistry,
  type UncheckedVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  defineStreamRpcContract,
  defineVersionedStreamRpcRegistry,
  validateVersionedStreamRpcRegistry,
  type UncheckedVersionedStreamRpcRegistry,
} from "@traycer/protocol/framework/versioned-stream-rpc";

/**
 * Importing a registry module must not walk schemas. The `define*` factories
 * keep the structural pass and leave additivity / breaking-change walks to
 * `validate*` (CI and explicit callers). Every validator walk goes through
 * an export of `json-schema-fingerprint`, so wrapping those exports is the
 * one seam that can observe a walk.
 *
 * This suite proves there is no JSON-Schema walk at import. It does not
 * prove there is no schema materialisation: `.shape` / `.options` reads at
 * module scope are A2's job, not this scan.
 */
vi.mock(
  "@traycer/protocol/framework/json-schema-fingerprint",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@traycer/protocol/framework/json-schema-fingerprint")
      >();
    return {
      ...original,
      toJsonSchemaFingerprint: vi.fn(original.toJsonSchemaFingerprint),
      toUnknownKeyTree: vi.fn(original.toUnknownKeyTree),
      toStreamFieldJsonSchemaText: vi.fn(original.toStreamFieldJsonSchemaText),
      findAdditivityViolation: vi.fn(original.findAdditivityViolation),
      findAdditivityViolationAllowingUnionArmReplacement: vi.fn(
        original.findAdditivityViolationAllowingUnionArmReplacement,
      ),
      findBreakingChange: vi.fn(original.findBreakingChange),
    };
  },
);

type FingerprintSpy = {
  mockClear(): void;
  readonly mock: { readonly calls: readonly unknown[] };
};

type FingerprintSpies = {
  readonly toJsonSchemaFingerprint: FingerprintSpy;
  readonly toUnknownKeyTree: FingerprintSpy;
  readonly toStreamFieldJsonSchemaText: FingerprintSpy;
  readonly findAdditivityViolation: FingerprintSpy;
  readonly findAdditivityViolationAllowingUnionArmReplacement: FingerprintSpy;
  readonly findBreakingChange: FingerprintSpy;
};

async function loadFingerprintSpies(): Promise<FingerprintSpies> {
  const fingerprint =
    await import("@traycer/protocol/framework/json-schema-fingerprint");
  return {
    toJsonSchemaFingerprint: vi.mocked(fingerprint.toJsonSchemaFingerprint),
    toUnknownKeyTree: vi.mocked(fingerprint.toUnknownKeyTree),
    toStreamFieldJsonSchemaText: vi.mocked(
      fingerprint.toStreamFieldJsonSchemaText,
    ),
    findAdditivityViolation: vi.mocked(fingerprint.findAdditivityViolation),
    findAdditivityViolationAllowingUnionArmReplacement: vi.mocked(
      fingerprint.findAdditivityViolationAllowingUnionArmReplacement,
    ),
    findBreakingChange: vi.mocked(fingerprint.findBreakingChange),
  };
}

function clearSpies(spies: FingerprintSpies): void {
  spies.toJsonSchemaFingerprint.mockClear();
  spies.toUnknownKeyTree.mockClear();
  spies.toStreamFieldJsonSchemaText.mockClear();
  spies.findAdditivityViolation.mockClear();
  spies.findAdditivityViolationAllowingUnionArmReplacement.mockClear();
  spies.findBreakingChange.mockClear();
}

function expectEveryCounterZero(spies: FingerprintSpies): void {
  expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBe(0);
  expect(spies.toUnknownKeyTree.mock.calls.length).toBe(0);
  expect(spies.toStreamFieldJsonSchemaText.mock.calls.length).toBe(0);
  expect(spies.findAdditivityViolation.mock.calls.length).toBe(0);
  expect(
    spies.findAdditivityViolationAllowingUnionArmReplacement.mock.calls.length,
  ).toBe(0);
  expect(spies.findBreakingChange.mock.calls.length).toBe(0);
}

describe("importing a registry module walks no schema", () => {
  it("host/registry: import is silent; full validators walk the seam", async () => {
    vi.resetModules();
    const spies = await loadFingerprintSpies();
    clearSpies(spies);
    const mod = await import("@traycer/protocol/host/registry");
    expectEveryCounterZero(spies);

    validateVersionedRpcRegistry(mod.hostRpcRegistry);
    expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBeGreaterThan(0);
    expect(spies.toUnknownKeyTree.mock.calls.length).toBeGreaterThan(0);

    const streamCallsBefore =
      spies.toStreamFieldJsonSchemaText.mock.calls.length;
    validateVersionedStreamRpcRegistry(mod.hostStreamRpcRegistry);
    expect(spies.toStreamFieldJsonSchemaText.mock.calls.length).toBeGreaterThan(
      streamCallsBefore,
    );
  });

  it("host/index: import is silent; full validators walk the seam", async () => {
    vi.resetModules();
    const spies = await loadFingerprintSpies();
    clearSpies(spies);
    const mod = await import("@traycer/protocol/host/index");
    expectEveryCounterZero(spies);

    validateVersionedRpcRegistry(mod.hostRpcRegistry);
    expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBeGreaterThan(0);
    const streamCallsBefore =
      spies.toStreamFieldJsonSchemaText.mock.calls.length;
    validateVersionedStreamRpcRegistry(mod.hostStreamRpcRegistry);
    expect(spies.toStreamFieldJsonSchemaText.mock.calls.length).toBeGreaterThan(
      streamCallsBefore,
    );
  });

  it("persistence/registry: import is silent; full validator walks the seam", async () => {
    vi.resetModules();
    const spies = await loadFingerprintSpies();
    clearSpies(spies);
    const mod = await import("@traycer/protocol/persistence/registry");
    expectEveryCounterZero(spies);

    validateVersionedRecordRegistry(mod.persistenceRecordRegistry);
    expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBeGreaterThan(0);
    expect(spies.findAdditivityViolation.mock.calls.length).toBeGreaterThan(0);
  });

  it("persistence/chat-sync-registry: import is silent; full validator walks the seam", async () => {
    vi.resetModules();
    const spies = await loadFingerprintSpies();
    clearSpies(spies);
    const mod =
      await import("@traycer/protocol/persistence/chat-sync-registry");
    expectEveryCounterZero(spies);

    validateVersionedRecordRegistry(mod.chatSyncRecordRegistry);
    expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBeGreaterThan(0);
  });

  it("auth/registry: import is silent; full validator walks the seam", async () => {
    vi.resetModules();
    const spies = await loadFingerprintSpies();
    clearSpies(spies);
    const mod = await import("@traycer/protocol/auth/registry");
    expectEveryCounterZero(spies);

    validateVersionedRecordRegistry(mod.authRecordRegistry);
    expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBeGreaterThan(0);
  });

  it("common/registry: import is silent; full validator walks the seam", async () => {
    vi.resetModules();
    const spies = await loadFingerprintSpies();
    clearSpies(spies);
    const mod = await import("@traycer/protocol/common/registry");
    expectEveryCounterZero(spies);

    validateVersionedRecordRegistry(mod.commonRecordRegistry);
    expect(spies.toJsonSchemaFingerprint.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("toStreamFieldJsonSchemaText", () => {
  it("matches JSON.stringify(z.toJSONSchema(schema)) for representative schemas", async () => {
    const { toStreamFieldJsonSchemaText } =
      await import("@traycer/protocol/framework/json-schema-fingerprint");
    const schemas: readonly z.ZodType[] = [
      z.object({ id: z.string() }),
      z.string(),
      z.array(z.number()),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("snapshot"), id: z.string() }),
        z.object({ kind: z.literal("pong") }),
      ]),
    ];
    for (const schema of schemas) {
      expect(toStreamFieldJsonSchemaText(schema)).toBe(
        JSON.stringify(z.toJSONSchema(schema)),
      );
    }
  });
});

describe("define* still throws structural errors", () => {
  it("unary: latestMinor that is not the highest installed minor", () => {
    const v0 = {
      method: "echo",
      schemaVersion: { major: 1, minor: 0 } as const,
      requestSchema: z.object({ n: z.number() }),
      responseSchema: z.object({ n: z.number() }),
    };
    const v1 = {
      method: "echo",
      schemaVersion: { major: 1, minor: 1 } as const,
      requestSchema: z.object({ n: z.number() }),
      responseSchema: z.object({ n: z.number() }),
    };
    const invalid: UncheckedVersionedRpcRegistry = {
      echo: {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: v0, upgradeFromPreviousVersion: null },
            1: { contract: v1, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    };
    expect(() =>
      // @ts-expect-error the type-level validator rejects this deliberately invalid/widened registry; this asserts the runtime structural pass
      defineVersionedRpcRegistry(invalid),
    ).toThrow(
      "Latest minor 0 for method 'echo' major 1 must be the highest installed minor 1",
    );
  });

  it("stream: latestMinor that is not the highest installed minor", () => {
    const v0 = defineStreamRpcContract({
      method: "echo.subscribe",
      schemaVersion: { major: 1, minor: 0 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(true),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });
    const v1 = defineStreamRpcContract({
      method: "echo.subscribe",
      schemaVersion: { major: 1, minor: 1 } as const,
      openRequestSchema: z.object({ id: z.string() }),
      serverFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("snapshot"),
          hasBinaryPayload: z.literal(true),
        }),
      ]),
      clientFrameSchema: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("ping"),
          hasBinaryPayload: z.literal(false),
        }),
      ]),
    });
    const invalid: UncheckedVersionedStreamRpcRegistry = {
      "echo.subscribe": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: v0 },
            1: { contract: v1 },
          },
        },
      },
    };
    expect(() => defineVersionedStreamRpcRegistry(invalid)).toThrow(
      "Latest minor 0 for method 'echo.subscribe' major 1 must be the highest installed minor 1",
    );
  });

  it("record: latestMinor that is not the highest installed minor", () => {
    const v0 = defineRecordContract({
      name: "echo-record",
      schemaVersion: { major: 1, minor: 0 } as const,
      schema: z.object({ id: z.string() }),
    });
    const v1 = defineRecordContract({
      name: "echo-record",
      schemaVersion: { major: 1, minor: 1 } as const,
      schema: z.object({ id: z.string() }),
    });
    const invalid: UncheckedVersionedRecordRegistry = {
      "echo-record": {
        1: {
          latestMinor: 0,
          versions: {
            0: { contract: v0, upgradeFromPreviousVersion: null },
            1: { contract: v1, upgradeFromPreviousVersion: null },
          },
          downgradePathsFromLatest: {},
        },
      },
    };
    expect(() =>
      // @ts-expect-error the type-level validator rejects this deliberately invalid/widened registry; this asserts the runtime structural pass
      defineVersionedRecordRegistry(invalid),
    ).toThrow(
      "Latest minor 0 for record 'echo-record' major 1 must be the highest installed minor 1",
    );
  });
});

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "__tests__",
  "__fixtures__",
]);

const FINGERPRINT_RELATIVE = "src/framework/json-schema-fingerprint.ts";

type ToJsonSchemaHit = {
  readonly sourceFile: string;
  readonly line: number;
};

function shouldSkipListedPath(relative: string): boolean {
  const posix = relative.split(path.sep).join("/");
  const segments = posix.split("/");
  for (const segment of segments) {
    if (SKIP_DIR_NAMES.has(segment)) {
      return true;
    }
  }
  const base = segments[segments.length - 1];
  if (base === undefined) {
    return true;
  }
  return base.endsWith(".d.ts") || base.endsWith(".test.ts");
}

function listProductionProtocolSrcFiles(): string[] {
  const listing = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src/*.ts",
    ],
    { cwd: PROTOCOL_ROOT, encoding: "utf8" },
  );
  const files: string[] = [];
  for (const relative of listing.split("\0")) {
    if (relative.length === 0 || shouldSkipListedPath(relative)) {
      continue;
    }
    const posix = relative.split(path.sep).join("/");
    if (!posix.startsWith("src/")) {
      continue;
    }
    const full = path.join(PROTOCOL_ROOT, relative);
    if (!existsSync(full)) {
      continue;
    }
    files.push(full);
  }
  return files;
}

function findToJsonSchemaCalls(
  sourceFile: string,
  text: string,
): ToJsonSchemaHit[] {
  const source = ts.createSourceFile(
    sourceFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: ToJsonSchemaHit[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toJSONSchema"
    ) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      hits.push({ sourceFile, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe("no toJSONSchema CallExpression outside json-schema-fingerprint", () => {
  it("finds a planted z.toJSONSchema call", () => {
    expect(
      findToJsonSchemaCalls("planted.ts", "void z.toJSONSchema(z.string());\n"),
    ).toHaveLength(1);
  });

  it("production protocol/src has no toJSONSchema calls outside json-schema-fingerprint.ts", () => {
    const files = listProductionProtocolSrcFiles();
    expect(files.length).toBeGreaterThan(0);
    const hits: ToJsonSchemaHit[] = [];
    for (const filePath of files) {
      const relative = path
        .relative(PROTOCOL_ROOT, filePath)
        .split(path.sep)
        .join("/");
      if (relative === FINGERPRINT_RELATIVE) {
        continue;
      }
      hits.push(
        ...findToJsonSchemaCalls(relative, readFileSync(filePath, "utf8")),
      );
    }
    expect(hits).toEqual([]);
  });
});
