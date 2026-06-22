import { describe, expect, it } from "vitest";
import {
  ARTIFACTS_SIDEBAR_LAYOUT,
  getArtifactsPanelInitialSize,
  getChatPanelOrder,
} from "@/components/layout/app-shell-layout";

describe("app-shell layout helpers", () => {
  it("orders the chat panels with artifacts on the configured side", () => {
    expect(getChatPanelOrder("left")).toEqual(["artifacts", "chat", "preview"]);
    expect(getChatPanelOrder("right")).toEqual([
      "chat",
      "artifacts",
      "preview",
    ]);
  });

  it("uses collapsed size when artifacts start closed", () => {
    expect(getArtifactsPanelInitialSize(ARTIFACTS_SIDEBAR_LAYOUT)).toBe(
      ARTIFACTS_SIDEBAR_LAYOUT.defaultOpen
        ? ARTIFACTS_SIDEBAR_LAYOUT.defaultSize
        : ARTIFACTS_SIDEBAR_LAYOUT.collapsedSize,
    );

    expect(
      getArtifactsPanelInitialSize({
        ...ARTIFACTS_SIDEBAR_LAYOUT,
        defaultOpen: false,
      }),
    ).toBe(ARTIFACTS_SIDEBAR_LAYOUT.collapsedSize);
  });
});
