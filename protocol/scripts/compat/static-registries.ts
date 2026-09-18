/**
 * Every static registry `@traycer/protocol` declares, and the FULL validation
 * each one is held to.
 *
 * The `define*` registry factories run only their structural pass, so that
 * importing a registry module walks no schema (a walk builds a JSON Schema of
 * every installed version and materialises every lazily built schema). The
 * schema-compatibility pass - additivity within a major line, a real breaking
 * change across majors, the `responseGrowthProjectionGated` and
 * `semanticMajorBreakFromPreviousMajor` annotations being valid and
 * load-bearing - therefore runs HERE instead, at build time
 * (`validate-static-registries.ts`, the last step of this package's `build`)
 * and in CI (`__tests__/static-registries.test.ts`).
 *
 * This changes WHEN a bad registry is caught, not whether: a registry left off
 * this list would never be checked at all. The tripwire suite scans the source
 * tree for registry factory calls and fails on any call site this list does not
 * name, so adding a registry without adding it here reddens CI.
 *
 * The released-tag comparison (`check-protocol-compat.ts`), the frozen surfaces
 * and the semantic codec tests are separate gates and are unchanged: a
 * fingerprint cannot see preprocess and refinement semantics.
 *
 * Imports stay relative, like the rest of this directory.
 */
import {
  validateVersionedRecordRegistry,
  type UncheckedVersionedRecordRegistry,
} from "../../src/framework/versioned-record";
import {
  validateVersionedRpcRegistry,
  validateVersionedRpcRegistryDegrades,
  type UncheckedVersionedRpcRegistry,
} from "../../src/framework/versioned-rpc";
import {
  validateVersionedStreamRpcRegistry,
  type UncheckedVersionedStreamRpcRegistry,
} from "../../src/framework/versioned-stream-rpc";
import { authRecordRegistry } from "../../src/auth/registry";
import { commonRecordRegistry } from "../../src/common/registry";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "../../src/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "../../src/host/released-floor";
import { persistenceRecordRegistry } from "../../src/persistence/registry";

/**
 * One static registry. `sourceFile` is the module that constructs it, relative
 * to the `protocol/` package root, and is what the tripwire matches factory
 * call sites against; `name` is its exported binding.
 */
export type StaticRegistry =
  | {
      readonly kind: "unary-rpc";
      readonly name: string;
      readonly sourceFile: string;
      readonly registry: UncheckedVersionedRpcRegistry;
      /**
       * The floor list a `defineFloorAwareVersionedRpcRegistry` registry was
       * constructed with, or `null` for a plain `defineVersionedRpcRegistry`.
       */
      readonly floorMethodNames: readonly string[] | null;
    }
  | {
      readonly kind: "stream-rpc";
      readonly name: string;
      readonly sourceFile: string;
      readonly registry: UncheckedVersionedStreamRpcRegistry;
    }
  | {
      readonly kind: "record";
      readonly name: string;
      readonly sourceFile: string;
      readonly registry: UncheckedVersionedRecordRegistry;
    };

export const STATIC_REGISTRIES: readonly StaticRegistry[] = [
  {
    kind: "unary-rpc",
    name: "hostRpcRegistry",
    sourceFile: "src/host/registry.ts",
    registry: hostRpcRegistry,
    floorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
  },
  {
    kind: "stream-rpc",
    name: "hostStreamRpcRegistry",
    sourceFile: "src/host/registry.ts",
    registry: hostStreamRpcRegistry,
  },
  {
    kind: "record",
    name: "persistenceRecordRegistry",
    sourceFile: "src/persistence/registry.ts",
    registry: persistenceRecordRegistry,
  },
  {
    kind: "record",
    name: "authRecordRegistry",
    sourceFile: "src/auth/registry.ts",
    registry: authRecordRegistry,
  },
  {
    kind: "record",
    name: "commonRecordRegistry",
    sourceFile: "src/common/registry.ts",
    registry: commonRecordRegistry,
  },
];

/**
 * Runs the full validation for one registry: both passes, and for a
 * floor-aware unary registry the degrade check it was constructed with.
 * Throws the validator's own error.
 */
export function validateStaticRegistry(entry: StaticRegistry): void {
  switch (entry.kind) {
    case "unary-rpc":
      validateVersionedRpcRegistry(entry.registry);
      if (entry.floorMethodNames !== null) {
        validateVersionedRpcRegistryDegrades(
          entry.registry,
          entry.floorMethodNames,
        );
      }
      return;
    case "stream-rpc":
      validateVersionedStreamRpcRegistry(entry.registry);
      return;
    case "record":
      validateVersionedRecordRegistry(entry.registry);
      return;
  }
}

export type StaticRegistryFailure = {
  readonly name: string;
  readonly sourceFile: string;
  readonly message: string;
};

/**
 * Validates every entry and returns every failure rather than stopping at the
 * first, so one run names every broken registry.
 */
export function findStaticRegistryFailures(
  entries: readonly StaticRegistry[],
): StaticRegistryFailure[] {
  const failures: StaticRegistryFailure[] = [];
  for (const entry of entries) {
    try {
      validateStaticRegistry(entry);
    } catch (error) {
      failures.push({
        name: entry.name,
        sourceFile: entry.sourceFile,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}
