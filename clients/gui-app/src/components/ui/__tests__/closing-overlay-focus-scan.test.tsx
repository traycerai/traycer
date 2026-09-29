import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function OpenSelect(props: { readonly tick: number }): React.JSX.Element {
  return (
    <Select
      items={{ a: "Alpha", b: "Beta" }}
      defaultOpen
      value="a"
      onValueChange={() => undefined}
    >
      <SelectTrigger aria-label={`Pick ${props.tick}`}>
        <SelectValue placeholder="None" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Alpha</SelectItem>
        <SelectItem value="b">Beta</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("useClosingOverlayFocus", () => {
  it("does not rescan the document for its linked trigger on unrelated re-renders", async () => {
    const scan = vi.spyOn(Document.prototype, "querySelectorAll");
    const view = render(<OpenSelect tick={0} />);
    // Base mounts the popup a commit after the Select opens; wait for it so
    // the re-renders below run with a live popup element.
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="select-content"]'),
      ).not.toBeNull(),
    );
    const scans = (): number =>
      scan.mock.calls.filter(([selector]) => selector === "[aria-controls]")
        .length;
    // The lookup lands on the first render after the popup mounts, so let that
    // one happen before taking the baseline.
    view.rerender(<OpenSelect tick={1} />);
    const afterLookup = scans();
    expect(afterLookup).toBeGreaterThan(0);

    view.rerender(<OpenSelect tick={2} />);
    view.rerender(<OpenSelect tick={3} />);
    view.rerender(<OpenSelect tick={4} />);

    expect(scans()).toBe(afterLookup);
  });
});
