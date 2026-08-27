import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * The other half of `released-baseline-compat.test.ts`.
 *
 * That test catches a released line GROWING - an enum or union gaining a value
 * a shipped peer cannot represent. This one catches a released line SHRINKING:
 * an in-repo frozen schema that no longer describes a field the released
 * surface actually carries.
 *
 * Narrowing is quieter than growth and can be worse. A field the frozen schema
 * has forgotten is silently DROPPED on parse, so a peer built from this repo
 * talks to a released host, receives the field on the wire, and hands its
 * consumers an object without it - no error anywhere, just state that vanished.
 *
 * This is not hypothetical. Freezing `chat.subscribe@1.6` transcribed
 * `claudePendingWakes` from the `1.5` bundle instead of from what `1.6`
 * shipped, dropping `retryDeadlineStartedAt` and `heldChain`. A pending Claude
 * wake parked behind a detached interview would have lost the chain the host
 * needs to restore it. `released-baseline-compat.test.ts` was green throughout,
 * because losing a field is not growth.
 *
 * **A frozen line is transcribed from what SHIPPED, never from the line below
 * it.** That is the rule this test enforces mechanically.
 */

const fixturePath = join(
  import.meta.dirname,
  "__fixtures__/released-baseline-surface.json",
);

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every `properties` key in a JSON-schema tree, as a `/`-joined path.
 *
 * Paths rather than a flat name set, so a field lost from one nested object is
 * not masked by the same name surviving somewhere else in the frame.
 *
 * `oneOf` branches are indexed positionally. That is sound for these frames
 * because the surface builder emits union variants in declaration order and
 * both sides of the comparison come from the same builder — the fixture is a
 * previous run of it. If a variant is ever REORDERED the paths shift and this
 * test fails loudly, which is the correct outcome: reordering a released
 * union's variants is itself a change worth stopping on.
 */
function propertyPaths(node: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      propertyPaths(child, `${prefix}/${index}`, out),
    );
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        const path = `${prefix}/${name}`;
        out.add(path);
        propertyPaths(child, path, out);
      }
      continue;
    }
    propertyPaths(value, `${prefix}/${key}`, out);
  }
}

function pathsFor(schema: unknown): Set<string> {
  const out = new Set<string>();
  propertyPaths(schema, "", out);
  return out;
}

describe("released chat.subscribe lines never lose a field they shipped", () => {
  it("describes every property the released baseline carries, on every frozen minor", () => {
    const baseline: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    const mine = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });

    const baselineStream = isRecord(baseline) ? baseline.stream : undefined;
    const baselineMethod = isRecord(baselineStream)
      ? baselineStream["chat.subscribe"]
      : undefined;
    const baselineSchemas = isRecord(baselineMethod)
      ? baselineMethod.schemas
      : undefined;
    const mineSchemas: unknown = mine.stream["chat.subscribe"]?.schemas;

    expect(isRecord(baselineSchemas)).toBe(true);
    expect(isRecord(mineSchemas)).toBe(true);
    if (!isRecord(baselineSchemas) || !isRecord(mineSchemas)) return;

    const missingByMinor: Record<string, string[]> = {};
    for (const [minor, baselineSchema] of Object.entries(baselineSchemas)) {
      const mineSchema = mineSchemas[minor];
      // A minor the baseline has and we do not is a different failure, already
      // covered by the released-floor and stream-surface guards.
      if (mineSchema === undefined) continue;

      const theirs = pathsFor(baselineSchema);
      const ours = pathsFor(mineSchema);
      const missing = [...theirs].filter((path) => !ours.has(path)).sort();
      if (missing.length > 0) missingByMinor[minor] = missing;
    }

    expect(
      missingByMinor,
      Object.keys(missingByMinor).length === 0
        ? undefined
        : "A released chat.subscribe line lost a field it shipped. Transcribe " +
            "the frozen schema from the BASELINE, not from the minor below it - " +
            "a dropped field is silently stripped on parse, with no error " +
            `anywhere. Missing: ${JSON.stringify(missingByMinor, null, 2)}`,
    ).toEqual({});
  });
});
