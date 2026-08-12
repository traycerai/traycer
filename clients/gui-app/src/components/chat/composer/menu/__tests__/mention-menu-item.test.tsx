import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MentionMenuEntry } from "@/lib/composer/mentions";
import { MentionMenuItem } from "../mention-menu-item";

const HOUR_MS = 60 * 60 * 1000;

function entry(fields: {
  updatedAt: number | null;
  archived: boolean;
  detail: string;
}): MentionMenuEntry {
  return {
    id: "chat:epic-1:c1",
    label: "Planning agent",
    detail: fields.detail,
    description: "",
    icon: createElement("span"),
    action: { kind: "back" },
    updatedAt: fields.updatedAt,
    archived: fields.archived,
    preview: null,
  };
}

describe("MentionMenuItem", () => {
  it("renders the last-activity time on the compact ladder", () => {
    render(
      <MentionMenuItem
        entry={entry({
          updatedAt: Date.now() - 2 * HOUR_MS,
          archived: false,
          detail: "",
        })}
      />,
    );
    expect(screen.getByText("2h")).toBeTruthy();
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("renders the Archived badge alongside detail and time", () => {
    render(
      <MentionMenuItem
        entry={entry({
          updatedAt: Date.now() - 3 * 24 * HOUR_MS,
          archived: true,
          detail: "Claude Code",
        })}
      />,
    );
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("3d")).toBeTruthy();
  });

  it("renders no time slot for rows without an activity clock", () => {
    render(
      <MentionMenuItem
        entry={entry({ updatedAt: null, archived: false, detail: "src/lib" })}
      />,
    );
    expect(screen.getByText("src/lib")).toBeTruthy();
    expect(screen.queryByText("now")).toBeNull();
  });
});
