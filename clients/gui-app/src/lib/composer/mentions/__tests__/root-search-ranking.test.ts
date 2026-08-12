import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { MentionMenuEntry, MentionProviderId } from "../providers";
import {
  rankRootSearchEntries,
  type RootSearchCandidate,
} from "../root-search-ranking";

function entry(fields: {
  id: string;
  label: string;
  detail?: string;
  description?: string;
}): MentionMenuEntry {
  return {
    id: fields.id,
    label: fields.label,
    detail: fields.detail ?? "",
    description: fields.description ?? "",
    icon: createElement("span"),
    action: { kind: "back" },
    updatedAt: null,
    archived: false,
    preview: null,
  };
}

function candidate(
  providerId: MentionProviderId,
  fields: {
    id: string;
    label: string;
    detail?: string;
    description?: string;
  },
): RootSearchCandidate {
  return { entry: entry(fields), providerId };
}

function rankedLabels(
  candidates: ReadonlyArray<RootSearchCandidate>,
  query: string,
): string[] {
  return rankRootSearchEntries(candidates, query).entries.map(
    (item) => item.label,
  );
}

describe("rankRootSearchEntries", () => {
  it("returns candidates unchanged for an empty query", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "zeta.ts" }),
      candidate("artifacts", { id: "a1", label: "Auth spec" }),
    ];
    expect(rankedLabels(candidates, "  ")).toEqual(["zeta.ts", "Auth spec"]);
  });

  it("ranks a strong artifact title above weaker file-path hits regardless of provider order", () => {
    const candidates = [
      candidate("files", {
        id: "f1",
        label: "authorization-helpers.test.ts",
        detail: "src/deep/nested",
      }),
      candidate("files", {
        id: "f2",
        label: "oauth-thing.ts",
        detail: "src",
      }),
      candidate("artifacts", { id: "a1", label: "Auth plan" }),
    ];
    const labels = rankedLabels(candidates, "auth plan");
    expect(labels[0]).toBe("Auth plan");
  });

  it("breaks an equal-quality tie in favor of curated entries via the provider boost", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "auth" }),
      candidate("artifacts", { id: "a1", label: "auth" }),
    ];
    expect(rankedLabels(candidates, "auth")).toEqual(["auth", "auth"]);
    expect(
      rankRootSearchEntries(candidates, "auth").entries.map((item) => item.id),
    ).toEqual(["a1", "f1"]);
  });

  it("ranks a label-prefix hit above a shorter label-substring hit with a better fuse score", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "oauth.ts" }),
      candidate("files", { id: "f2", label: "authorization-helpers.test.ts" }),
    ];
    expect(rankedLabels(candidates, "auth")).toEqual([
      "authorization-helpers.test.ts",
      "oauth.ts",
    ]);
  });

  it("does not let the provider boost push a label-substring hit above a label-prefix hit", () => {
    const candidates = [
      candidate("artifacts", { id: "a1", label: "oauth rollout plan" }),
      candidate("files", { id: "f1", label: "auth-helpers.ts" }),
    ];
    expect(rankedLabels(candidates, "auth")).toEqual([
      "auth-helpers.ts",
      "oauth rollout plan",
    ]);
  });

  it("keeps unmatched rows appended after all tiered rows", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "zz-unrelated.bin" }),
      candidate("files", { id: "f2", label: "oauth.ts" }),
      candidate("artifacts", { id: "a1", label: "Auth spec" }),
    ];
    expect(rankedLabels(candidates, "auth")).toEqual([
      "Auth spec",
      "oauth.ts",
      "zz-unrelated.bin",
    ]);
  });

  it("appends source-matched rows the client cannot re-match instead of dropping them", () => {
    const candidates = [
      candidate("files", {
        id: "f1",
        label: "zz-unrelated.bin",
        detail: "vendor",
      }),
      candidate("artifacts", { id: "a1", label: "Auth spec" }),
    ];
    const labels = rankedLabels(candidates, "auth");
    expect(labels).toEqual(["Auth spec", "zz-unrelated.bin"]);
  });

  it("reports how many rows actually matched, not counting appended rows", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "zz-unrelated.bin" }),
      candidate("artifacts", { id: "a1", label: "Auth spec" }),
    ];
    const ranked = rankRootSearchEntries(candidates, "auth");
    expect(ranked.entries).toHaveLength(2);
    expect(ranked.matchedCount).toBe(1);
  });

  it("reports zero matches when only appended rows remain", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "zz-unrelated.bin" }),
    ];
    const ranked = rankRootSearchEntries(candidates, "qqqq");
    expect(ranked.entries).toHaveLength(1);
    expect(ranked.matchedCount).toBe(0);
  });

  it("reports no match count for an empty query", () => {
    const candidates = [candidate("files", { id: "f1", label: "zeta.ts" })];
    expect(rankRootSearchEntries(candidates, "  ").matchedCount).toBeNull();
  });

  it("keeps original order among appended unmatched rows", () => {
    const candidates = [
      candidate("files", { id: "f1", label: "first.bin" }),
      candidate("folders", { id: "d1", label: "second-dir" }),
      candidate("artifacts", { id: "a1", label: "Auth spec" }),
    ];
    expect(rankedLabels(candidates, "auth")).toEqual([
      "Auth spec",
      "first.bin",
      "second-dir",
    ]);
  });
});
