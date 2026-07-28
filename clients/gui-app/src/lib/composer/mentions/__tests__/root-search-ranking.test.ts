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
  return rankRootSearchEntries(candidates, query).map((item) => item.label);
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
      rankRootSearchEntries(candidates, "auth").map((item) => item.id),
    ).toEqual(["a1", "f1"]);
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
