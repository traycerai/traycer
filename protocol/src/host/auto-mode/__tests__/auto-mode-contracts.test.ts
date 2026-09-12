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
import { providerCliStateSchema } from "@traycer/protocol/host/provider-schemas";

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
/**
 * The minimum a live `ProviderCliState` needs; every other field carries a
 * `.catch(...)` and fills itself. Deliberately does NOT name `autoJudge` - two
 * of the assertions below are about what happens when it is absent.
 */
function providerStateFixture(): Record<string, unknown> {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
  };
}

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

  it("publishes the stored judge on the head providers.list line only", () => {
    // `providers.setAutoJudge` writes; without this read half the Providers >
    // General switch could not show its own value after a reload.
    const majorNine = hostRpcRegistry["providers.list"][9];
    const head = majorNine.versions[majorNine.latestMinor].contract;
    const frozen = majorNine.versions[0].contract;

    const withJudge = {
      ...providerStateFixture(),
      autoJudge: "provider" as const,
    };
    const headParsed = head.responseSchema.parse({
      providers: [withJudge],
      native: null,
    });
    expect(headParsed.providers[0].autoJudge).toBe("provider");

    // 9.0 needs no bridge: a new KEY is STRIPPED by the within-major re-parse,
    // unlike a new enum member, which would fail the whole response. That is
    // the entire reason this rides a minor with no emission gating.
    const frozenParsed = frozen.responseSchema.parse({
      providers: [withJudge],
      native: null,
    });
    expect(Object.hasOwn(frozenParsed.providers[0], "autoJudge")).toBe(false);
  });

  it("leaves `autoJudge` absent rather than defaulted", () => {
    // `.optional()`, not `.default("traycer")`: absent must stay absent so the
    // field is not required on OUTPUT, which is what keeps it out of every
    // `ProviderCliState` construction site in the renderer. Readers spell the
    // fallback themselves.
    const parsed = providerCliStateSchema.parse(providerStateFixture());
    expect(Object.hasOwn(parsed, "autoJudge")).toBe(false);
    expect(parsed.autoJudge ?? "traycer").toBe("traycer");
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

  it("distinguishes an unreadable read from a stale one, and both from an absent readState", () => {
    // Three responses that could easily collapse to the same decoded shape if
    // `readState` were defaulted instead of left optional - the panel treats
    // all three as different situations, so the schema must keep them apart.
    const neverWrittenOrOlderHost = autoPolicyGetV10.responseSchema.parse({
      body: null,
      updatedAt: null,
      source: "account",
    });
    const unreadable = autoPolicyGetV10.responseSchema.parse({
      body: null,
      updatedAt: null,
      source: "account",
      readState: "unreadable",
    });
    const stale = autoPolicyGetV10.responseSchema.parse({
      body: "a cached policy body",
      updatedAt: null,
      source: "account",
      readState: "stale",
    });

    expect(unreadable.readState).toBe("unreadable");
    expect(stale.readState).toBe("stale");
    expect(stale.body).toBe("a cached policy body");
    // `neverWrittenOrOlderHost` and `unreadable` share body/updatedAt exactly -
    // the only wire signal that tells them apart is whether `readState` is
    // present at all.
    expect(neverWrittenOrOlderHost.body).toBe(unreadable.body);
    expect(neverWrittenOrOlderHost.updatedAt).toBe(unreadable.updatedAt);
  });

  it("decodes a response without `readState` with the property absent, not defaulted", () => {
    // `.optional()`, not `.default("fresh")`: the fallback belongs to the
    // READER (`autoPolicyReadStateFor`), because a schema-level default would
    // make an older host's response indistinguishable, on the wire, from one
    // that positively answered "fresh".
    const parsed = autoPolicyGetV10.responseSchema.parse({
      body: "hello",
      updatedAt: "2026-09-10T00:00:00.000Z",
      source: "account",
    });
    expect(Object.hasOwn(parsed, "readState")).toBe(false);
    expect(parsed.readState).toBeUndefined();
  });

  it("rejects an unknown read state", () => {
    expect(
      autoPolicyGetV10.responseSchema.safeParse({
        body: null,
        updatedAt: null,
        source: "account",
        readState: "corrupted",
      }).success,
    ).toBe(false);
  });

  it("round-trips `shippedDefaults` verbatim and leaves it absent when not sent", () => {
    const document = "## Allow exceptions\n\n- Read files in the workspace.\n";
    const withShipped = autoPolicyGetV10.responseSchema.parse({
      body: null,
      updatedAt: null,
      source: "account",
      shippedDefaults: document,
    });
    expect(withShipped.shippedDefaults).toBe(document);

    const withoutShipped = autoPolicyGetV10.responseSchema.parse({
      body: null,
      updatedAt: null,
      source: "account",
    });
    expect(Object.hasOwn(withoutShipped, "shippedDefaults")).toBe(false);
  });
});
