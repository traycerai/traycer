import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ImageGeneration } from "@/components/chat/segments/image-generation/image-generation";

afterEach(() => {
  cleanup();
});

describe("<ImageGeneration /> caption width anchor", () => {
  it("caps the fluid wrapper and lets the keyboard disclose the full prompt", async () => {
    const user = userEvent.setup();
    const longPrompt = "a lighthouse at dusk over calm water "
      .repeat(80)
      .trim();
    const { container } = render(
      <ImageGeneration
        status="complete"
        prompt={longPrompt}
        resolution=""
        aspectRatio={1}
        mediaStyle={{ width: "22.5rem" }}
      >
        {null}
      </ImageGeneration>,
    );

    const root = container.querySelector('[data-slot="image-generation"]');
    const media = root?.querySelector('[role="img"]');
    expect(root?.className).toContain("w-full");
    expect(media?.getAttribute("style")).toContain("width: 22.5rem");

    const summary = root?.querySelector("span.truncate");
    expect(summary?.textContent).toBe(longPrompt);
    const chevron = root?.querySelector(
      'button[aria-label="Show image details"] svg',
    );
    expect(chevron?.classList.contains("ml-auto")).toBe(true);

    const expand = screen.getByRole("button", {
      name: "Show image details",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await user.tab();
    expect(document.activeElement).toBe(expand);
    await user.keyboard("{Enter}");

    expect(
      screen.getByRole("button", { name: "Hide image details" }),
    ).toBeTruthy();
    const expandedCaption = root?.querySelector(
      '[data-slot="collapsible-content"] p',
    );
    expect(expandedCaption?.textContent).toContain(longPrompt);
    expect(expandedCaption?.className).not.toContain("truncate");
  });
});
