import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  autoJudgeGetV10,
  autoJudgeSelectionSchema,
  autoJudgeSetV10,
  autoPolicyGetV10,
  autoPolicySetV10,
  providersSetAutoJudgeV10,
} from "@traycer/protocol/host/auto-mode/contracts";
import {
  ALL_PERMISSION_MODES,
  ALL_PERMISSION_MODES_PRE_AUTO,
  permissionModeSchema,
  permissionModeSchemaPreAuto,
} from "@traycer/protocol/persistence/epic/foundation";

/**
 * The auto-mode protocol change, asserted where a compile cannot see it.
 *
 * ## Why the import above is the load-bearing line
 *
 * `@traycer/protocol/host/index` runs `defineVersionedRpcRegistry` and
 * `defineVersionedStreamRpcRegistry` at module load, and those do the FULL
 * structural and schema-compatibility validation - contiguous minors, an
 * installed `latestMinor`, upgrade paths between consecutive minors, downgrades
 * anchored at each major's latest, per-lane additivity, and the
 * `responseGrowthProjectionGated` / `semanticMajorBreakFromPreviousMajor`
 * annotations being both valid AND load-bearing.
 *
 * All of that is a RUNTIME throw. `bun run --cwd traycer compile` returns 0 on
 * a registry that cannot be constructed, and so does the root compile, because
 * a `throw` inside a module-level call is not a type error. The failure surfaces
 * as every RPC in the app dying at startup. So a test whose only job is to
 * import the registry is not ceremony: it is the only cheap gate between a bad
 * annotation and a dead build.
 *
 * `agent.gui.listHarnesses@8.1` is the annotation this guards today. It grows
 * `supportedPermissionModes` by one member over 8.0, which the response lane
 * refuses by default; the entry claims the growth is emission-gated, and the
 * validator rejects that claim if the growth ever disappears.
 */
describe("auto-mode protocol change", () => {
  it("constructs both host registries (the annotations parse)", () => {
    // Reached only if the module-level validation above did not throw. The
    // assertions restate that rather than adding coverage.
    expect(Object.keys(hostRpcRegistry).length).toBeGreaterThan(0);
    expect(Object.keys(hostStreamRpcRegistry).length).toBeGreaterThan(0);
  });

  it("declares `auto` between auto_accept_edits and full_access", () => {
    // Order is load-bearing, not cosmetic: `ALL_PERMISSION_MODES` is documented
    // most-restrictive to most-permissive and the renderer's clamp walks it in
    // that order. `auto` sits above `auto_accept_edits` because it does
    // everything that mode does and additionally lets a judge approve commands.
    expect(ALL_PERMISSION_MODES).toEqual([
      "supervised",
      "auto_accept_edits",
      "auto",
      "full_access",
    ]);
    expect(permissionModeSchema.safeParse("auto").success).toBe(true);
  });

  it("keeps the frozen mode enum and its default free of `auto`", () => {
    expect(ALL_PERMISSION_MODES_PRE_AUTO).toEqual([
      "supervised",
      "auto_accept_edits",
      "full_access",
    ]);
    expect(permissionModeSchemaPreAuto.safeParse("auto").success).toBe(false);
    // The default matters as much as the enum: zod fills a `.default(...)`
    // without re-validating it, so a frozen slot defaulting to the LIVE list
    // would hand a released peer the very value its enum rejects.
    expect(ALL_PERMISSION_MODES_PRE_AUTO).not.toContain("auto");
  });

  it("registers all five settings methods off the released floor", () => {
    // The floor is fail-closed on the method-name UNION: a name present on only
    // one peer makes the WHOLE connection incompatible, which is how
    // `worktree.readScriptsAtRef` broke 1.0.1-rc.1. New methods must therefore
    // stay out of it and state their missing-peer behaviour instead.
    const methods = [
      "providers.setAutoJudge",
      "autoJudge.get",
      "autoJudge.set",
      "autoPolicy.get",
      "autoPolicy.set",
    ] as const;

    for (const method of methods) {
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      const entry = hostRpcRegistry[method];
      expect(entry).toBeDefined();
      expect(entry.degrade).toEqual({ kind: "unsupported" });
      expect(entry[1].latestMinor).toBe(0);
    }

    expect(
      hostRpcRegistry["providers.setAutoJudge"][1].versions[0].contract,
    ).toBe(providersSetAutoJudgeV10);
    expect(hostRpcRegistry["autoJudge.get"][1].versions[0].contract).toBe(
      autoJudgeGetV10,
    );
    expect(hostRpcRegistry["autoJudge.set"][1].versions[0].contract).toBe(
      autoJudgeSetV10,
    );
    expect(hostRpcRegistry["autoPolicy.get"][1].versions[0].contract).toBe(
      autoPolicyGetV10,
    );
    expect(hostRpcRegistry["autoPolicy.set"][1].versions[0].contract).toBe(
      autoPolicySetV10,
    );
  });

  it("keeps the judge selection's harness id an open string", () => {
    // A closed enum here would make a selection written on a newer harness
    // roster fail an older client's decode - and it is the whole selection that
    // fails, not the id. The host is the only side that resolves it to a real
    // adapter.
    expect(
      autoJudgeSelectionSchema.safeParse({
        harnessId: "a-harness-this-build-has-never-heard-of",
        model: "some-model",
        profileId: null,
      }).success,
    ).toBe(true);
    // Open, not absent: an empty id is still a bug.
    expect(
      autoJudgeSelectionSchema.safeParse({
        harnessId: "",
        model: "m",
        profileId: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown judge kind", () => {
    expect(
      providersSetAutoJudgeV10.requestSchema.safeParse({
        harnessId: "claude",
        autoJudge: "somebody-else",
      }).success,
    ).toBe(false);
    expect(
      providersSetAutoJudgeV10.requestSchema.safeParse({
        harnessId: "claude",
        autoJudge: "traycer",
      }).success,
    ).toBe(true);
  });
});
