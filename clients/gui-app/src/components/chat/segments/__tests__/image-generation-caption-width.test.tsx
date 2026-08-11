import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImageGeneration } from "@/components/chat/segments/image-generation/image-generation";

afterEach(() => {
  cleanup();
});

describe("<ImageGeneration /> caption width anchor", () => {
  it("caps the fluid wrapper to the media width so a long single-line prompt can't blow out the card", () => {
    const longPrompt = "a lighthouse at dusk over calm water "
      .repeat(80)
      .trim();
    const { container } = render(
      <ImageGeneration
        children={null}
        status="complete"
        prompt={longPrompt}
        resolution=""
        aspectRatio={1}
        mediaStyle={{ width: "22.5rem" }}
      />,
    );

    const root = container.querySelector('[data-slot="image-generation"]');
    const wrapper = root?.firstElementChild;
    expect(wrapper?.getAttribute("style")).toContain("width: 22.5rem");

    const caption = wrapper?.querySelector("p");
    expect(caption?.className).toContain("truncate");
  });
});
