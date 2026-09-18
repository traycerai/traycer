import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV80,
  providersListResponseSchemaV90,
  providersListResponseSchemaV91,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Which fields of a RELEASED `providers.list` line still read a LIVE enum?
 *
 * Sharing an enum OBJECT with the head row is the structural definition of "not
 * frozen": grow the head's enum and the released row grows with it, because
 * both names point at one declaration. No other test can see this. The frozen
 * catalog snapshot compares today's BYTES, and a frozen hand-copy and a live
 * alias dump identically - the difference between them only shows up on the day
 * someone edits the live one, which is the day it is too late.
 *
 * This is the guard the `providers.list@9.1` freeze asked for and could not
 * give itself. That freeze pinned four leaves and its own comment had to admit
 * the rest were "NOT every live schema this row can reach", leaving a reader to
 * rediscover which. The list below IS that answer, mechanically derived, and it
 * fails the moment the answer changes.
 *
 * WHEN THIS TEST FAILS:
 *
 *   - A path APPEARED. Someone wired a new live sub-schema into a released
 *     line. Freeze the leaf (hand-copy it under a `...V70`-style name and bind
 *     that), or - if leaving it live is genuinely the right call - add the path
 *     here WITH the reason. Do not add it silently; the whole value of this
 *     list is that every entry was argued for once.
 *   - A path DISAPPEARED. A leaf got pinned. Delete the line. This is the
 *     direction the list is supposed to move.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: the MEMBERS of any enum. Growth is
 * `frozen-catalog-lines.test.ts`'s job and it already dumps every byte. Keying
 * this on paths keeps the two tests from failing together over one edit and
 * makes this one's failure say something the other's cannot.
 *
 * Path notation is the field path from the response root; `[]` is an array
 * element and `|N` selects union arm N.
 */

/**
 * Every field of a released `providers.list` row that still reads a live enum.
 *
 * All four released rows share this exact set - they are the same shape modulo
 * the id enum and a couple of profile keys - so one list covers them and a
 * divergence between rows is itself a failure worth seeing.
 *
 * These are ACCEPTED as live, not endorsed. The accepted reason for all of them
 * is the same and it is a scoping one: pinning a leaf only helps if the
 * downgrade bridge can then drop what the leaf refuses (see
 * `frozen-line-projection.ts`), and the pins that came with that projection were
 * taken where growth had already happened or was already planned -
 * `supportedTabs`, `advisory`, `managedInstallState`, `autoJudge`. The rest are
 * listed here so the next person inherits a measurement instead of a search.
 *
 * Two of them are worth knowing about specifically:
 *
 *   - `denySources[]` appears TWICE - under `native|0|0.servers[]` and again
 *     under `native|0|3.server` - and neither has a `.catch()` between it and
 *     the response root. Growing that enum does not degrade the response, it
 *     fails the whole `providers.list` call. The projection now keeps the call
 *     alive; these are the two leaves where a pin would matter most.
 *   - `managedVersions.available[].installState|4.reason` reaches
 *     `providerManagedInstallErrorReasonSchema` - the SAME enum the row's own
 *     `managedInstallState` was just pinned away from. One field being frozen
 *     says nothing about the other path to the same declaration, which is
 *     precisely the reading error this test exists to make impossible.
 *
 * Both of those facts were invisible until this walk stopped deduplicating by
 * object identity; see `collectEnums`.
 */
const ACCEPTED_LIVE_ENUM_PATHS: readonly string[] = [
  "apiKey.source",
  "auth.status",
  "candidates[].kind",
  "managedVersions.available[].certification",
  "managedVersions.available[].installState|3.reason",
  "managedVersions.available[].installState|4.reason",
  "managedVersionsUnavailable.reason",
  "nativeCapabilities.envOverrideScope",
  "nativeCapabilities.mcp.actionScopes.add[]",
  "nativeCapabilities.mcp.actionScopes.auth[]",
  "nativeCapabilities.mcp.actionScopes.discover[]",
  "nativeCapabilities.mcp.actionScopes.list[]",
  "nativeCapabilities.mcp.actionScopes.remove[]",
  "nativeCapabilities.mcp.actionScopes.toggleServer[]",
  "nativeCapabilities.mcp.actionScopes.toggleTool[]",
  "nativeCapabilities.mcp.actionScopes.update[]",
  "nativeCapabilities.mcp.addServer",
  "nativeCapabilities.mcp.authActions[]",
  "nativeCapabilities.mcp.authTypes[]",
  "nativeCapabilities.mcp.instructionsSource",
  "nativeCapabilities.mcp.oauthFields[]",
  "nativeCapabilities.mcp.perToolBacking",
  "nativeCapabilities.mcp.removeServer",
  "nativeCapabilities.mcp.schemasSource",
  "nativeCapabilities.mcp.statusSource",
  "nativeCapabilities.mcp.toolsSource",
  "nativeCapabilities.mcp.transports[]",
  "nativeCapabilities.mcp.updateServer",
  "nativeCapabilities.modelProviders.actions[]",
  "nativeCapabilities.plugins.actionScopes.add[]",
  "nativeCapabilities.plugins.actionScopes.list[]",
  "nativeCapabilities.plugins.actionScopes.remove[]",
  "nativeCapabilities.plugins.actionScopes.setEnabled[]",
  "nativeCapabilities.plugins.addModes[]",
  "nativeCapabilities.skills.actionScopes.add[]",
  "nativeCapabilities.skills.actionScopes.create[]",
  "nativeCapabilities.skills.actionScopes.edit[]",
  "nativeCapabilities.skills.actionScopes.import[]",
  "nativeCapabilities.skills.actionScopes.inspect[]",
  "nativeCapabilities.skills.actionScopes.list[]",
  "nativeCapabilities.skills.actionScopes.remove[]",
  "nativeCapabilities.skills.actionScopes.update[]",
  "native|0|0.servers[].status",
  "native|0|0.servers[].statusSource",
  "native|0|0.servers[].tools[].denySources[]",
  "native|0|2.skills[].source",
  "native|0|3.server.status",
  "native|0|3.server.statusSource",
  "native|0|3.server.tools[].denySources[]",
  "native|1.code",
  "nextRunBinary.kind",
  "profiles[].accentColor",
  "profiles[].auth.status",
  "profiles[].authType",
  "profiles[].kind",
  "profiles[].rateLimitLimitedScopes[].severity",
  "profiles[].rateLimitStatus",
  "profiles[].reusedTombstone.accentColor",
];

/**
 * Depth ceiling for the walk. Not a tuning knob - it is the termination
 * guarantee that replaces identity dedup, set far above the deepest real path
 * (about 8) so tripping it means a genuinely recursive schema arrived and this
 * walk needs rethinking, not a bigger number.
 */
const MAX_WALK_DEPTH = 50;

/**
 * A schema's definition, widened with the child-schema fields zod puts on the
 * specific node kinds - same shape as `frozen-line-projection.ts` uses, and
 * deliberately re-stated rather than exported from there: this walk is a test
 * fixture, and a guard that shares its traversal with the code under test stops
 * being an independent check of it.
 */
type ZodNodeDef = z.core.$ZodTypeDef & {
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly options?: readonly z.ZodType[];
};

function defOf(schema: z.ZodType): ZodNodeDef {
  return schema._zod.def;
}

/**
 * Collect every enum reachable from `schema`, keyed by identity, with the field
 * path that reaches it. Object identity is the point - two structurally equal
 * enums that are separate declarations are correctly NOT the same entry.
 */
function collectEnums(
  schema: z.ZodType,
  path: string,
  found: Map<z.ZodType, string[]>,
  depth: number,
): void {
  // Bounded by DEPTH, not by object identity. Deduplicating on identity is the
  // obvious way to guarantee termination and it silently drops paths: any
  // object schema reached twice reports only its first location, which hid
  // `auth.status` and the whole `native` union's fourth arm - including a
  // SECOND `denySources` with no catch over it. Nothing here can cycle, because
  // zod recursion goes through `z.lazy` and the walk does not follow it.
  if (depth > MAX_WALK_DEPTH) {
    throw new Error(`schema walk exceeded depth ${MAX_WALK_DEPTH} at ${path}`);
  }
  const def = defOf(schema);
  switch (def.type) {
    case "enum": {
      const paths = found.get(schema);
      if (paths) paths.push(path);
      else found.set(schema, [path]);
      return;
    }
    case "catch":
    case "optional":
    case "nullable":
    case "default":
    case "nonoptional":
    case "readonly": {
      if (def.innerType) collectEnums(def.innerType, path, found, depth + 1);
      return;
    }
    case "array": {
      if (def.element) {
        collectEnums(def.element, `${path}[]`, found, depth + 1);
      }
      return;
    }
    case "object": {
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        collectEnums(child, path ? `${path}.${key}` : key, found, depth + 1);
      }
      return;
    }
    case "union": {
      for (const [index, arm] of (def.options ?? []).entries()) {
        collectEnums(arm, `${path}|${index}`, found, depth + 1);
      }
      return;
    }
    case "record": {
      if (def.valueType) {
        collectEnums(def.valueType, `${path}{}`, found, depth + 1);
      }
      return;
    }
    default:
      return;
  }
}

function enumsOf(schema: z.ZodType): Map<z.ZodType, string[]> {
  const found = new Map<z.ZodType, string[]>();
  collectEnums(schema, "", found, 0);
  return found;
}

/** Paths on `row` whose enum is the very object the live head row also reads. */
function liveEnumPaths(row: z.ZodType): string[] {
  const live = enumsOf(providersListResponseSchema);
  const paths: string[] = [];
  for (const [enumSchema, where] of enumsOf(row)) {
    if (!live.has(enumSchema)) continue;
    // EVERY path, not one representative per enum. A representative would make
    // this blind to the case that matters most: a NEW field wired to an enum
    // already on the list. `nativeCapabilities.mcp.removeServer`,
    // `.schemasSource`, `.toolsSource`, every `actionScopes.*` variant and
    // `profiles[].reusedTombstone.accentColor` are all real paths a
    // one-per-enum list hid, and the set went from 29 to 54 when this was
    // fixed - so the shortcut was already concealing two thirds of the answer.
    for (const path of where) paths.push(path.replace("providers[].", ""));
  }
  return paths.sort();
}

const RELEASED_ROWS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["providers.list@7.0", providersListResponseSchemaV70],
  ["providers.list@8.0", providersListResponseSchemaV80],
  ["providers.list@9.0", providersListResponseSchemaV90],
  ["providers.list@9.1", providersListResponseSchemaV91],
];

describe("released providers.list lines reach no UNREVIEWED live enum", () => {
  for (const [label, row] of RELEASED_ROWS) {
    it(`${label} reaches exactly the reviewed set`, () => {
      expect(liveEnumPaths(row)).toEqual([...ACCEPTED_LIVE_ENUM_PATHS]);
    });
  }

  it("the head row is NOT subject to this rule, by design", () => {
    // The head line is supposed to bind live schemas - that is how the next
    // growth attempt reddens the catalog snapshot here first. If this ever came
    // out empty it would mean the head had been frozen by mistake and nothing
    // was tracking live any more.
    expect(liveEnumPaths(providersListResponseSchema).length).toBeGreaterThan(
      ACCEPTED_LIVE_ENUM_PATHS.length,
    );
  });

  it("detects a leaf that is live rather than merely enum-shaped", () => {
    // Control for the test itself: an enum that is a separate DECLARATION with
    // identical members must not be reported, or this would be measuring shape
    // instead of identity and every frozen hand-copy would read as a leak.
    const handCopy = z.object({ kind: z.enum(["stored", "env"]) });
    expect(liveEnumPaths(handCopy)).toEqual([]);
  });
});
