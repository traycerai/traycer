import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposerBannerPortalProvider } from "@/components/chat/composer/chat-composer-banner-portal";
import { ComposerPromptSuggestion } from "@/components/chat/composer/prompt-suggestion-chip";
import { promptSuggestionChipAllowed } from "@/components/chat/composer/prompt-suggestion";

function renderChip(
  suggestedPrompt: string | undefined,
  allowed: boolean,
  onFill: (suggestion: string) => void,
): RenderResult {
  return render(
    <ChatComposerBannerPortalProvider>
      <ComposerPromptSuggestion
        suggestedPrompt={suggestedPrompt}
        allowed={allowed}
        onFill={onFill}
      />
    </ChatComposerBannerPortalProvider>,
  );
}

describe("<ComposerPromptSuggestion />", () => {
  afterEach(cleanup);

  it("renders the suggestion text", () => {
    renderChip("Run the tests", true, vi.fn());
    expect(
      screen.getByRole("button", {
        name: "Use suggested prompt: Run the tests",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Run the tests")).toBeTruthy();
  });

  it("fills with the text on click and does nothing else", () => {
    const onFill = vi.fn();
    renderChip("Run the tests", true, onFill);
    fireEvent.click(
      screen.getByRole("button", { name: /Use suggested prompt/ }),
    );
    expect(onFill).toHaveBeenCalledTimes(1);
    expect(onFill).toHaveBeenCalledWith("Run the tests");
  });

  it("dismiss hides it, and a different suggestion shows again", () => {
    const onFill = vi.fn();
    const view = renderChip("First", true, onFill);
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss suggested prompt" }),
    );
    expect(screen.queryByText("First")).toBeNull();
    expect(onFill).not.toHaveBeenCalled();

    view.rerender(
      <ChatComposerBannerPortalProvider>
        <ComposerPromptSuggestion
          suggestedPrompt="First"
          allowed
          onFill={onFill}
        />
      </ChatComposerBannerPortalProvider>,
    );
    expect(screen.queryByText("First")).toBeNull();

    view.rerender(
      <ChatComposerBannerPortalProvider>
        <ComposerPromptSuggestion
          suggestedPrompt="Second"
          allowed
          onFill={onFill}
        />
      </ChatComposerBannerPortalProvider>,
    );
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("draws nothing for an undefined suggestion", () => {
    renderChip(undefined, true, vi.fn());
    expect(screen.queryByRole("group", { name: "Suggested prompt" })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("draws nothing when not allowed", () => {
    renderChip("Run the tests", false, vi.fn());
    expect(screen.queryByText("Run the tests")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("promptSuggestionChipAllowed", () => {
  const open = {
    topBannerKind: "none",
    sendDisabled: false,
    draftHasText: false,
    draftHasImages: false,
  } as const;

  it("allows an empty draft with no banner and send enabled", () => {
    expect(promptSuggestionChipAllowed(open)).toBe(true);
  });

  it.each(["fallback", "reauth", "fallback-return", "rate-limit"] as const)(
    "is blocked by the %s banner",
    (topBannerKind) => {
      expect(promptSuggestionChipAllowed({ ...open, topBannerKind })).toBe(
        false,
      );
    },
  );

  it("is blocked when send is disabled", () => {
    expect(promptSuggestionChipAllowed({ ...open, sendDisabled: true })).toBe(
      false,
    );
  });

  it("is blocked by draft text", () => {
    expect(promptSuggestionChipAllowed({ ...open, draftHasText: true })).toBe(
      false,
    );
  });

  it("is blocked by draft images", () => {
    expect(promptSuggestionChipAllowed({ ...open, draftHasImages: true })).toBe(
      false,
    );
  });
});
