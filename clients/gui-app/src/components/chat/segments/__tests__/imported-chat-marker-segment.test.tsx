import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImportedChatMarkerSegment } from "@/components/chat/segments/imported-chat-marker-segment";
import { formatAbsoluteDateTime } from "@/lib/relative-time";

describe("<ImportedChatMarkerSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the Claude Code provenance line as a note with a formatted absolute date", () => {
    const importedAt = 1700000000000;
    render(
      <ImportedChatMarkerSegment
        sourceProvider="claude"
        importedAt={importedAt}
        sourceCwd="/repo/work"
      />,
    );

    const marker = screen.getByRole("note");
    expect(
      within(marker).getByText(
        `Imported from Claude Code · ${formatAbsoluteDateTime(importedAt)}`,
      ),
    ).toBeTruthy();
  });

  it("renders the Codex provenance line as a note with a formatted absolute date", () => {
    const importedAt = 1650000000000;
    render(
      <ImportedChatMarkerSegment
        sourceProvider="codex"
        importedAt={importedAt}
        sourceCwd="/repo/other"
      />,
    );

    const marker = screen.getByRole("note");
    expect(
      within(marker).getByText(
        `Imported from Codex · ${formatAbsoluteDateTime(importedAt)}`,
      ),
    ).toBeTruthy();
  });

  it("puts the source directory in reach of a keyboard and of a screen reader", () => {
    const importedAt = 1700000000000;
    render(
      <ImportedChatMarkerSegment
        sourceProvider="claude"
        importedAt={importedAt}
        sourceCwd="/repo/work"
      />,
    );

    // The tooltip is the only place the source directory appears, so a trigger
    // that cannot take focus hides it from keyboard users entirely, and one
    // that has to be opened to say anything hides it from a screen reader.
    const trigger = within(screen.getByRole("note")).getByRole("button", {
      name: `Imported from Claude Code · ${formatAbsoluteDateTime(importedAt)}. Source directory /repo/work`,
    });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });
});
