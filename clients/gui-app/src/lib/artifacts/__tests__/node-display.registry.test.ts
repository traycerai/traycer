import { describe, expect, it } from "vitest";
import {
  EPIC_NODE_LABELS,
  EPIC_NODE_ICONS,
  EPIC_NODE_KINDS,
  DEFAULT_EPIC_NODE_ICON_COLORS,
  DEFAULT_EPIC_NODE_NAMES,
  normalizeEpicNodeIconColor,
  normalizeEpicNodeIconColors,
} from "@/lib/artifacts/node-display";

describe("artifact-display registry", () => {
  it("includes review in the icon registry", () => {
    expect(EPIC_NODE_ICONS.review).toBeDefined();
  });

  it("includes review in the default-name registry", () => {
    expect(DEFAULT_EPIC_NODE_NAMES.review).toBe("New review");
  });

  it("includes a color for every icon type", () => {
    expect(Object.keys(DEFAULT_EPIC_NODE_ICON_COLORS).sort()).toEqual(
      Object.keys(EPIC_NODE_ICONS).sort(),
    );
    expect(DEFAULT_EPIC_NODE_ICON_COLORS.ticket).toBe("#a78bfa");
  });

  it("keeps labels aligned with artifact types", () => {
    expect(Object.keys(EPIC_NODE_LABELS).sort()).toEqual(
      [...EPIC_NODE_KINDS].sort(),
    );
  });

  it("normalizes icon colors", () => {
    expect(normalizeEpicNodeIconColor("#ABCDEF")).toBe("#abcdef");
    expect(normalizeEpicNodeIconColor("violet")).toBeNull();
  });

  it("repairs partial persisted icon colors", () => {
    expect(
      normalizeEpicNodeIconColors({
        chat: "#ABCDEF",
        ticket: "violet",
      }),
    ).toEqual({
      ...DEFAULT_EPIC_NODE_ICON_COLORS,
      chat: "#abcdef",
    });
  });
});
