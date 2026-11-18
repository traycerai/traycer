import { beforeEach, describe, expect, it, vi } from "vitest";
import { findThemeTokenUsage } from "@/components/settings/themes/theme-inspection";

function computedFor(element: Element, color: string): CSSStyleDeclaration {
  const style = document.createElement("div").style;
  style.backgroundColor = element.matches("[data-probe]") ? color : "";
  style.borderTopStyle = "none";
  style.borderRightStyle = "none";
  style.borderBottomStyle = "none";
  style.borderLeftStyle = "none";
  return style;
}

describe("theme inspector token probing", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--primary");
    document.head.querySelectorAll("style").forEach((style) => {
      if (style.textContent.includes("html *,html *::before")) style.remove();
    });
  });

  it("restores the original value and priority after probing", () => {
    const target = document.createElement("div");
    target.dataset.probe = "true";
    target.textContent = "probe";
    document.body.append(target);
    document.documentElement.style.setProperty(
      "--primary",
      "#123456",
      "important",
    );
    const computed = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) =>
        computedFor(
          element,
          document.documentElement.style.getPropertyValue("--primary"),
        ),
      );

    expect(findThemeTokenUsage([target], ["primary"])).toEqual([
      { element: target, token: "primary" },
    ]);
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#123456",
    );
    expect(
      document.documentElement.style.getPropertyPriority("--primary"),
    ).toBe("important");
    expect(
      document.head.querySelector("style")?.textContent ?? "",
    ).not.toContain("html *,html *::before");
    computed.mockRestore();
    target.remove();
  });

  it("restores the probe and suppression style when painting throws", () => {
    const target = document.createElement("div");
    target.dataset.probe = "true";
    target.textContent = "probe";
    document.body.append(target);
    document.documentElement.style.setProperty(
      "--primary",
      "#123456",
      "important",
    );
    let calls = 0;
    const computed = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => {
        calls += 1;
        if (calls === 2) throw new Error("paint failed");
        return computedFor(
          element,
          document.documentElement.style.getPropertyValue("--primary"),
        );
      });

    expect(() => findThemeTokenUsage([target], ["primary"])).toThrow(
      "paint failed",
    );
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      "#123456",
    );
    expect(
      document.documentElement.style.getPropertyPriority("--primary"),
    ).toBe("important");
    expect(
      document.head.querySelector("style")?.textContent ?? "",
    ).not.toContain("html *,html *::before");
    computed.mockRestore();
    target.remove();
  });
});
