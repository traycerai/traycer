import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningSegment } from "@/components/chat/segments/reasoning-segment";
import { LiveActivityPromoteContext } from "@/components/chat/segments/live-activity-promote-context";
import { SegmentRow } from "@/components/chat/segments/segment-row";

describe("<ReasoningSegment />", () => {
  afterEach(() => {
    cleanup();
    // The selection-guard test leaves a live range in the shared jsdom window;
    // clear it so a later body-click test isn't silently blocked by it.
    window.getSelection()?.removeAllRanges();
  });

  it("shows the live 'Thinking' label and tail preview while streaming", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming
        durationMs={null}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    expect(screen.getByText("Thinking")).toBeTruthy();
    // Open by default while streaming, so the tail content is visible.
    expect(screen.getByText("Considering the options")).toBeTruthy();
  });

  it("does not mark reasoning markdown as quotable", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming
        durationMs={null}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    expect(
      screen
        .getByText("Considering the options")
        .closest(".md-prose")
        ?.hasAttribute("data-quotable"),
    ).toBe(false);
  });

  it("collapses to a 'Thought for Xs' summary once completed", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={false}
        durationMs={12000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    expect(screen.getByText("Thought for 12s")).toBeTruthy();
    // Collapsed by default once done - the full trace is not rendered.
    expect(screen.queryByText("Considering the options")).toBeNull();
  });

  it("falls back to 'Thought' when no duration is known", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={false}
        durationMs={null}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    expect(screen.getByText("Thought")).toBeTruthy();
  });

  it("expands the full trace on click", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    expect(screen.queryByText("Detailed chain of thought")).toBeNull();
    fireEvent.click(screen.getByText("Thought for 3s"));
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
  });

  it("expands the streaming preview when the block body (not just the chevron) is clicked", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming
        durationMs={null}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thinking" });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    // The preview body itself is a click target, not only the header chevron.
    fireEvent.click(screen.getByText("Considering the options"));
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses again when the expanded trace body is re-clicked", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByText("Detailed chain of thought"));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not collapse when the click ends a text selection (click-drag)", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // Simulate an active (non-collapsed) text selection over the trace.
    const traceText = screen.getByText("Detailed chain of thought");
    const range = document.createRange();
    range.selectNodeContents(traceText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.click(traceText);
    // Still expanded - the click was the tail of a selection, not a toggle.
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("still toggles when the active selection is outside the block", () => {
    render(
      <div>
        <p data-testid="outside">unrelated selectable text</p>
        <ReasoningSegment
          findUnitId={null}
          markdown="Detailed chain of thought"
          isStreaming={false}
          durationMs={3000}
          bodyBoundedByParent={false}
          headerless={false}
          initiallyExpanded={false}
        />
      </div>,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // Select text OUTSIDE the reasoning block.
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("outside"));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // The stray selection is not inside this block, so the click still collapses.
    fireEvent.click(screen.getByText("Detailed chain of thought"));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("links the header to the body region via aria-controls only when shown", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    expect(header.getAttribute("aria-controls")).toBeNull();

    fireEvent.click(header);
    const controls = header.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls ?? "")).toBeTruthy();
  });

  it("rolls a multi-hour reasoning duration up to 'Xh Ym Zs'", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Considering the options"
        isStreaming={false}
        durationMs={3_661_000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    expect(screen.getByText("Thought for 1h 1m 1s")).toBeTruthy();
  });

  it("renders no header of its own when headerless, and shows the trace anyway", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless
        // FALSE, and load-bearing. With `initiallyExpanded` the body shows
        // through `expanded` alone and the `headerless` term of `bodyShown` is
        // never exercised - the assertion below would pass with the coupling
        // deleted. Completed, unbounded and unopened is the one combination
        // where `headerless` is the only thing rendering anything at all.
        initiallyExpanded={false}
      />,
    );

    // The group header above already says "Thought for 3s"; repeating it here
    // is the duplicate this mode exists to remove. No promote and no tail to
    // reveal either, so there is no hidden control to keep.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Thought for 3s")).toBeNull();
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
  });

  it("does not draw a rail of its own - the container already owns one", () => {
    const { container } = render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming
        durationMs={null}
        bodyBoundedByParent
        headerless
        initiallyExpanded
      />,
    );

    // Two nested `border-l` rails put a second vertical line beside the
    // window's own, down the whole trace.
    expect(container.querySelectorAll("[class*='border-l']").length).toBe(0);
  });

  it("collapses an unopened headerless trace once it gains a header", () => {
    // A headerless block shows its trace because there is nowhere else to put
    // it, NOT because the reader asked. When a second reasoning block joins the
    // run and this one gains a header, it must collapse like every other
    // completed block - carrying the body across left the first thought of
    // every run permanently expanded.
    const { rerender } = render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless
        initiallyExpanded={false}
      />,
    );
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();

    rerender(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Detailed chain of thought")).toBeNull();
  });

  it("keeps a trace the reader opened when the header appears", () => {
    // `expanded` is the only signal that means intent, and it must survive the
    // flip - otherwise a trace being read vanishes when a sibling arrives.
    const { rerender } = render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless
        initiallyExpanded={false}
      />,
    );

    // The headerless body is still a click target, and a click here is the
    // reader saying "keep this open".
    fireEvent.click(screen.getByText("Detailed chain of thought"));

    rerender(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
  });

  // jsdom has no layout, so this is the structural half of the alignment: a
  // thinking row and a tool row must agree on where the caret goes and on their
  // horizontal padding, or their icons start in different columns and the group
  // reads as two mis-indented lists. The rendered pixels are only checkable in
  // a browser.
  it("carries the caret trailing and hover-gated, exactly like a tool row", () => {
    render(
      <>
        <ReasoningSegment
          findUnitId={null}
          markdown="Detailed chain of thought"
          isStreaming={false}
          durationMs={3000}
          bodyBoundedByParent={false}
          headerless={false}
          initiallyExpanded={false}
        />
        <SegmentRow
          headerAction={null}
          open={false}
          onOpenChange={() => undefined}
          header={<span>Bash</span>}
          body={null}
          tone="default"
          stickyHeader={false}
          headerFindUnitId={null}
          bodyFindUnitId={null}
          expandable
          className={undefined}
          footer={null}
        />
      </>,
    );

    const rows = [
      screen.getByRole("button", { name: "Thought for 3s" }),
      screen.getByRole("button", { name: "Bash" }),
    ];
    for (const row of rows) {
      expect(row.className).toContain("px-1");
      // Queried by marker, not by `lastElementChild`: the contract under test
      // is "the caret trails and is hover-gated", and walking the child list
      // fails the moment either row grows a wrapper the caret still trails.
      const caret = row.querySelector("[data-row-caret]");
      expect(caret).not.toBeNull();
      expect(caret?.getAttribute("aria-hidden")).toBe("true");
      expect(caret?.getAttribute("class")).toContain("opacity-0");
      // The caret is still LAST - asserted on the marker, so a new wrapper
      // moves this assertion honestly instead of silently retargeting it.
      expect(row.lastElementChild).toBe(caret);
      // ...and nothing hidden leads the row, so both icons start at `px-1`.
      expect(row.firstElementChild?.getAttribute("class")).not.toContain(
        "opacity-0",
      );
    }
  });

  // A headerless streaming block inside an OPEN group has no promote, but it
  // does have a bounded tail hiding the rest of the trace - so it keeps a
  // hidden control. Expanding is what removes the tail, so gating the control
  // on the tail alone made it destroy itself on activation: the button unmounted
  // under the caret, focus fell to the body, the `aria-expanded="true"` it had
  // just earned was never announced, and there was no way back to the preview.
  it("keeps its hidden control alive through its own disclosure", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming
        durationMs={null}
        bodyBoundedByParent={false}
        headerless
        initiallyExpanded={false}
      />,
    );

    const control = screen.getByRole("button");
    expect(control.className).toContain("sr-only");
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("reasoning-tail")).toBeTruthy();

    fireEvent.click(control);

    // Same button, still there, now reporting the state it produced - and it
    // toggles back.
    const afterOpen = screen.getByRole("button");
    expect(afterOpen).toBe(control);
    expect(afterOpen.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByTestId("reasoning-tail")).toBeNull();

    fireEvent.click(afterOpen);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.getByTestId("reasoning-tail")).toBeTruthy();
  });

  // Surviving its own disclosure is not the same as being worth pressing. Once
  // the block completes there is no tail to collapse back to and a headerless
  // body shows in full either way, so a retained control announced
  // `aria-expanded="true"`, changed no pixels when pressed, and then deleted
  // itself - dropping the caret to the top of the transcript on the way out.
  it("drops its hidden control once completion makes it meaningless, handing focus to the trace", () => {
    const props = {
      findUnitId: null,
      markdown: "Detailed chain of thought",
      durationMs: null,
      bodyBoundedByParent: false,
      headerless: true,
      initiallyExpanded: false,
    } as const;
    const { rerender } = render(<ReasoningSegment {...props} isStreaming />);

    const control = screen.getByRole("button");
    fireEvent.click(control);
    control.focus();
    expect(document.activeElement).toBe(control);

    // The stream ends. Nothing about the trace changes - it was already showing
    // in full - so the control has nothing left to do.
    rerender(
      <ReasoningSegment {...props} isStreaming={false} durationMs={3000} />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
    // Focus went to the trace, not to the top of the transcript.
    expect(document.activeElement).not.toBe(document.body);
    expect(
      (document.activeElement as HTMLElement).contains(
        screen.getByText("Detailed chain of thought"),
      ),
    ).toBe(true);
  });

  // The handoff must fire ONLY when the control actually goes away. A HEADED
  // block keeps its button through the same completion transition, so moving
  // focus out of it takes away the reader's Space/Enter route and relocates
  // them for no visible reason - the button is still sitting right there.
  //
  // Two guards stop this and either one is sufficient: `headerless &&` on the
  // effect, and the `activeElement === body` check inside it. So a mutation of
  // just one SURVIVES this test - that is redundancy, not a gap. Removing both
  // fails it. Do not read a surviving single-guard mutant as untested.
  it("leaves focus alone when the header survives completion", () => {
    const props = {
      findUnitId: null,
      markdown: "Detailed chain of thought",
      durationMs: null,
      bodyBoundedByParent: false,
      headerless: false,
      initiallyExpanded: true,
    } as const;
    const { rerender } = render(<ReasoningSegment {...props} isStreaming />);

    const header = screen.getByRole("button");
    header.focus();
    expect(document.activeElement).toBe(header);

    rerender(
      <ReasoningSegment {...props} isStreaming={false} durationMs={3000} />,
    );

    // Same button, still mounted, still holding the caret.
    expect(screen.getByRole("button")).toBe(header);
    expect(document.activeElement).toBe(header);
  });

  // The reader moved the caret somewhere deliberately between the commit and
  // the effect. An effect that fires regardless would yank them back.
  //
  // Same redundancy as above: the blur handler clearing the latch (on a blur
  // that names where focus went) and the `activeElement === body` check each
  // stop this alone, so only removing both fails this test.
  it("does not reclaim focus the reader has moved elsewhere", () => {
    const props = {
      findUnitId: null,
      markdown: "Detailed chain of thought",
      durationMs: null,
      bodyBoundedByParent: false,
      headerless: true,
      initiallyExpanded: false,
    } as const;
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
      const { rerender } = render(<ReasoningSegment {...props} isStreaming />);

      const control = screen.getByRole("button", { name: /Thinking/ });
      fireEvent.click(control);
      control.focus();
      // Moving on before the stream ends must clear the latch. `relatedTarget`
      // is the element receiving focus - that is what makes this a reader who
      // left, as opposed to a control that was taken away.
      fireEvent.blur(control, { relatedTarget: elsewhere });
      elsewhere.focus();

      rerender(
        <ReasoningSegment {...props} isStreaming={false} durationMs={3000} />,
      );

      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  // The other half of the ambiguous blur. A click on a non-focusable transcript
  // surface ALSO blurs with no `relatedTarget` and leaves focus on the body, and
  // it is a deliberate departure - so completion must not pull the reader back
  // into the trace. Indistinguishable from a removal blur at dispatch time,
  // which is why the layout effect re-reads real focus ownership every commit
  // and corrects the latch while the control still exists.
  // NO intervening render between the click-away and the completion that
  // removes the control. The first version of this test put a streaming rerender
  // in between, which is what the then-current fix needed to observe the blur -
  // so the test passed for a reason the product could not rely on, and the bug
  // it claimed to cover still reproduced without that extra commit. The latch is
  // now settled off the event itself, not off the next render.
  it("does not reclaim focus after the reader clicks away to nothing", async () => {
    const props = {
      findUnitId: null,
      markdown: "Detailed chain of thought",
      durationMs: null,
      bodyBoundedByParent: false,
      headerless: true,
      initiallyExpanded: false,
    } as const;
    const { rerender } = render(<ReasoningSegment {...props} isStreaming />);

    const control = screen.getByRole("button", { name: /Thinking/ });
    control.focus();
    expect(document.activeElement).toBe(control);

    // Clicked a non-focusable surface: blurred to nothing, focus on the body,
    // and the control is still sitting there.
    control.blur();
    fireEvent.blur(control, { relatedTarget: null });
    expect(document.activeElement).toBe(document.body);

    // Let the microtask that settles the ambiguous blur run. This is the only
    // thing standing between the click and the completion - no re-render.
    await act(async () => {});

    rerender(
      <ReasoningSegment {...props} isStreaming={false} durationMs={3000} />,
    );

    // Control gone, and focus left where the reader put it.
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  // The click-to-toggle listener spans the whole body, and reasoning markdown
  // renders real controls into it - a code block's copy button, links, reference
  // chips. Without a guard the control's own click ALSO promotes: the copy runs,
  // and then the group opens, scrolls and takes focus for a gesture that asked
  // for none of it.
  it("does not promote when an interactive element inside the trace is clicked", () => {
    const promote = vi.fn();
    render(
      <LiveActivityPromoteContext.Provider value={promote}>
        <ReasoningSegment
          findUnitId={null}
          markdown="Consider `code`\n\n[a link](https://example.com)"
          isStreaming
          durationMs={null}
          bodyBoundedByParent
          headerless
          initiallyExpanded={false}
        />
      </LiveActivityPromoteContext.Provider>,
    );

    const link = screen.getByRole("link");
    fireEvent.click(link);
    expect(promote).not.toHaveBeenCalled();

    // ...and the body still toggles for a click on ordinary prose, so the guard
    // suppressed the control's click rather than the whole listener.
    fireEvent.click(screen.getByText(/Consider/));
    expect(promote).toHaveBeenCalledTimes(1);
  });

  // `<summary>` is the interactive element that looks least like one: no ARIA
  // role, not focusable by default, styled as prose. But `<details>` is
  // supported end to end - `MERGEABLE_HTML_CONTAINERS` exists precisely to keep
  // a blank-line-split disclosure in a single block - so a trace can ship one,
  // and its summary is a real control the reader clicks to open the nested
  // section, not to fold the reasoning around it.
  const DETAILS_TRACE = [
    "Before the disclosure.",
    "",
    "<details>",
    "<summary>Show the sub-trace</summary>",
    "",
    "Nested detail.",
    "",
    "</details>",
  ].join("\n");

  it("does not collapse the trace when a nested <summary> is clicked", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown={DETAILS_TRACE}
        isStreaming={false}
        durationMs={3000}
        bodyBoundedByParent={false}
        headerless={false}
        initiallyExpanded={false}
      />,
    );

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // The disclosure really rendered - otherwise this test proves nothing about
    // a control it never showed.
    const summary = screen.getByText("Show the sub-trace");
    expect(summary.tagName).toBe("SUMMARY");

    fireEvent.click(summary);

    // Opening the nested section left the reasoning block the reader is reading
    // exactly where it was.
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // ...and the guard suppressed the control's click, not the whole listener.
    fireEvent.click(screen.getByText("Before the disclosure."));
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not promote when a nested <summary> is clicked in the live window", () => {
    const promote = vi.fn();
    render(
      <LiveActivityPromoteContext.Provider value={promote}>
        <ReasoningSegment
          findUnitId={null}
          markdown={DETAILS_TRACE}
          isStreaming
          durationMs={null}
          bodyBoundedByParent
          headerless
          initiallyExpanded={false}
        />
      </LiveActivityPromoteContext.Provider>,
    );

    fireEvent.click(screen.getByText("Show the sub-trace"));
    expect(promote).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Before the disclosure."));
    expect(promote).toHaveBeenCalledTimes(1);
  });

  // The companion to "keeps a trace the reader opened when the header appears".
  // That pin is deliberate, but on a COMPLETED headerless block the gesture is
  // invisible - the body is already fully shown - so a second click un-pinning
  // it means two identical, equally invisible gestures produce opposite results.
  // Where the click cannot be seen it only ever pins.
  it("does not un-pin a completed headerless trace on a second invisible click", () => {
    const props = {
      findUnitId: null,
      markdown: "Detailed chain of thought",
      isStreaming: false,
      durationMs: 3000,
      bodyBoundedByParent: false,
      initiallyExpanded: false,
    } as const;
    const { rerender } = render(<ReasoningSegment {...props} headerless />);

    // Body on screen, no header of its own - so neither click changes a pixel.
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();

    const trace = screen.getByText("Detailed chain of thought");
    fireEvent.click(trace);
    fireEvent.click(trace);

    // A sibling segment arrives and the block gets its header back. The trace
    // the reader was reading stays put; the second click did not undo the first.
    rerender(<ReasoningSegment {...props} headerless={false} />);

    const header = screen.getByRole("button", { name: "Thought for 3s" });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();
  });

  // jsdom dispatches NO blur when a focused element is removed; Chromium - the
  // engine this actually ships in - does. So a blur handler that cleared the
  // latch unconditionally made the handoff a no-op in the real product while
  // every test here stayed green. `relatedTarget` separates the two cases:
  // removal hands focus to nothing.
  //
  // This test simulates the browser jsdom is not, so it fails only for the code
  // under test and not for the environment.
  //
  // KNOWN UNTESTABLE HERE: the `control.isConnected` check inside the blur's
  // microtask. Removing it leaves every test in this file green, and that is the
  // environment, not a gap. In Chromium the removal blur fires during the
  // commit, the microtask flushes before React's passive effects, and the
  // control is already detached - so the check preserves the latch and the
  // handoff below runs. Clearing unconditionally would put the latch at false
  // before the effect reads it and silently kill the handoff again. jsdom
  // dispatches no removal blur at all, so that ordering never occurs here and no
  // assertion can reach it. Do not delete the check on the strength of a
  // surviving mutant.
  it("still hands off when removal itself blurs the control", () => {
    const props = {
      findUnitId: null,
      markdown: "Detailed chain of thought",
      durationMs: null,
      bodyBoundedByParent: false,
      headerless: true,
      initiallyExpanded: false,
    } as const;
    const { rerender } = render(<ReasoningSegment {...props} isStreaming />);

    const control = screen.getByRole("button", { name: /Thinking/ });
    control.focus();
    expect(document.activeElement).toBe(control);

    // What Chromium does on its way to removing a focused element: blur with no
    // element to hand focus to, then focus falls to the body.
    fireEvent.blur(control, { relatedTarget: null });

    rerender(
      <ReasoningSegment {...props} isStreaming={false} durationMs={3000} />,
    );

    // The control is gone, and focus is on the trace rather than stranded at
    // the top of the transcript.
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(
      (document.activeElement as HTMLElement).contains(
        screen.getByText("Detailed chain of thought"),
      ),
    ).toBe(true);
  });

  // It toggles, so its name has to say what pressing it does NOW. Reporting
  // `aria-expanded="true"` under the label "show the full reasoning" described
  // the opposite of the action.
  it("names the hidden control for the action it will perform", () => {
    render(
      <ReasoningSegment
        findUnitId={null}
        markdown="Detailed chain of thought"
        isStreaming
        durationMs={null}
        bodyBoundedByParent={false}
        headerless
        initiallyExpanded={false}
      />,
    );

    const control = screen.getByRole("button");
    expect(control.getAttribute("aria-label")).toBe(
      "Thinking - show the full reasoning",
    );

    fireEvent.click(control);

    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Thinking - collapse to the preview",
    );
  });

  it("promotes instead of toggling when rendered inside the live window", () => {
    const promote = vi.fn();
    render(
      <LiveActivityPromoteContext.Provider value={promote}>
        <ReasoningSegment
          findUnitId={null}
          markdown="Detailed chain of thought"
          isStreaming
          durationMs={null}
          bodyBoundedByParent
          headerless={false}
          initiallyExpanded={false}
        />
      </LiveActivityPromoteContext.Provider>,
    );

    const header = screen.getByRole("button", { name: "Thinking" });
    // Nothing here discloses, so the button must not report a disclosure state
    // at all - the same call `PromotingSegmentRow` makes with
    // `rotateWhenOpen={false}`. Reporting `aria-expanded="false"` told a screen
    // reader this control opens something in place, which it does not.
    expect(header.getAttribute("aria-expanded")).toBeNull();
    // And `aria-controls` goes with it. Naming a body as this button's
    // disclosure target while declining to report that body's state is half a
    // claim: it points assistive tech at an element whose visibility the button
    // does not own. The streaming body IS rendered here, so `controlsId` is
    // non-null and this asserts the promotion branch, not an empty one.
    expect(header.getAttribute("aria-controls")).toBeNull();
    expect(screen.getByText("Detailed chain of thought")).toBeTruthy();

    fireEvent.click(header);

    // Expanding in place would open into a four-line box; the click leaves it.
    expect(promote).toHaveBeenCalledTimes(1);
    expect(header.getAttribute("aria-expanded")).toBeNull();
    expect(header.getAttribute("aria-controls")).toBeNull();
    expect(screen.queryByTestId("reasoning-tail")).toBeNull();
  });
});
