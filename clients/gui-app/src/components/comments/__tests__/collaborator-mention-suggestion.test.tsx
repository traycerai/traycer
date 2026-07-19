import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MentionSuggestionList } from "../collaborator-mention-suggestion";

afterEach(() => {
  cleanup();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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
