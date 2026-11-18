import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FIND_MIRROR_ATTR } from "@/lib/find-engine/find-blocks";
import { FindMirror } from "@/markdown/components/find-mirror";

afterEach(() => {
  cleanup();
});

describe("FindMirror", () => {
  it("renders the normalized text on the mirror span, marked inert", () => {
    const { container } = render(
      <FindMirror text={"graph TD\n  A[Save  now]"} />,
    );

    const mirror = container.querySelector(`[${FIND_MIRROR_ATTR}]`);
    if (mirror === null) throw new Error("Expected a rendered find mirror.");
    expect(mirror.textContent).toBe("graph TD\n A[Save now]");
    expect(mirror.hasAttribute("inert")).toBe(true);
  });

  it("renders nothing when the normalized text is empty", () => {
    const { container } = render(<FindMirror text={"   "} />);

    expect(container.querySelector(`[${FIND_MIRROR_ATTR}]`)).toBeNull();
  });
});
