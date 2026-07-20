import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddProfileWaitingStep } from "@/components/settings/panels/add-provider-profile-dialog";
import type { ProviderProfileLoginFlowCodePaste } from "@/components/settings/panels/use-provider-profile-login-flow";

const DISABLED_CODE_PASTE: ProviderProfileLoginFlowCodePaste = {
  enabled: false,
  attemptId: 0,
  restartNotice: null,
  phase: "idle",
  submitError: null,
  submit: () => {},
  touch: () => {},
};

describe("<AddProfileWaitingStep />", () => {
  it("opens and copies the external sign-in URL with the requested action variants", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writeText = vi.fn((_value: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onOpenExternalLink = vi.fn();
    const onCancel = vi.fn();

    try {
      render(
        <AddProfileWaitingStep
          loginUrl="https://auth.openai.com/oauth/authorize?state=test"
          queuePending={false}
          cancelRequested={false}
          cancelPending={false}
          cancelDisabled={false}
          waiting
          codePaste={DISABLED_CODE_PASTE}
          onOpenExternalLink={onOpenExternalLink}
          onCancel={onCancel}
        />,
      );

      const openButton = screen.getByRole("button", {
        name: "Open browser again",
      });
      const copyButton = screen.getByRole("button", {
        name: "Copy sign-in link",
      });
      const cancelButton = screen.getByRole("button", {
        name: "Cancel sign-in",
      });

      expect(openButton.getAttribute("data-variant")).toBe("outline");
      expect(copyButton.getAttribute("data-variant")).toBe("outline");
      expect(cancelButton.getAttribute("data-variant")).toBe("destructive");
      expect(cancelButton.textContent).toBe("Cancel");

      fireEvent.click(openButton);
      expect(onOpenExternalLink).toHaveBeenCalledWith(
        "https://auth.openai.com/oauth/authorize?state=test",
      );

      await act(async () => {
        fireEvent.click(copyButton);
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(
        "https://auth.openai.com/oauth/authorize?state=test",
      );
      expect(
        screen.getByRole("button", { name: "Copied sign-in link" }),
      ).toBeDefined();

      fireEvent.click(cancelButton);
      expect(onCancel).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });
});
