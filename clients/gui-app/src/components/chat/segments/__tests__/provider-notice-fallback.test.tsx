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

  /**
   * The GUI half of "no notice kind falls into a default arm".
   *
   * There is no arm to fall into: this component is kind-BLIND apart from the
   * settings-link gate. `title`, `message` and `details` all come off the wire,
   * so "every kind is rendered with its own copy" is a property of whoever
   * appends the notice, not of this file - which is why the assertions below
   * check that the rendered copy is exactly what was passed in, and that the
   * only thing membership in `FALLBACK_NOTICE_KINDS` buys a kind is the link.
   *
   * Written for `fallback_return_blocked` because it is the harder of the two
   * new kinds to reason about from its name: a return that ended with the chat
   * NOT moving is still a fallback-engine notice, so it still carries the
   * affordance. One case rather than one per kind - set membership itself is
   * pinned exhaustively over `providerNoticeKindSchema.options` in
   * `fallback/__tests__/fallback-notice-kinds.test.ts`, and a second render
   * case here would assert the same derivation twice.
   */
  it("reveals the Fallback settings link for a return-ending notice too - the settings-link gate is the component's ONLY kind-keyed branch", () => {
    render(
      <TabHostProvider hostId="tab-host-b">
        <ProviderNoticeSegment
          status="completed"
          noticeKind="fallback_return_blocked"
          tone="info"
          title="Stayed on the fallback"
          message="Kept this chat where it is."
          details={[
            { label: "Staying on", value: "Codex · gpt-5" },
            { label: "Preferred", value: "Claude Code · work-account" },
          ]}
          findUnitId={null}
        />
      </TabHostProvider>,
    );

    // Kind-blind: the collapsed rule renders the wire's own title and message,
    // with nothing derived from the kind added to either.
    const expander = screen.getByRole("button");
    expect(expander.textContent).toBe(
      "Stayed on the fallback · Kept this chat where it is.",
    );

    fireEvent.click(expander);
    expect(screen.getByText("Staying on")).toBeDefined();
    expect(screen.getByText("Codex · gpt-5")).toBeDefined();
    // Falsification: remove "fallback_return_blocked" from
    // FALLBACK_NOTICE_KINDS in fallback/fallback-notice-kinds.ts and THIS
    // assertion must go red - the same mutation the notice-kinds cell pins,
    // reaching the affordance through the real component instead of the set.
    expect(
      screen.getByRole("button", { name: "Fallback settings" }),
    ).toBeDefined();
    const detailsBox = screen
      .getByText("Staying on")
      .closest("dl")?.parentElement;
    expect(detailsBox?.querySelectorAll("button")).toHaveLength(1);
  });
});
