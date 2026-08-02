import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { MentionSuggestionList } from "../collaborator-mention-suggestion";

afterEach(() => cleanup());

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("MentionSuggestionList portal routing (HIGH3)", () => {
  // The mention list is nested inside the (otherwise fixed) comment composer but
  // escaped to `document.body`; hiding the parent portal host did not hide it.
  // It must render into the pane portal host so it is hidden + inert with a
  // background split pane. `thread-anchor-hover-popover.tsx` uses the identical
  // `usePanePortalContainer()` routing.
  it("renders into the pane portal host, not document.body", () => {
    render(
      <SurfacePresentationBoundary visible focused>
        <MentionSuggestionList
          items={[{ userId: "u1", displayName: "Alice", email: "a@x.io" }]}
          command={() => undefined}
          getReferenceClientRect={() => new DOMRect(0, 0, 0, 0)}
        />
      </SurfacePresentationBoundary>,
    );
    const list = screen.getByRole("listbox");
    expect(list.closest("[data-slot='pane-portal-host']")).not.toBeNull();
  });
});

describe("MentionSuggestionList", () => {
  it("renders the empty state instead of crashing when items is empty", async () => {
    // Regression: the scroll-into-view effect indexed itemRefs with a
    // `=== null` guard, but an empty `items` array never populates any
    // itemRefs slot, so the ref there is `undefined` - `undefined` !==
    // `null`, so the guard didn't catch it and `undefined.scrollIntoView`
    // threw during commit, crashing before the empty state could render.
    render(
      <MentionSuggestionList
        items={[]}
        command={vi.fn()}
        getReferenceClientRect={null}
      />,
    );
    await flush();

    expect(screen.getByText("No matching collaborators")).toBeTruthy();
  });
});
