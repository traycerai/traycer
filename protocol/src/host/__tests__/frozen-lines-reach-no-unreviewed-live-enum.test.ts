import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV80,
  providersListResponseSchemaV90,
  providersListResponseSchemaV91,
} from "@traycer/protocol/host/provider-schemas";
import { providerSettingsTabSchema } from "@traycer/protocol/host/provider-native-schemas";

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
 * All four released rows reach this exact set, which is an assertion below and
 * not an assumption here - each row gets its own `it`. They are NOT the same
 * shape: 9.0 and 9.1 carry fields 7.0 never had. They coincide because every
 * field those later rows added was pinned rather than left live, so it
 * contributes no path. That is the invariant worth watching - a row diverging
 * from the others means a new field went onto a released line still reading
 * live, and the row that diverges names the line it happened on.
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
 *     fails the whole `providers.list` call. The two are NOT equally salvage-
 *     able, and the difference is the array: the `servers[]` one sits under one
 *     and so a pin there would let the projection drop the member and keep the
 *     call; the `native|0|3.server` one is the single-server arm, where the
 *     unknown member has no array to be dropped from, so a pin alone still
 *     fails the call and what it needs is a `.catch()`. Same enum, two leaves,
 *     two different fixes - which is the argument for reading the path and not
 *     just the field name.
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
 * guarantee that replaces identity dedup. The deepest real path is 13, measured
 * rather than eyeballed, and it is the same 13 on all four released rows and on
 * the head: `native|0|0.servers[].transport|0.env[].name`. 50 is set far enough
 * above that so tripping it means a genuinely recursive schema arrived and this
 * walk needs rethinking, not a bigger number.
 */
const MAX_WALK_DEPTH = 50;

/**
 * Node kinds that cannot contain another schema, so reaching one ends that
 * branch honestly. Everything NOT listed here is a kind this walk does not know
 * how to traverse, and the difference matters: a kind that can hold a child
 * schema must be traversed or the guard goes vacuously green through it.
 */
const INERT_LEAF_KINDS = new Set([
  "string",
  "number",
  "int",
  "boolean",
  "bigint",
  "symbol",
  "date",
  "file",
  "literal",
  "null",
  "undefined",
  "void",
  "never",
  "any",
  "unknown",
  "nan",
  "template_literal",
  "custom",
]);

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
  // A record has TWO child schemas and zod stores both on the def. Omitting
  // `keyType` here is not a missing convenience - it is the walk silently
  // skipping a child, which is the one failure mode this guard cannot have.
  readonly keyType?: z.ZodType;
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
      // BOTH children, with distinct markers. Walking only the value was this
      // guard's own named hole: the `default:` note below lists "a `z.record`
      // whose KEY is the enum" as a way to go vacuously green, and `record` is
      // a HANDLED kind, so the throw down there never fires for it - the key
      // enum was just dropped in silence. Today every record on these rows is
      // `tools[].inputSchema` (`key=string`, `value=unknown`), so this walks
      // nothing new; it is here for the row that binds an enum-keyed record
      // later, which is precisely the case the list cannot be trusted to catch
      // by inspection.
      if (def.valueType) {
        collectEnums(def.valueType, `${path}{}`, found, depth + 1);
      }
      if (def.keyType) {
        collectEnums(def.keyType, `${path}{key}`, found, depth + 1);
      }
      return;
    }
    default:
      // An unrecognised node kind must STOP the walk, never be skipped. A skip
      // makes this whole guard vacuously green: bind the live tab enum onto a
      // released row behind a `z.lazy`, `z.tuple`, `z.intersection`,
      // `.transform()`, `z.set`, or a `z.record` whose KEY is the enum, and a
      // silently-returning walk reports no path and passes while the leak is
      // real. None of those kinds is in these rows today - which is exactly
      // when to make that a checked fact rather than a standing assumption.
      if (!INERT_LEAF_KINDS.has(def.type)) {
        throw new Error(
          `unhandled schema kind "${def.type}" at ${path || "<root>"} - teach ` +
            `collectEnums to traverse it before this guard can be trusted`,
        );
      }
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
    // one-per-enum list hid: the set went 29 -> 54 when this was fixed, and
    // 54 -> 58 when identity dedup came out of `collectEnums`. So the two
    // shortcuts between them were hiding 29 of the 58 real paths - half the
    // answer, from a walk that looked exhaustive.
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

  it("sees an enum used as a record KEY, not just as a record value", () => {
    // Raised in review, and it was this guard's own documented hole: the
    // `default:` branch names "a `z.record` whose KEY is the enum" as a way to
    // pass vacuously, but `record` is a HANDLED kind, so that throw never fires
    // for it - the walk simply skipped the key in silence.
    //
    // No row binds an enum-keyed record today (every record on these rows is
    // `tools[].inputSchema`, `key=string`), which is exactly why this needs a
    // synthetic fixture: there is no natural one to notice the omission with,
    // and "no current row does this" is how a latent hole stays open.
    // `providerSettingsTabSchema` is imported directly rather than plucked out
    // of `enumsOf(...)`, for two reasons. `z.record` needs a key typed as a
    // `$ZodRecordKey`, which the map's `z.ZodType` values are not; and pinning
    // a NAMED live enum makes the fixture say which declaration it is proving
    // reachable, instead of whichever one the walk happened to yield first.
    // It is live by construction - the head row binds this very object, which
    // `the head row is NOT subject to this rule` above depends on too.
    const keyed = z.object({
      byTab: z.record(providerSettingsTabSchema, z.string()),
    });
    expect(liveEnumPaths(keyed)).toEqual(["byTab{key}"]);

    // The value side still works, and the two are told apart by their marker -
    // so a future failure names which half of the record leaked.
    const valued = z.object({
      byName: z.record(z.string(), providerSettingsTabSchema),
    });
    expect(liveEnumPaths(valued)).toEqual(["byName{}"]);
  });

  it("detects a leaf that is live rather than merely enum-shaped", () => {
    // Control for the test itself: an enum that is a separate DECLARATION with
    // identical members must not be reported, or this would be measuring shape
    // instead of identity and every frozen hand-copy would read as a leak.
    const handCopy = z.object({ kind: z.enum(["stored", "env"]) });
    expect(liveEnumPaths(handCopy)).toEqual([]);
  });
});
