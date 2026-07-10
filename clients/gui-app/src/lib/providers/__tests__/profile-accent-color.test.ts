import { describe, expect, it } from "vitest";
import { resolveProfileAccentColor } from "../profile-accent-color";

describe("resolveProfileAccentColor", () => {
  it("prefers the host-assigned accent color when present", () => {
    expect(resolveProfileAccentColor("profile-1", "#123456")).toBe("#123456");
  });

  it("falls back to a deterministic palette hash of profileId when null", () => {
    const first = resolveProfileAccentColor("profile-1", null);
    const second = resolveProfileAccentColor("profile-1", null);
    expect(first).toBe(second);
    expect(first).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("spreads distinct profileIds across different palette buckets", () => {
    const colors = new Set(
      ["profile-1", "profile-2", "profile-3", "profile-4"].map((id) =>
        resolveProfileAccentColor(id, null),
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
