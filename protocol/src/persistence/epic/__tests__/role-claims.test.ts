/**
 * Role vocabulary: normalization order, validation, and identity.
 *
 * The order is the whole point. Whitespace folding happens BEFORE the
 * control-character check, so a tab is a space rather than a rejection - while
 * NUL and C1, which no folding rescues, are rejected. Getting that backwards
 * would reject every multi-line paste, or accept a NUL into a display name.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeRoleText,
  roleClaimIdentityKey,
  roleNameSchema,
  roleScopeSchema,
} from "@traycer/protocol/persistence/epic/role-claims";

const NUL = "\u0000";
const C1_NEL = "\u0085";
const DEL = "\u007F";
const NBSP = "\u00A0";

describe("normalizeRoleText", () => {
  it("folds every whitespace flavor - tab, LF, CR, NBSP - to a single space", () => {
    expect(normalizeRoleText("QA\tLead")).toBe("QA Lead");
    expect(normalizeRoleText("QA\nLead")).toBe("QA Lead");
    expect(normalizeRoleText("QA\r\nLead")).toBe("QA Lead");
    expect(normalizeRoleText(`QA${NBSP}Lead`)).toBe("QA Lead");
    expect(normalizeRoleText("QA \t\n  Lead")).toBe("QA Lead");
  });

  it("trims and NFC-normalizes", () => {
    expect(normalizeRoleText("  Planner  ")).toBe("Planner");
    // Decomposed (e + combining acute) and precomposed must land on the
    // same string, or the same role would claim twice.
    expect(normalizeRoleText("Revie\u0301wer")).toBe("Revi\u00E9wer");
  });
});

describe("roleNameSchema / roleScopeSchema", () => {
  it("ACCEPTS whitespace controls, because folding runs first", () => {
    expect(roleNameSchema.parse("QA\tLead")).toBe("QA Lead");
    expect(roleNameSchema.parse("QA\nLead")).toBe("QA Lead");
    expect(roleNameSchema.parse("QA\rLead")).toBe("QA Lead");
    expect(roleNameSchema.parse(`QA${NBSP}Lead`)).toBe("QA Lead");
  });

  it("REJECTS control characters that folding does not rescue", () => {
    expect(() => roleNameSchema.parse(`Plan${NUL}ner`)).toThrow();
    expect(() => roleNameSchema.parse(`Plan${C1_NEL}ner`)).toThrow();
    expect(() => roleNameSchema.parse(`Plan${DEL}ner`)).toThrow();
    // U+001F is the identity-key separator; it must never survive in role text.
    expect(() => roleNameSchema.parse("Plan\u001Fner")).toThrow();
  });

  it("RETURNS the normalized text rather than validating a shadow value", () => {
    expect(roleNameSchema.parse("  Planner  ")).toBe("Planner");
    expect(roleScopeSchema.parse("auth\t\tmigration ")).toBe("auth migration");
  });

  it("takes an open vocabulary - no enum, and case is preserved as typed", () => {
    expect(roleNameSchema.parse("Planner")).toBe("Planner");
    expect(roleNameSchema.parse("planner")).toBe("planner");
    expect(roleNameSchema.parse("PLANNER")).toBe("PLANNER");
    expect(roleNameSchema.parse("Chaos Monkey Wrangler")).toBe(
      "Chaos Monkey Wrangler",
    );
    expect(roleNameSchema.parse("計画者")).toBe("計画者");
  });

  it("rejects empty and whitespace-only, including whitespace that only folding reveals as empty", () => {
    expect(() => roleNameSchema.parse("")).toThrow();
    // ASCII whitespace-only: folded to spaces, then trimmed away to nothing.
    expect(() => roleNameSchema.parse("   ")).toThrow();
    expect(() => roleNameSchema.parse("\t\n\r")).toThrow();
    // Unicode whitespace-only: NBSP folds as well, so this is empty after the
    // trim rather than a legitimate one-character role name.
    expect(() => roleNameSchema.parse(NBSP)).toThrow();
    expect(() => roleScopeSchema.parse(`${NBSP} \t `)).toThrow();
  });

  it("bounds length in CODE POINTS, so astral characters are not double-counted", () => {
    expect(roleNameSchema.parse("a".repeat(48))).toHaveLength(48);
    expect(() => roleNameSchema.parse("a".repeat(49))).toThrow();
    expect(roleScopeSchema.parse("a".repeat(120))).toHaveLength(120);
    expect(() => roleScopeSchema.parse("a".repeat(121))).toThrow();

    // 48 emoji = 48 code points, but 96 UTF-16 units. A `.length` bound would
    // wrongly reject this.
    expect(() => roleNameSchema.parse("🙂".repeat(48))).not.toThrow();
    expect(() => roleNameSchema.parse("🙂".repeat(49))).toThrow();
  });
});

describe("roleClaimIdentityKey", () => {
  it("is case- and whitespace-insensitive, so near-duplicates collide", () => {
    const canonical = roleClaimIdentityKey({
      role: "Planner",
      scope: "auth migration",
    });
    expect(
      roleClaimIdentityKey({ role: "planner", scope: "auth migration" }),
    ).toBe(canonical);
    expect(
      roleClaimIdentityKey({ role: "  PLANNER ", scope: "auth\tmigration" }),
    ).toBe(canonical);
  });

  it("distinguishes different scopes and different roles", () => {
    const planAuth = roleClaimIdentityKey({
      role: "Planner",
      scope: "auth migration",
    });
    expect(
      roleClaimIdentityKey({ role: "Planner", scope: "billing migration" }),
    ).not.toBe(planAuth);
    expect(
      roleClaimIdentityKey({ role: "Reviewer", scope: "auth migration" }),
    ).not.toBe(planAuth);
  });

  it("cannot be forged across the role/scope boundary", () => {
    // Without a separator that role text can never contain, ("ab","c") and
    // ("a","bc") would collide. U+001F is rejected inside role/scope, so they
    // cannot.
    expect(roleClaimIdentityKey({ role: "ab", scope: "c" })).not.toBe(
      roleClaimIdentityKey({ role: "a", scope: "bc" }),
    );
  });
});
