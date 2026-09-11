import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsGroup } from "@/components/settings/settings-group";

describe("SettingsGroup", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not stretch when fill is false", () => {
    render(
      <SettingsGroup
        title="General"
        tone="default"
        dataTestId="settings-group-general"
        fill={false}
      >
        <div>row</div>
      </SettingsGroup>,
    );

    const heading = screen.getByRole("heading", { level: 2, name: "General" });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    if (section === null) return;

    expect(section.className).not.toContain("h-full");
    expect(section.className).not.toContain("flex-col");
    expect(heading.className).not.toContain("shrink-0");

    const card = heading.nextElementSibling;
    expect(card instanceof HTMLElement).toBe(true);
    if (!(card instanceof HTMLElement)) return;
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("border");
    expect(card.className).not.toContain("flex-1");
    expect(card.className).not.toContain("min-h-0");
  });

  it("fills remaining height when fill is true", () => {
    render(
      <SettingsGroup
        title="Notification hooks"
        tone="default"
        dataTestId="settings-group-hooks"
        fill
      >
        <div>manager</div>
      </SettingsGroup>,
    );

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Notification hooks",
    });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    if (section === null) return;

    // fill={true}: section is a flex column that owns full parent height.
    expect(section.className).toContain("flex");
    expect(section.className).toContain("h-full");
    expect(section.className).toContain("min-h-0");
    expect(section.className).toContain("flex-col");
    expect(heading.className).toContain("shrink-0");

    const card = heading.nextElementSibling;
    expect(card instanceof HTMLElement).toBe(true);
    if (!(card instanceof HTMLElement)) return;
    expect(card.className).toContain("min-h-0");
    expect(card.className).toContain("flex-1");
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("border");
  });

  it("forwards data-testid onto the section", () => {
    render(
      <SettingsGroup
        title="Theme"
        tone="default"
        dataTestId="settings-group-theme"
        fill={false}
      >
        <div>row</div>
      </SettingsGroup>,
    );

    const section = screen.getByTestId("settings-group-theme");
    expect(section.tagName).toBe("SECTION");
    expect(
      screen
        .getByRole("heading", { level: 2, name: "Theme" })
        .closest("section"),
    ).toBe(section);
  });

  it("anchors settings search to the card, not to the heading's section", () => {
    // The search reveal draws a ring and a wash on whatever carries the
    // anchor. On the `<section>` that shape swallowed the group's own label
    // and the gutter under it, so the group's name lit up as part of its
    // contents. The card is the shape the group already has at rest.
    render(
      <SettingsGroup
        title="Interface"
        tone="default"
        dataTestId="settings-group-interface"
        fill={false}
        anchor="appearance-interface"
      >
        <div>row</div>
      </SettingsGroup>,
    );

    const section = screen.getByTestId("settings-group-interface");
    expect(section.hasAttribute("data-settings-anchor")).toBe(false);

    const anchored = section.querySelector(
      '[data-settings-anchor="appearance-interface"]',
    );
    expect(anchored).not.toBeNull();
    // The heading is a sibling of the anchored card, never inside it.
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Interface",
    });
    expect(anchored?.contains(heading)).toBe(false);
    expect(anchored?.textContent).toBe("row");
  });

  it("omits the group heading when the page title already names the card", () => {
    render(
      <SettingsGroup
        title={undefined}
        tone="default"
        dataTestId="settings-group-untitled"
        fill={false}
      >
        <div>row</div>
      </SettingsGroup>,
    );

    const section = screen.getByTestId("settings-group-untitled");
    expect(section.tagName).toBe("SECTION");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(section.querySelector(".rounded-lg")).not.toBeNull();
  });
});
