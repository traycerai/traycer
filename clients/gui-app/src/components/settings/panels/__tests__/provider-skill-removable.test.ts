import { describe, expect, it } from "vitest";
import { skillRemovability } from "@/components/settings/panels/provider-skill-removable";

const BOTH = ["global", "project"] as const;

describe("skillRemovability", () => {
  it.each(["shared", "provider"] as const)(
    "offers removal for a %s skill under a remove-capable provider",
    (source) => {
      expect(skillRemovability({ removeScopes: [...BOTH], source })).toEqual({
        kind: "removable",
      });
    },
  );

  it.each(["plugin", "managed"] as const)(
    "blocks a %s skill even though the contract advertises remove",
    (source) => {
      // The host's `assertRemovableSkill` throws for these sources, so offering
      // the button would be offering a guaranteed failure. Advertising the verb
      // is NOT on its own a licence to delete this skill's files.
      const result = skillRemovability({ removeScopes: [...BOTH], source });
      expect(result.kind).toBe("blocked");
      if (result.kind !== "blocked") throw new Error("expected blocked");
      expect(result.reason.length).toBeGreaterThan(0);
    },
  );

  it("hides the affordance entirely when no remove scope is advertised", () => {
    // Distinct from `blocked`: the provider has no removal capability at all,
    // so a per-skill explanation would be noise on every row rather than
    // information about this one.
    expect(skillRemovability({ removeScopes: [], source: "shared" })).toEqual({
      kind: "hidden",
    });
  });

  it("hides removal when only `project` is advertised", () => {
    // The tab is global-scoped end to end: it lists with `scope: "global"` and
    // `onRemove` sends the same. A provider advertising only `project`
    // satisfies "some remove scope exists" while the request the button
    // actually issues is one the host must refuse - which is the always-fails
    // button this module exists to prevent.
    expect(
      skillRemovability({ removeScopes: ["project"], source: "shared" }),
    ).toEqual({ kind: "hidden" });
  });

  it("prefers `hidden` over `blocked` when neither condition holds", () => {
    // A built-in skill under a provider that cannot remove anything: there is
    // nothing actionable to explain, so say nothing.
    expect(skillRemovability({ removeScopes: [], source: "managed" })).toEqual({
      kind: "hidden",
    });
  });
});
