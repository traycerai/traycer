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
 * `chat.subscribe@1.6` - The other half of `released-baseline-compat.test.ts`.
 * That test catches a released line GROWING - an enum or union gaining a value a shipped peer cannot represent.
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

/** Every `properties` key in a JSON-schema tree, as a `/`-joined path. */
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
