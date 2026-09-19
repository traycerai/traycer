import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  lazySchema,
  lazySchemaStats,
} from "@traycer/protocol/framework/lazy-schema";
import {
  checkForcedStandIn,
  countModuleScopeLazySchemaCalls,
  firstFrameOutsideLazySchema,
  listLazySchemaModules,
  recordedCountForFile,
  type ZeroCountFile,
} from "./lazy-schema-force-check";

/**
 * Force every protocol `lazySchema` stand-in and compare it to an eager twin
 * from the recorded `build()`. The mock records each call; relative imports
 * of `./lazy-schema` resolve to the same mocked module.
 */

type RecordedStandIn = {
  readonly standIn: object;
  readonly build: () => object;
  readonly site: string;
};

const records: RecordedStandIn[] = [];

vi.mock("@traycer/protocol/framework/lazy-schema", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@traycer/protocol/framework/lazy-schema")
    >();
  return {
    ...actual,
    lazySchema(build: () => { readonly _zod: object }) {
      const standIn = actual.lazySchema(build);
      records.push({
        standIn,
        build,
        site: firstFrameOutsideLazySchema(new Error().stack, [
          "force-all.test.ts",
          "lazy-schema-force-check.ts",
        ]),
      });
      return standIn;
    },
  };
});

const PROTOCOL_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const ZERO_MODULE_SCOPE_LAZY_SCHEMA: readonly ZeroCountFile[] = [
  {
    file: "src/framework/lazy-schema.ts",
    reason:
      "the helper definition; `lazySchema(` appears only in comments and the function declaration",
  },
  {
    file: "src/persistence/chat-sync/residual.ts",
    reason:
      "comments only; the four `lazySchema(declareResidualCapture(...))` calls live in core.ts and host-private.ts",
  },
];

describe("lazySchema force-all protocol stand-ins", () => {
  it("planted outermost .describe is a refusal and an extra _zod key is a key difference", () => {
    const describedCheck = checkForcedStandIn(
      lazySchema(() => z.string().describe("planted-force-all")),
      () => z.string().describe("planted-force-all"),
    );
    expect(describedCheck.refused).toBe(true);
    expect(describedCheck.refusalMessage).toMatch(/global-registry metadata/);

    const extraZod = {
      def: {},
      constr: {},
      traits: new Set<string>(),
      plantedExtra: 1,
    };
    const extraCheck = checkForcedStandIn({ _zod: extraZod }, () => ({
      _zod: { def: {}, constr: {}, traits: new Set<string>() },
    }));
    expect(extraCheck.refused).toBe(false);
    expect(extraCheck.extraOnStandIn).toContain("_zod.plantedExtra");
  });

  // OSS 1.6 s warm; host 2.5 s warm. Boot-graph ran 9 s warm and 181 s
  // under load (~20x). CI shards are cold on 2 vCPU.
  it(
    "forcing every protocol lazySchema stand-in matches its eager twin",
    { timeout: 120_000, retry: 0 },
    async () => {
      const modules = listLazySchemaModules(
        PROTOCOL_ROOT,
        ["src/"],
        ["src/*.ts"],
      );
      expect(modules.length).toBeGreaterThan(0);
      const before = lazySchemaStats();
      const beforeCount = records.length;
      const importErrors: string[] = [];
      for (const abs of modules) {
        try {
          await import(pathToFileURL(abs).href);
        } catch (error) {
          importErrors.push(
            `${abs}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      expect(importErrors).toEqual([]);
      const recorded = records.slice(beforeCount);
      expect(recorded.length).toBeGreaterThanOrEqual(3000);
      expect(lazySchemaStats().declared - before.declared).toBe(
        recorded.length,
      );

      const zeroCount: string[] = [];
      const short: string[] = [];
      for (const abs of modules) {
        const posix = path
          .relative(PROTOCOL_ROOT, abs)
          .split(path.sep)
          .join("/");
        const scopeCount = countModuleScopeLazySchemaCalls(abs);
        const recordedN = recordedCountForFile(recorded, abs, posix);
        if (scopeCount === 0) {
          zeroCount.push(posix);
          continue;
        }
        if (recordedN < scopeCount) {
          short.push(`${posix}: recorded ${recordedN} < scope ${scopeCount}`);
        }
      }
      expect(short).toEqual([]);
      expect(zeroCount.sort()).toEqual(
        ZERO_MODULE_SCOPE_LAZY_SCHEMA.map((entry) => entry.file).sort(),
      );

      const failures: string[] = [];
      for (const entry of recorded) {
        const check = checkForcedStandIn(entry.standIn, entry.build);
        if (check.refused) {
          failures.push(`refusal ${entry.site}: ${check.refusalMessage}`);
          continue;
        }
        if (check.missingOnStandIn.length > 0) {
          failures.push(
            `missing ${entry.site}: ${check.missingOnStandIn.join(",")}`,
          );
        }
        if (check.extraOnStandIn.length > 0) {
          failures.push(
            `extra ${entry.site}: ${check.extraOnStandIn.join(",")}`,
          );
        }
        if (!check.traitsEqual) {
          failures.push(`traits ${entry.site}`);
        }
        if (!check.registryEqual) {
          failures.push(`registry ${entry.site}`);
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
