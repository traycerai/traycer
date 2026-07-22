import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import { MentionSuggestionList } from "../collaborator-mention-suggestion";

afterEach(() => cleanup());

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
