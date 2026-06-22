import { describe, expect, it } from "vitest";
import {
  COLLAB_COLOR_PALETTE,
  deriveCollabUser,
  hashUserIdToColorIndex,
} from "@/editor-core";

describe("deriveCollabUser", () => {
  it("is stable across calls for the same identity", () => {
    const profile = { userName: "Aya", email: "aya@example.com" };
    const a = deriveCollabUser(profile);
    const b = deriveCollabUser(profile);
    expect(a).toEqual(b);
  });

  it("picks different colors for different stable ids (in the usual case)", () => {
    // Two unrelated identities - the palette has 12 buckets so a
    // collision is possible but vanishingly unlikely on this pair.
    const alice = deriveCollabUser({
      userName: "Alice",
      email: "alice@example.com",
    });
    const bob = deriveCollabUser({
      userName: "Bob",
      email: "bob@example.com",
    });
    expect(alice.color).not.toBe(bob.color);
    expect(alice.name).toBe("Alice");
    expect(bob.name).toBe("Bob");
  });

  it("falls back to email local-part when userName is blank", () => {
    const u = deriveCollabUser({ userName: "", email: "jane@example.com" });
    expect(u.name).toBe("jane");
  });

  it("falls back to Guest when both fields are empty", () => {
    const u = deriveCollabUser({ userName: null, email: null });
    expect(u.name).toBe("Guest");
  });

  it("returns a color from the curated palette", () => {
    const u = deriveCollabUser({ userName: "Test", email: "t@x.io" });
    expect(COLLAB_COLOR_PALETTE).toContain(u.color);
  });
});

describe("hashUserIdToColorIndex", () => {
  it("is deterministic", () => {
    expect(hashUserIdToColorIndex("user-1")).toBe(
      hashUserIdToColorIndex("user-1"),
    );
  });

  it("produces different hashes for adjacent ids", () => {
    expect(hashUserIdToColorIndex("user-1")).not.toBe(
      hashUserIdToColorIndex("user-2"),
    );
  });
});
