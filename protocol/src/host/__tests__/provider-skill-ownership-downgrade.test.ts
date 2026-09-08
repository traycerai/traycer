import { describe, expect, it } from "vitest";
import { upgradeResponseToVersion } from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  providersListDowngradeV9ToV7,
  providersListDowngradeV9ToV8,
} from "@traycer/protocol/host/registry";
import {
  providersListResponseSchema,
  providersListResponseSchemaV70,
  providersListResponseSchemaV80,
  type ProvidersListResponse,
  type ProvidersListResponseV80,
} from "@traycer/protocol/host/provider-schemas";

/**
 * W2-T12b: `providers.list@9.0` grows the skill row with `ownership` /
 * `writable` (D28/D17). The released `@8.0` and `@7.0` lines must not gain
 * them - this asserts the downgrade bridges actually strip the fields, not
 * just that the frozen schemas are shaped to reject them (covered by
 * `provider-skills-schemas.test.ts`).
 */
function v90ResponseWithSkillRow(): ProvidersListResponse {
  return providersListResponseSchema.parse({
    providers: [],
    native: {
      ok: true,
      kind: "skills",
      skills: [
        {
          name: "find-skills",
          description: null,
          path: "/Users/dev/.agents/skills/find-skills",
          source: "shared",
          ownership: "external",
          writable: false,
        },
      ],
    },
  });
}

/**
 * The mirror of the above: an 8.0 host's skills list has no `ownership` /
 * `writable` at all, and the 8->9 upgrade must fill both. The existing
 * `upgrade v8.0 -> v9.0` case in `provider-profiles-compat.test.ts` passes
 * `native: null`, so it never reaches this arm.
 */
function v80ResponseWithSkillRow(): ProvidersListResponseV80 {
  return providersListResponseSchemaV80.parse({
    providers: [],
    native: {
      ok: true,
      kind: "skills",
      skills: [
        {
          name: "find-skills",
          description: null,
          path: "/Users/dev/.claude/skills/find-skills",
          source: "shared",
        },
      ],
    },
  });
}

describe("providers.list@9.0 -> @8.0/@7.0 strips skill ownership/writable", () => {
  it("v9 -> v8 drops ownership and writable from native.skills", () => {
    const result = providersListDowngradeV9ToV8.downgradeResponse(
      v90ResponseWithSkillRow(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const native = result.value.native;
    expect(native).not.toBeNull();
    if (native === null || native.ok !== true || native.kind !== "skills") {
      throw new Error("expected a successful skills native result");
    }
    expect(native.skills[0]).not.toHaveProperty("ownership");
    expect(native.skills[0]).not.toHaveProperty("writable");
    expect(() =>
      providersListResponseSchemaV80.parse(result.value),
    ).not.toThrow();
  });

  it("v9 -> v7 drops ownership and writable from native.skills", () => {
    const result = providersListDowngradeV9ToV7.downgradeResponse(
      v90ResponseWithSkillRow(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const native = result.value.native;
    expect(native).not.toBeNull();
    if (native === null || native.ok !== true || native.kind !== "skills") {
      throw new Error("expected a successful skills native result");
    }
    expect(native.skills[0]).not.toHaveProperty("ownership");
    expect(native.skills[0]).not.toHaveProperty("writable");
    expect(() =>
      providersListResponseSchemaV70.parse(result.value),
    ).not.toThrow();
  });
});

describe("providers.list@8.0 -> @9.0 fills skill ownership/writable", () => {
  it("fills managed/writable on every skills row and the result parses as v9.0", () => {
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 0 },
      v80ResponseWithSkillRow(),
    );
    const native = upgraded.native;
    if (native === null || native.ok !== true || native.kind !== "skills") {
      throw new Error("expected a successful skills native result");
    }
    expect(native.skills[0].ownership).toBe("managed");
    expect(native.skills[0].writable).toBe(true);
    // The hop is chained BY CAST with no re-parse, so this is the assertion
    // that would have caught `writable: undefined` behind a `boolean` type.
    expect(() => providersListResponseSchema.parse(upgraded)).not.toThrow();
  });

  it("leaves a non-skills native arm and a null native untouched", () => {
    const withPlugins = providersListResponseSchemaV80.parse({
      providers: [],
      native: { ok: true, kind: "plugins", plugins: [] },
    });
    const upgraded = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 0 },
      withPlugins,
    );
    expect(upgraded.native).toEqual({ ok: true, kind: "plugins", plugins: [] });

    const withNull = upgradeResponseToVersion(
      hostRpcRegistry["providers.list"],
      { major: 8, minor: 0 },
      { major: 9, minor: 0 },
      providersListResponseSchemaV80.parse({ providers: [], native: null }),
    );
    expect(withNull.native).toBeNull();
  });
});
