import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { ProviderNoticeSegment } from "../provider-notice-segment";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

const DETAILS = [
  { label: "via:", value: "Claude Code → Codex" },
  { label: "reason", value: "Rate limit reached" },
];

describe("ProviderNoticeSegment fallback details", () => {
  afterEach(() => {
    cleanup();
  });

  it("reveals detail pairs and a Fallback settings link on fallback_applied, and no link on model_rerouted", () => {
    const { unmount } = render(
      <TabHostProvider hostId="tab-host-b">
        <ProviderNoticeSegment
          status="completed"
          noticeKind="fallback_applied"
          tone="info"
          title="Switched providers"
          message="Moved to Codex."
          details={DETAILS}
          findUnitId={null}
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("via:")).toBeDefined();
    expect(screen.getByText("Claude Code → Codex")).toBeDefined();
    const settings = screen.getByRole("button", { name: "Fallback settings" });
    const detailsBox = screen.getByText("via:").closest("dl")?.parentElement;
    expect(detailsBox?.querySelectorAll("button")).toHaveLength(1);
    expect(settings.textContent).toBe("Fallback settings");
    expect(detailsBox?.textContent).not.toMatch(/Switch elsewhere/);
    unmount();

    render(
      <TabHostProvider hostId="tab-host-b">
        <ProviderNoticeSegment
          status="completed"
          noticeKind="model_rerouted"
          tone="warning"
          title="Model changed"
          message="Codex switched models."
          details={DETAILS}
          findUnitId={null}
        />
      </TabHostProvider>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("via:")).toBeDefined();
    // Falsification: make isFallbackNoticeKind return true unconditionally and THIS control assertion must go red.
    expect(
      screen.queryByRole("button", { name: "Fallback settings" }),
    ).toBeNull();
  });
});
