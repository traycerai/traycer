/**
 * The gate that decides whether a mounted office may do anything at all.
 *
 * Four independent ways a mounted office can be off screen; the hook composes
 * them into one boolean. The suite drives each of the four signals on its own
 * (leaving the other three at their permissive default) so a failure names the
 * one input that broke composition, and separately pins the recorded decision
 * that a visible-but-unfocused split pane stays ELIGIBLE - the hook takes no
 * focus signal at all, which is the point being tested.
 */
import {
  act,
  cleanup,
  render,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useOfficeEligibility } from "@/components/epic-canvas/comm-graph/office/use-office-eligibility";

afterEach(() => {
  cleanup();
});

interface ProbeProps {
  readonly intersecting: boolean;
  readonly paneVisible?: boolean;
  readonly bodySelected?: boolean;
}

/** Renders the hook's answer as text, wrapped in whichever contexts are given. */
function Probe(props: ProbeProps) {
  const { eligible } = useOfficeEligibility({
    intersecting: props.intersecting,
  });
  return <div data-testid="eligible">{String(eligible)}</div>;
}

function renderProbe(props: ProbeProps) {
  let tree = <Probe {...props} />;
  if (props.paneVisible !== undefined) {
    tree = (
      <PaneVisibilityContext value={props.paneVisible}>
        {tree}
      </PaneVisibilityContext>
    );
  }
  if (props.bodySelected !== undefined) {
    tree = (
      <TabBodySelectedContext value={props.bodySelected}>
        {tree}
      </TabBodySelectedContext>
    );
  }
  return render(tree);
}

function eligibleText(result: RenderResult): string {
  // `textContent` is non-null on `HTMLElement`, which is what the query
  // returns - see the note in `editor-core/nodes/mermaid/mermaid-node.ts`.
  return result.getByTestId("eligible").textContent;
}

describe("useOfficeEligibility", () => {
  it("is eligible when every signal is permissive", () => {
    const result = renderProbe({ intersecting: true });
    expect(eligibleText(result)).toBe("true");
  });

  it("is ineligible when the canvas is not intersecting the viewport", () => {
    const result = renderProbe({ intersecting: false });
    expect(eligibleText(result)).toBe("false");
  });

  it("is ineligible when the surrounding pane is not the visible one", () => {
    const result = renderProbe({ intersecting: true, paneVisible: false });
    expect(eligibleText(result)).toBe("false");
  });

  it("is ineligible when the tab body is not the selected one", () => {
    const result = renderProbe({ intersecting: true, bodySelected: false });
    expect(eligibleText(result)).toBe("false");
  });

  it("is ineligible while the document itself is hidden", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      const result = renderProbe({ intersecting: true });
      expect(eligibleText(result)).toBe("false");
    } finally {
      hidden.mockRestore();
    }
  });

  it("becomes eligible when visibilitychange reports the document visible again", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const result = renderProbe({ intersecting: true });
    expect(eligibleText(result)).toBe("false");

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(eligibleText(result)).toBe("true");
    hidden.mockRestore();
  });

  it("stays eligible for a visible pane that does not have focus", () => {
    // The recorded decision: the hook takes no focus signal at all, so a
    // visible-but-unfocused half of a split pane is not penalised for it. If
    // the literal "only the focused view renders" reading were wanted
    // instead, a fifth input would have to be threaded through here - which
    // is deliberately not what this hook does today.
    const result = renderProbe({
      intersecting: true,
      paneVisible: true,
      bodySelected: true,
    });
    expect(eligibleText(result)).toBe("true");
  });

  it("recomposes when only the intersection signal flips, everything else held fixed", () => {
    const result = renderProbe({
      intersecting: false,
      paneVisible: true,
      bodySelected: true,
    });
    expect(eligibleText(result)).toBe("false");

    result.rerender(
      <PaneVisibilityContext value>
        <TabBodySelectedContext value>
          <Probe intersecting />
        </TabBodySelectedContext>
      </PaneVisibilityContext>,
    );

    expect(eligibleText(result)).toBe("true");
  });
});
