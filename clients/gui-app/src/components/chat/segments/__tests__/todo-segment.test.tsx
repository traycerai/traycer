import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TodoSegment } from "@/components/chat/segments/todo-segment";
import type { SegmentTodoItem } from "@/stores/composer/chat-store";

const ITEMS: ReadonlyArray<SegmentTodoItem> = [
  {
    id: "t1",
    status: "completed",
    text: "Wire the adapter",
    priority: "high",
    activeForm: "Wiring the adapter",
  },
  {
    id: "t2",
    status: "in_progress",
    text: "Index the header",
    priority: "medium",
    activeForm: "Indexing the header",
  },
  {
    id: "t3",
    status: "pending",
    text: "Cover with tests",
    priority: "low",
    activeForm: null,
  },
];

describe("<TodoSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders exactly the find-indexed text inside the find-unit anchor", () => {
    render(<TodoSegment items={ITEMS} findUnitId="todo-find-unit" />);

    const unitRoot = screen.getByText(/Done/).closest("[data-chat-find-unit]");
    expect(unitRoot?.getAttribute("data-chat-find-unit")).toBe(
      "todo-find-unit",
    );
    const text = unitRoot?.textContent ?? "";

    // Header count + the status-aware labels are what's findable.
    expect(text).toContain("1 of 3 Done");
    expect(text).toContain("Wire the adapter");
    expect(text).toContain("Indexing the header");
    expect(text).toContain("Cover with tests");
    // The completed item shows its plain text, not its active form.
    expect(text).not.toContain("Wiring the adapter");
    // Status / priority words are never rendered, so never findable.
    expect(text).not.toContain("pending");
    expect(text).not.toContain("in_progress");
    expect(text).not.toContain("high");
    expect(text).not.toContain("medium");
  });
});
