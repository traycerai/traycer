import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerNoticeKindSchema,
  type ProviderNoticeKind,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { ProviderNoticeSegment } from "../provider-notice-segment";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

const DETAILS = [
  { label: "via:", value: "Claude Code → Codex" },
  { label: "reason", value: "Rate limit reached" },
];

const TITLE = "Switched to Sonnet 5 · Low on Surya after a rate limit";
const MESSAGE = "claude/sonnet (Surya 2) → claude/sonnet (Surya)";

// Every kind the fallback engine writes, derived from the prefix rather than
// listed, so a sixth `fallback_*` kind joins the loops below by existing.
const FALLBACK_KINDS: ReadonlyArray<ProviderNoticeKind> =
  providerNoticeKindSchema.options.filter((kind) =>
    kind.startsWith("fallback_"),
  );

function renderNotice(
  noticeKind: ProviderNoticeKind,
  message: string | null,
): void {
  render(
    <TabHostProvider hostId="tab-host-b">
      <ProviderNoticeSegment
        status="completed"
        noticeKind={noticeKind}
        tone="info"
        title={TITLE}
        message={message}
        details={DETAILS}
        findUnitId={null}
      />
    </TabHostProvider>,
  );
}

describe("ProviderNoticeSegment fallback details", () => {
  afterEach(() => {
    cleanup();
  });

  it("covers the fallback kinds the engine writes (guards the loops below from going vacuous)", () => {
    expect(FALLBACK_KINDS).toContain("fallback_applied");
    expect(FALLBACK_KINDS).toContain("fallback_wait_resumed");
    expect(FALLBACK_KINDS).toContain("fallback_settled");
    expect(FALLBACK_KINDS).toContain("fallback_returned");
    expect(FALLBACK_KINDS).toContain("fallback_return_blocked");
  });

  it.each(FALLBACK_KINDS)(
    "reveals detail pairs and no settings action under the chevron for %s",
    (noticeKind) => {
      renderNotice(noticeKind, MESSAGE);
      const chevron = screen.getByRole("button");
      expect(chevron.getAttribute("aria-expanded")).toBe("false");
      // Collapsed: the details are not on screen yet.
      expect(screen.queryByText("via:")).toBeNull();

      fireEvent.click(chevron);
      expect(chevron.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText("via:")).toBeDefined();
      expect(screen.getByText("Claude Code → Codex")).toBeDefined();
      // The chevron is the only button: no "Model routing" link, styled or
      // otherwise, in the expanded details (clutter cuts, 2026-09-27).
      expect(
        screen.queryByRole("button", { name: "Model routing" }),
      ).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByText("Model routing")).toBeNull();
      expect(screen.getAllByRole("button")).toHaveLength(1);
    },
  );

  it("also offers no settings action on a non-fallback notice", () => {
    renderNotice("model_rerouted", "Codex switched models.");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("via:")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("paints a fallback_applied notice's title and not its message, collapsed or expanded, with the details under the chevron", () => {
    renderNotice("fallback_applied", MESSAGE);
    const chevron = screen.getByRole("button");

    expect(chevron.textContent).toBe(TITLE);
    expect(document.body.textContent).not.toContain("claude/sonnet");
    expect(screen.queryByText(MESSAGE)).toBeNull();

    fireEvent.click(chevron);
    expect(screen.getByText("via:")).toBeDefined();
    expect(screen.getByText("Claude Code → Codex")).toBeDefined();
    expect(chevron.textContent).toBe(TITLE);
    expect(document.body.textContent).not.toContain("claude/sonnet");
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });

  it.each([
    "fallback_settled",
    "fallback_wait_resumed",
    "fallback_returned",
    "fallback_return_blocked",
    "model_rerouted",
    "harness_message",
  ] as const)("still prints ' · message' inline for %s", (noticeKind) => {
    renderNotice(noticeKind, "Kept this chat where it is.");
    // Control for the fallback_applied absence above: the same message text
    // renders when the kind is not `fallback_applied`.
    expect(screen.getByRole("button").textContent).toBe(
      `${TITLE} · Kept this chat where it is.`,
    );
  });
});
