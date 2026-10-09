import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";

describe("HarnessIcon", () => {
  it("renders a known harness as its svg icon", () => {
    const { container } = render(<HarnessIcon harnessId="claude" />);

    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains("size-4")).toBe(true);
  });

  it("renders a harness this build does not know as an empty aria-hidden span", () => {
    const { container } = render(<HarnessIcon harnessId="zzz-future" />);

    expect(container.querySelector("svg")).toBeNull();
    const span = container.firstElementChild;
    expect(span?.tagName).toBe("SPAN");
    expect(span?.getAttribute("aria-hidden")).toBe("true");
    expect(span?.classList.contains("size-4")).toBe(true);
    expect(span?.childElementCount).toBe(0);
    expect(span?.textContent).toBe("");
  });

  it("does not mistake an inherited object key for a known harness", () => {
    const { container } = render(<HarnessIcon harnessId="toString" />);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("SPAN");
  });

  it("passes the caller's className through on the unknown-harness span", () => {
    const { container } = render(
      <HarnessIcon harnessId="zzz-future" className="mr-1" />,
    );

    expect(container.firstElementChild?.classList.contains("mr-1")).toBe(true);
  });
});
