import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackReturnBanner } from "@/components/chat/fallback/fallback-return-banner";
import type { FallbackReturnLowUsage } from "@/components/chat/fallback/fallback-return-low-usage";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  PREFERRED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  pendingReturn,
} from "./fallback-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: mocks.mutate,
    isPending: false,
  }),
}));

function renderBanner(input: {
  readonly fallbackTuple: ChatRunSettings;
  readonly preferredTuple: ChatRunSettings;
  readonly queuedItemsMoving: number;
  readonly lowUsage: FallbackReturnLowUsage | null;
}) {
  return render(
    <FallbackReturnBanner
      offer={pendingReturn({
        preferredTuple: input.preferredTuple,
        fallbackTuple: input.fallbackTuple,
        queuedItemsMoving: input.queuedItemsMoving,
        traversalId: "traversal-return",
        revision: 11,
      })}
      lowUsage={input.lowUsage}
      client={null}
      chatId="chat-return"
      epicId="epic-return"
      canAct
    />,
  );
}

describe("FallbackReturnBanner", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends switch_back, stay, and dismiss_for_chat with the DTO ref", () => {
    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 2,
      lowUsage: null,
    });
    const banner = screen.getByTestId("fallback-return-banner");
    expect(banner.textContent).not.toMatch(BANNED_VOCABULARY);

    fireEvent.click(screen.getByRole("button", { name: "Switch back" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      epicId: "epic-return",
      chatId: "chat-return",
      traversalId: "traversal-return",
      revision: 11,
      action: "switch_back",
    });

    fireEvent.click(screen.getByRole("button", { name: /Stay on / }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stay" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Don't ask for this chat" }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dismiss_for_chat" }),
    );
  });

  it("states queued messages move and hides the count at zero", () => {
    const { unmount } = renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 2,
      lowUsage: null,
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toMatch(
      /moves 2 queued messages back/,
    );
    unmount();

    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: null,
    });
    expect(
      screen.getByTestId("fallback-return-banner").textContent,
    ).not.toMatch(/queued message/);
  });

  it("names a cross-provider fallback as Provider · model and a same-provider one as the profile label", () => {
    const { unmount } = renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: null,
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toMatch(
      /Codex · gpt-5/,
    );
    unmount();

    const sameProvider = chatRunSettings({
      harnessId: "claude",
      model: "claude-opus-4",
      profileId: "workacct-profile",
    });
    renderBanner({
      fallbackTuple: sameProvider,
      preferredTuple: FAILED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: null,
    });
    const text = screen.getByTestId("fallback-return-banner").textContent;
    expect(text).toMatch(/workacct/);
    expect(text).not.toMatch(/Claude Code · claude-opus-4/);
  });

  it("shows no low-usage clause when lowUsage is null", () => {
    // Falsification: pass a hard-coded FallbackReturnLowUsage instead of the null prop through to combinedHeadline and THIS assertion must go red.
    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: null,
    });
    expect(
      screen.getByTestId("fallback-return-banner").textContent,
    ).not.toMatch(/running low|reached its/);
  });

  it("joins the reset headline and a cross-provider near_limit clause with 'and', naming Provider · model", () => {
    // Falsification: drop the " and " join in combinedHeadline (render only the reset sentence) and THIS assertion must go red.
    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: { severity: "near_limit", limitedFamilies: [] },
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toContain(
      "prefer01's limit has reset and Codex · gpt-5 is running low on usage",
    );
  });

  it("names the limited family in a cross-provider hard_limit clause", () => {
    // Falsification: drop limitedFamilies from the fallbackLowUsageClause call inside combinedHeadline and THIS assertion must go red.
    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: { severity: "hard_limit", limitedFamilies: ["Fable"] },
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toContain(
      "prefer01's limit has reset and Codex · gpt-5 has reached its Fable rate limit",
    );
  });

  it("names a same-provider low-usage clause by the profile label, not Provider · model", () => {
    // Falsification: drop the `crossProvider` check in `destinationName`
    // (fallback-return-banner.tsx) so it always returns the
    // `${providerLabel} · ${model}` form, and THIS assertion must go red - the
    // absorbed clause would name a same-provider account by provider and model
    // instead of by the profile label the rest of the banner uses.
    //
    // There is no `includeProvider` on this path: that parameter belongs to
    // `fallbackDestinationSentence` in `fallback-identity.ts`, which this
    // banner does not call. `destinationName` decides the same question
    // locally, from `fallback.providerId !== preferred.providerId`.
    const sameProvider = chatRunSettings({
      harnessId: "claude",
      model: "claude-opus-4",
      profileId: "workacct-profile",
    });
    renderBanner({
      fallbackTuple: sameProvider,
      preferredTuple: FAILED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
      lowUsage: { severity: "near_limit", limitedFamilies: [] },
    });
    const text = screen.getByTestId("fallback-return-banner").textContent;
    expect(text).toContain("workacct is running low on usage");
    expect(text).not.toMatch(/Claude Code · claude-opus-4/);
  });
});
