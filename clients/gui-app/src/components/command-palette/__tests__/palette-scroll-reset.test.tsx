import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { usePaletteScrollReset } from "@/components/command-palette/palette-cmdk-controller";

function Harness({ setQuery }: { readonly setQuery: (value: string) => void }) {
  const { listRef, handleQueryChange } = usePaletteScrollReset(setQuery);
  return (
    <>
      <div data-testid="list" ref={listRef} />
      <button type="button" onClick={() => handleQueryChange("next")}>
        change
      </button>
    </>
  );
}

afterEach(cleanup);

describe("usePaletteScrollReset", () => {
  it("forwards the query and snaps the bound list back to the top on the next frame", async () => {
    const setQuery = vi.fn();
    render(<Harness setQuery={setQuery} />);
    const list = screen.getByTestId("list");
    // jsdom has no layout, so back scrollTop with a real read/write property.
    let scrollTop = 240;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    fireEvent.click(screen.getByText("change"));

    expect(setQuery).toHaveBeenCalledWith("next");
    await waitFor(() => expect(scrollTop).toBe(0));
  });
});
