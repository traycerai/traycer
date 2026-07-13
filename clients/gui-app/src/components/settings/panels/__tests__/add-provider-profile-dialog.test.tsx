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
          onOpenExternalLink={onOpenExternalLink}
          onCancel={onCancel}
        />,
      );

      const openButton = screen.getByRole("button", {
        name: "Open sign-in page",
      });
      const copyButton = screen.getByRole("button", {
        name: "Copy sign-in link",
      });
      const cancelButton = screen.getByRole("button", {
        name: "Cancel sign-in",
      });

      expect(openButton.getAttribute("data-variant")).toBe("secondary");
      expect(copyButton.getAttribute("data-variant")).toBe("secondary");
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
      ).toHaveProperty("textContent", "Copied");

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
