import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  isSingleUsableSelection,
  resolveQuoteSelection,
  useQuoteSelection,
} from "../use-quote-selection";
import { buildQuoteBlockquote } from "../append-quote-to-draft";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function firstText(element: Element): Text {
  const node = element.firstChild;
  if (!(node instanceof Text)) throw new Error("expected a leading text node");
  return node;
}

/** Builds a quotable prose root (no inter-element whitespace text nodes). */
function makeProseRoot(paragraphs: ReadonlyArray<string>): {
  readonly root: HTMLElement;
  readonly paragraphs: ReadonlyArray<HTMLElement>;
} {
  const root = document.createElement("div");
  root.setAttribute("data-quotable", "true");
  root.className = "md-prose";
  const rendered = paragraphs.map((text) => {
    const p = document.createElement("p");
    p.textContent = text;
    root.appendChild(p);
    return p;
  });
  document.body.appendChild(root);
  return { root, paragraphs: rendered };
}

describe("resolveQuoteSelection - endpoint resolution", () => {
  it("resolves element-node containers to the shared quotable root", () => {
    const { root } = makeProseRoot(["First paragraph.", "Second paragraph."]);
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(root, 2);

    const snapshot = resolveQuoteSelection(
      range,
      "First paragraph.\nSecond paragraph.",
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fenceLanguage).toBeNull();
  });

  it("accepts a triple-click on the FIRST block (end at offset 0 of the next, in-root block)", () => {
    const { paragraphs } = makeProseRoot(["First.", "Second.", "Third."]);
    const range = document.createRange();
    range.setStart(firstText(paragraphs[0]), 0);
    range.setEnd(paragraphs[1], 0);

    expect(resolveQuoteSelection(range, "First.")).not.toBeNull();
  });

  it("accepts a triple-click on a MIDDLE block", () => {
    const { paragraphs } = makeProseRoot(["First.", "Second.", "Third."]);
    const range = document.createRange();
    range.setStart(firstText(paragraphs[1]), 0);
    range.setEnd(paragraphs[2], 0);

    expect(resolveQuoteSelection(range, "Second.")).not.toBeNull();
  });

  it("clamps a triple-click on the LAST block back into the root instead of rejecting", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    // Sibling AFTER the quotable root; triple-click extends the end to its start.
    const nextSteps = document.createElement("div");
    nextSteps.setAttribute("data-quote-exclude", "");
    nextSteps.textContent = "Next steps";
    segment.appendChild(nextSteps);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(nextSteps, 0);

    const snapshot = resolveQuoteSelection(range, "Third.");
    expect(snapshot).not.toBeNull();
    // End clamped to the root's end, so the range never reaches the sibling.
    expect(snapshot?.range.endContainer).toBe(root);
    expect(snapshot?.range.endOffset).toBe(root.childNodes.length);
  });

  it("rejects a clamp whose clamped-away region holds real text (no cross-root text leak)", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    // Non-quotable prose BETWEEN the root and the element boundary the end
    // lands on: clamping here would emit "Intervening prose" (still present in
    // the selection text) as if it belonged to the assistant message.
    const intervening = document.createElement("div");
    intervening.textContent = "Intervening prose";
    const nextSteps = document.createElement("div");
    nextSteps.setAttribute("data-quote-exclude", "");
    nextSteps.textContent = "Next steps";
    segment.append(root, intervening, nextSteps);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(nextSteps, 0);

    expect(
      resolveQuoteSelection(range, "Third.\nIntervening prose"),
    ).toBeNull();
  });

  it("clamps past an assistant elapsed-footer even when its provider icon has an SVG title (invisible title text doesn't count as real tail content)", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    // Sibling AFTER the quotable root, shaped like the real elapsed footer:
    // a provider icon (SVG with an accessibility-only <title>) plus an
    // elapsed-time label. Triple-click extends the end into the label span.
    const footer = document.createElement("button");
    footer.setAttribute("data-testid", "assistant-elapsed-footer");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const title = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    title.textContent = "Claude";
    svg.appendChild(title);
    const footerSpan = document.createElement("span");
    footerSpan.textContent = "Mulled for 4s";
    footer.append(svg, footerSpan);
    segment.appendChild(footer);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(footerSpan, 0);

    // jsdom's `Range`/`Selection.toString()` both include the SVG title's
    // text (plain DOM concatenation) - real Chromium's `Selection.toString()`
    // does NOT, since `<title>` produces no layout box. Don't trust this
    // jsdom value as the production `selectionText` contract; a hand-authored,
    // browser-shaped string is passed below instead. This assertion just
    // documents the divergence so a future edit doesn't "simplify" this test
    // back to `range.toString()`.
    expect(range.toString()).toBe("Third.Claude");

    // Browser-shaped: no leaked "Claude" (real Chromium excludes it), with
    // the trailing block-boundary blank line the browser synthesizes at the
    // selection's end for a last-paragraph triple-click.
    const selectionText = "Third.\n\n";
    const snapshot = resolveQuoteSelection(range, selectionText);
    expect(snapshot).not.toBeNull();
    // Nothing to strip - passes through unchanged. Dropping the trailing
    // blank line is `buildQuoteBlockquote`'s job, not this hook's.
    expect(snapshot?.text).toBe("Third.\n\n");
    // End clamped to the root's end, so the range never reaches the footer.
    expect(snapshot?.range.endContainer).toBe(root);
    expect(snapshot?.range.endOffset).toBe(root.childNodes.length);
  });

  it("preserves multi-paragraph block boundaries in the emitted text for an accepted clamp", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const first = document.createElement("p");
    first.textContent = "First.";
    const second = document.createElement("p");
    second.textContent = "Second.";
    root.append(first, second);
    segment.appendChild(root);
    const footer = document.createElement("button");
    footer.setAttribute("data-testid", "assistant-elapsed-footer");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const title = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    title.textContent = "Claude";
    svg.appendChild(title);
    const footerSpan = document.createElement("span");
    footerSpan.textContent = "Mulled for 4s";
    footer.append(svg, footerSpan);
    segment.appendChild(footer);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(first), 0);
    range.setEnd(footerSpan, 0);

    // Browser-shaped: real Chromium's `Selection.toString()` keeps the
    // paragraph-boundary blank line BETWEEN blocks. A derived
    // `Range.toString()` would flatten this to "First.Second." instead -
    // the regression an earlier fix attempt introduced.
    const selectionText = "First.\n\nSecond.\n\n";
    const snapshot = resolveQuoteSelection(range, selectionText);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.text).toBe("First.\n\nSecond.\n\n");
    expect(snapshot?.range.endContainer).toBe(root);
    expect(snapshot?.range.endOffset).toBe(root.childNodes.length);
  });

  it("clamps past an out-of-root data-quote-exclude sibling and excludes its text from the emitted quote", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    // Chrome AFTER the quotable root: an excluded label (real text, but
    // data-quote-exclude) followed by a trailing span the triple-click
    // extends into - mirrors the elapsed-footer shape without an SVG title,
    // so the excluded label fully precedes the end boundary in document
    // order and actually lands in the clamped-away/raw-selection text.
    const chrome = document.createElement("div");
    const excludedLabel = document.createElement("span");
    excludedLabel.setAttribute("data-quote-exclude", "");
    excludedLabel.textContent = "Next steps";
    const trailingSpan = document.createElement("span");
    trailingSpan.textContent = "tail";
    chrome.append(excludedLabel, trailingSpan);
    segment.appendChild(chrome);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(trailingSpan, 0);

    // Browser-shaped: unlike an SVG title, real Chromium's
    // `Selection.toString()` DOES include this visible (merely
    // quote-excluded) label text - it's ordinary rendered HTML. A
    // block-boundary blank line separates the root's paragraph from the
    // chrome div.
    const selectionText = "Third.\n\nNext steps";
    const snapshot = resolveQuoteSelection(range, selectionText);
    expect(snapshot).not.toBeNull();
    // The excluded tail is stripped from the emitted quote text, not just
    // absent from the popover's clamped range.
    expect(snapshot?.text).toBe("Third.");
    expect(snapshot?.range.endContainer).toBe(root);
    expect(snapshot?.range.endOffset).toBe(root.childNodes.length);
  });

  it("strips ALL rendered option labels from a NextStepsActionGroup-shaped excluded container, not just the first", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    // Mirrors the real NextStepsActionGroup: ONE data-quote-exclude flex
    // container wrapping MULTIPLE separately rendered option buttons, each
    // its own text node - not one merged string. Chromium inserts a layout
    // separator between them even though they share an excluded ancestor.
    const nextSteps = document.createElement("div");
    nextSteps.setAttribute("data-quote-exclude", "");
    const option1 = document.createElement("button");
    const option1Label = document.createElement("span");
    option1Label.textContent = "Create the plan (1)";
    option1.appendChild(option1Label);
    const option2 = document.createElement("button");
    const option2Label = document.createElement("span");
    option2Label.textContent = "Review + ship?";
    option2.appendChild(option2Label);
    nextSteps.append(option1, option2);
    segment.appendChild(nextSteps);
    const trailingSibling = document.createElement("span");
    trailingSibling.textContent = "tail";
    segment.appendChild(trailingSibling);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(trailingSibling, 0);

    // Browser-shaped, matching a real Chrome 148 capture: a block-boundary
    // blank line between EACH separately rendered option, not just before
    // the excluded container as a whole.
    const selectionText = "Third.\n\nCreate the plan (1)\n\nReview + ship?\n\n";
    const snapshot = resolveQuoteSelection(range, selectionText);
    expect(snapshot).not.toBeNull();
    // Both option labels must be gone, not just the first (a naive
    // parts.join("") regex would only match a single unbroken run and miss
    // this).
    expect(snapshot?.text).toBe("Third.");
  });

  it("does not strip an earlier, unrelated occurrence of similar wording in the quoted body", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    // The quoted body legitimately contains wording that also appears (as an
    // excluded option label) in the trailing chrome - only the trailing,
    // excluded occurrence must be stripped.
    paragraph.textContent = "Third: Review + ship? is the plan.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    const nextSteps = document.createElement("div");
    nextSteps.setAttribute("data-quote-exclude", "");
    const option = document.createElement("button");
    const optionLabel = document.createElement("span");
    optionLabel.textContent = "Review + ship?";
    option.appendChild(optionLabel);
    nextSteps.appendChild(option);
    segment.appendChild(nextSteps);
    const trailingSibling = document.createElement("span");
    trailingSibling.textContent = "tail";
    segment.appendChild(trailingSibling);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(trailingSibling, 0);

    const selectionText =
      "Third: Review + ship? is the plan.\n\nReview + ship?\n\n";
    const snapshot = resolveQuoteSelection(range, selectionText);
    expect(snapshot).not.toBeNull();
    // Only the trailing occurrence is stripped (end-anchored match); the
    // legitimate earlier occurrence in the quoted body survives.
    expect(snapshot?.text).toBe("Third: Review + ship? is the plan.");
  });

  it("treats an HTML-namespace element merely NAMED 'desc' as visible text (namespace-scoped, not tag-name-only)", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    const chrome = document.createElement("div");
    // An HTML (non-SVG) element merely NAMED "desc" - not the SVG
    // accessibility element - so its real text must still count as visible.
    const htmlDesc = document.createElement("desc");
    htmlDesc.textContent = "Visible description";
    const trailingSpan = document.createElement("span");
    trailingSpan.textContent = "tail";
    chrome.append(htmlDesc, trailingSpan);
    segment.appendChild(chrome);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(trailingSpan, 0);

    expect(range.toString()).toBe("Third.Visible description");
    expect(resolveQuoteSelection(range, range.toString())).toBeNull();
  });

  it("clamps past an SVG <defs> subtree (non-rendered definitions, not just <title>/<desc>)", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    const chrome = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    // Text under <defs> is never painted directly (only reachable via
    // <use>), so it must not block the clamp.
    defs.textContent = "reusable-icon-label";
    svg.appendChild(defs);
    const trailingSpan = document.createElement("span");
    trailingSpan.textContent = "tail";
    chrome.append(svg, trailingSpan);
    segment.appendChild(chrome);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(trailingSpan, 0);

    // Real Chromium excludes <defs> content from Selection.toString() the
    // same way it excludes <title>/<desc> (no layout box) - nothing to strip.
    const selectionText = "Third.";
    const snapshot = resolveQuoteSelection(range, selectionText);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.text).toBe("Third.");
  });

  it("still rejects a clamp when a rendered SVG <text> element holds real content", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    const chrome = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const svgText = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    // SVG <text> IS painted, so it counts as real content even inside an SVG.
    svgText.textContent = "rendered label";
    svg.appendChild(svgText);
    const trailingSpan = document.createElement("span");
    trailingSpan.textContent = "tail";
    chrome.append(svg, trailingSpan);
    segment.appendChild(chrome);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(trailingSpan, 0);

    expect(range.toString()).toBe("Third.rendered label");
    expect(resolveQuoteSelection(range, range.toString())).toBeNull();
  });

  it("still rejects a clamp when the footer region also holds real visible text alongside the SVG title", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const paragraph = document.createElement("p");
    paragraph.textContent = "Third.";
    root.appendChild(paragraph);
    segment.appendChild(root);
    // A real, visible label BETWEEN the root and the footer - not wrapped in
    // <title>/<desc>/[data-quote-exclude] - so the guard must still see it.
    const label = document.createElement("span");
    label.textContent = "Provider label";
    segment.appendChild(label);
    const footer = document.createElement("button");
    footer.setAttribute("data-testid", "assistant-elapsed-footer");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const title = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "title",
    );
    title.textContent = "Claude";
    svg.appendChild(title);
    const footerSpan = document.createElement("span");
    footerSpan.textContent = "Mulled for 4s";
    footer.append(svg, footerSpan);
    segment.appendChild(footer);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(paragraph), 0);
    range.setEnd(footerSpan, 0);

    expect(resolveQuoteSelection(range, "Third.\nProvider label")).toBeNull();
  });
});

describe("resolveQuoteSelection - validity rules", () => {
  it("rejects a selection spanning two segments (different quotable roots in one message)", () => {
    const message = document.createElement("div");
    const first = document.createElement("div");
    first.setAttribute("data-quotable", "true");
    first.textContent = "Segment one.";
    const second = document.createElement("div");
    second.setAttribute("data-quotable", "true");
    second.textContent = "Segment two.";
    message.append(first, second);
    document.body.appendChild(message);

    const range = document.createRange();
    range.setStart(firstText(first), 0);
    range.setEnd(firstText(second), 5);

    expect(
      resolveQuoteSelection(range, "Segment one.\nSegment two."),
    ).toBeNull();
  });

  it("rejects a selection spanning two messages", () => {
    const a = makeProseRoot(["Message A body."]);
    const b = makeProseRoot(["Message B body."]);
    const range = document.createRange();
    range.setStart(firstText(a.paragraphs[0]), 0);
    range.setEnd(firstText(b.paragraphs[0]), 5);

    expect(
      resolveQuoteSelection(range, "Message A body.\nMessage B"),
    ).toBeNull();
  });

  it("rejects a range that crosses into the streaming unstable tail", () => {
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const frozen = document.createElement("p");
    frozen.textContent = "Frozen prefix.";
    root.appendChild(frozen);
    const unstable = document.createElement("div");
    unstable.setAttribute("data-md-unstable", "");
    const tail = document.createElement("p");
    tail.textContent = "Streaming tail.";
    unstable.appendChild(tail);
    root.appendChild(unstable);
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(firstText(frozen), 0);
    range.setEnd(firstText(tail), 5);

    expect(
      resolveQuoteSelection(range, "Frozen prefix.\nStreaming tail."),
    ).toBeNull();
  });

  it("rejects a range intersecting a nested quote-exclude region", () => {
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const before = document.createElement("p");
    before.textContent = "Before.";
    const excluded = document.createElement("span");
    excluded.setAttribute("data-quote-exclude", "");
    excluded.textContent = "widget";
    const after = document.createElement("p");
    after.textContent = "After.";
    root.append(before, excluded, after);
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(firstText(before), 0);
    range.setEnd(firstText(after), 5);

    expect(resolveQuoteSelection(range, "Before. widget After")).toBeNull();
  });

  it("rejects a whitespace-only selection", () => {
    const { paragraphs } = makeProseRoot(["   "]);
    const range = document.createRange();
    range.selectNodeContents(paragraphs[0]);

    expect(resolveQuoteSelection(range, "   \n\t ")).toBeNull();
  });

  it("rejects a selection that crosses an interactive reference chip", () => {
    // Reference chips (agent/spec/ticket/chat) carry data-quote-exclude, so a
    // drag across one must not quote the chip label as prose.
    const { root, before, after } = makeChipParagraph();
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, 6);
    expect(root.isConnected).toBe(true);

    expect(resolveQuoteSelection(range, "Before chip after.")).toBeNull();
  });

  it("accepts prose that merely sits near a chip without intersecting it", () => {
    const { before } = makeChipParagraph();
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(before, 6);

    expect(resolveQuoteSelection(range, "Before")).not.toBeNull();
  });
});

describe("resolveQuoteSelection - extraction and fence detection", () => {
  it("emits plain multi-paragraph text with no fence language", () => {
    const { root } = makeProseRoot(["First paragraph.", "Second paragraph."]);
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(root, 2);

    const snapshot = resolveQuoteSelection(
      range,
      "First paragraph.\nSecond paragraph.",
    );
    expect(snapshot?.fenceLanguage).toBeNull();
    expect(
      snapshot === null
        ? null
        : buildQuoteBlockquote({
            text: snapshot.text,
            fenceLanguage: snapshot.fenceLanguage,
          }),
    ).toEqual({
      type: "blockquote",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph." }],
        },
      ],
    });
  });

  it("captures the language when the whole range is inside one code block", () => {
    const { root, code } = makeCodeRoot("ts");
    const range = document.createRange();
    range.selectNodeContents(code);

    const snapshot = resolveQuoteSelection(range, "const x = 1;");
    expect(root.contains(code)).toBe(true);
    expect(snapshot?.fenceLanguage).toBe("ts");
  });

  it("treats a present-but-empty data-language as a (plaintext) fence", () => {
    const { code } = makeCodeRoot("");
    const range = document.createRange();
    range.selectNodeContents(code);

    expect(resolveQuoteSelection(range, "plain code")?.fenceLanguage).toBe("");
  });

  it("falls back to plain text when the range only partially overlaps a code block", () => {
    const { codeBlock, outro } = makeCodeRoot("ts");
    const codeText = firstText(codeBlockText(codeBlock));
    const range = document.createRange();
    range.setStart(codeText, 0);
    range.setEnd(firstText(outro), 4);

    expect(
      resolveQuoteSelection(range, "const x = 1;\nOutro")?.fenceLanguage,
    ).toBeNull();
  });

  it("keeps the fence language when a triple-click on a TRAILING code block clamps at the root end", () => {
    const segment = document.createElement("div");
    const root = document.createElement("div");
    root.setAttribute("data-quotable", "true");
    const codeBlock = document.createElement("div");
    codeBlock.setAttribute("data-quote-code-block", "");
    codeBlock.setAttribute("data-language", "ts");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = "const x = 1;";
    pre.appendChild(code);
    codeBlock.appendChild(pre);
    root.appendChild(codeBlock);
    // Triple-click on the last code line lands the end at the start of the
    // NEXT element outside the root; the clamped end sits on the root itself,
    // so fence detection must resolve it into the trailing code block.
    const nextSteps = document.createElement("div");
    nextSteps.setAttribute("data-quote-exclude", "");
    nextSteps.textContent = "Next steps";
    segment.append(root, nextSteps);
    document.body.appendChild(segment);

    const range = document.createRange();
    range.setStart(firstText(code), 0);
    range.setEnd(nextSteps, 0);

    const snapshot = resolveQuoteSelection(range, "const x = 1;");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.fenceLanguage).toBe("ts");
  });
});

describe("useQuoteSelection - gating", () => {
  it("attaches listeners only while enabled and tears them down on toggle off", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const ref: { current: HTMLElement | null } = { current: container };
    const addSpy = vi.spyOn(container, "addEventListener");
    const removeSpy = vi.spyOn(container, "removeEventListener");

    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useQuoteSelection({ containerRef: ref, enabled: props.enabled }),
      { initialProps: { enabled: false } },
    );

    expect(result.current.snapshot).toBeNull();
    expect(addSpy).not.toHaveBeenCalledWith("mouseup", expect.any(Function));

    rerender({ enabled: true });
    expect(addSpy).toHaveBeenCalledWith("mouseup", expect.any(Function));

    rerender({ enabled: false });
    expect(removeSpy).toHaveBeenCalledWith("mouseup", expect.any(Function));
    expect(result.current.snapshot).toBeNull();
  });
});

describe("useQuoteSelection - deferred mouseup read", () => {
  it("defers the selection read by one frame instead of reading it synchronously", async () => {
    const { container, paragraph } = makeContainerWithProse("Quotable text.");
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selectRange(range);

    act(() => {
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    // The browser may still be finalizing the selection this tick.
    expect(result.current.snapshot).toBeNull();

    await act(async () => {
      await flushFrame();
    });
    expect(result.current.snapshot).not.toBeNull();
  });

  it("cancels a pending deferred read when a new gesture starts", async () => {
    const { container, paragraph } = makeContainerWithProse("Quotable text.");
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selectRange(range);

    act(() => {
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      // A fresh press before the frame invalidates the deferred snapshot.
      container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await act(async () => {
      await flushFrame();
    });
    expect(result.current.snapshot).toBeNull();
  });
});

describe("useQuoteSelection - selectionchange dismissal", () => {
  it("dismisses when a live selection MOVES outside the snapshot's root without collapsing", async () => {
    const { container, paragraph } = makeContainerWithProse("Quotable text.");
    const elsewhere = document.createElement("p");
    elsewhere.textContent = "Composer text.";
    document.body.appendChild(elsewhere);
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selectRange(range);
    act(() => {
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await act(async () => {
      await flushFrame();
    });
    expect(result.current.snapshot).not.toBeNull();

    // A selection still inside the root keeps the snapshot.
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.snapshot).not.toBeNull();

    // A non-collapsed selection elsewhere (Ctrl+A in the composer) drops it.
    const other = document.createRange();
    other.selectNodeContents(elsewhere);
    selectRange(other);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.snapshot).toBeNull();
  });
});

describe("useQuoteSelection - re-snapshot on selection extension", () => {
  it("updates the captured text when the highlight is extended after mouseup", async () => {
    const { container, first, second } = makeExtendableFixture();
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const initial = document.createRange();
    initial.selectNodeContents(first);
    selectRange(initial);
    act(() => {
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await act(async () => {
      await flushFrame();
    });
    expect(result.current.snapshot?.text).toBe("First.");

    // Shift+ArrowDown-style extension: no mouseup, only a selectionchange.
    const extended = document.createRange();
    extended.setStart(firstText(first), 0);
    extended.setEnd(firstText(second), "Second.".length);
    selectRange(extended);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.snapshot?.text).toBe("First.Second.");
  });

  it("dismisses when an extension crosses out of the snapshot's root", async () => {
    const { container, first, other } = makeTwoRootFixture();
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const initial = document.createRange();
    initial.selectNodeContents(first);
    selectRange(initial);
    act(() => {
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await act(async () => {
      await flushFrame();
    });
    expect(result.current.snapshot).not.toBeNull();

    const crossing = document.createRange();
    crossing.setStart(firstText(first), 0);
    crossing.setEnd(firstText(other), 3);
    selectRange(crossing);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.snapshot).toBeNull();
  });

  it("keeps the SAME snapshot reference for a no-op selection change", async () => {
    const { container, first } = makeExtendableFixture();
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const range = document.createRange();
    range.selectNodeContents(first);
    selectRange(range);
    act(() => {
      container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await act(async () => {
      await flushFrame();
    });
    const before = result.current.snapshot;
    expect(before).not.toBeNull();

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.snapshot).toBe(before);
  });

  it("never summons the popover from a keyboard selection with no prior mouseup", () => {
    const { container, first } = makeExtendableFixture();
    const ref: { current: HTMLElement | null } = { current: container };
    const { result } = renderHook(() =>
      useQuoteSelection({ containerRef: ref, enabled: true }),
    );

    const range = document.createRange();
    range.selectNodeContents(first);
    selectRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(result.current.snapshot).toBeNull();
  });
});

describe("isSingleUsableSelection", () => {
  it("accepts exactly one non-collapsed range", () => {
    expect(isSingleUsableSelection({ rangeCount: 1, isCollapsed: false })).toBe(
      true,
    );
  });

  it("rejects collapsed, empty, and multi-range selections", () => {
    // jsdom collapses a second addRange, so the multi-range case (Firefox
    // Ctrl-select) is covered through this pure seam rather than a live Selection.
    expect(isSingleUsableSelection({ rangeCount: 1, isCollapsed: true })).toBe(
      false,
    );
    expect(isSingleUsableSelection({ rangeCount: 0, isCollapsed: true })).toBe(
      false,
    );
    expect(isSingleUsableSelection({ rangeCount: 2, isCollapsed: false })).toBe(
      false,
    );
  });
});

function flushFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function selectRange(range: Range): void {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function makeContainerWithProse(text: string): {
  readonly container: HTMLElement;
  readonly paragraph: HTMLElement;
} {
  const container = document.createElement("div");
  const root = document.createElement("div");
  root.setAttribute("data-quotable", "true");
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  root.appendChild(paragraph);
  container.appendChild(root);
  document.body.appendChild(container);
  return { container, paragraph };
}

/** A transcript container holding one quotable root with two paragraphs, so a
 *  selection can be extended from the first into the second. */
function makeExtendableFixture(): {
  readonly container: HTMLElement;
  readonly first: HTMLElement;
  readonly second: HTMLElement;
} {
  const container = document.createElement("div");
  const root = document.createElement("div");
  root.setAttribute("data-quotable", "true");
  const first = document.createElement("p");
  first.textContent = "First.";
  const second = document.createElement("p");
  second.textContent = "Second.";
  root.append(first, second);
  container.appendChild(root);
  document.body.appendChild(container);
  return { container, first, second };
}

/** A container with two SEPARATE quotable roots, so an extension can cross a
 *  root boundary and become invalid. */
function makeTwoRootFixture(): {
  readonly container: HTMLElement;
  readonly first: HTMLElement;
  readonly other: HTMLElement;
} {
  const container = document.createElement("div");
  const rootA = document.createElement("div");
  rootA.setAttribute("data-quotable", "true");
  const first = document.createElement("p");
  first.textContent = "First.";
  rootA.appendChild(first);
  const rootB = document.createElement("div");
  rootB.setAttribute("data-quotable", "true");
  const other = document.createElement("p");
  other.textContent = "Other.";
  rootB.appendChild(other);
  container.append(rootA, rootB);
  document.body.appendChild(container);
  return { container, first, other };
}

function makeChipParagraph(): {
  readonly root: HTMLElement;
  readonly before: Text;
  readonly after: Text;
} {
  const root = document.createElement("div");
  root.setAttribute("data-quotable", "true");
  const paragraph = document.createElement("p");
  const before = document.createTextNode("Before ");
  const chip = document.createElement("button");
  chip.setAttribute("data-quote-exclude", "");
  chip.textContent = "chip";
  const after = document.createTextNode(" after.");
  paragraph.append(before, chip, after);
  root.appendChild(paragraph);
  document.body.appendChild(root);
  return { root, before, after };
}

/** Builds a quotable root with an intro paragraph, one code block, and an outro. */
function makeCodeRoot(language: string): {
  readonly root: HTMLElement;
  readonly codeBlock: HTMLElement;
  readonly code: HTMLElement;
  readonly outro: HTMLElement;
} {
  const root = document.createElement("div");
  root.setAttribute("data-quotable", "true");
  const intro = document.createElement("p");
  intro.textContent = "Intro.";
  const codeBlock = document.createElement("div");
  codeBlock.setAttribute("data-quote-code-block", "");
  codeBlock.setAttribute("data-language", language);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = "const x = 1;";
  pre.appendChild(code);
  codeBlock.appendChild(pre);
  const outro = document.createElement("p");
  outro.textContent = "Outro.";
  root.append(intro, codeBlock, outro);
  document.body.appendChild(root);
  return { root, codeBlock, code, outro };
}

function codeBlockText(codeBlock: HTMLElement): HTMLElement {
  const code = codeBlock.querySelector("code");
  if (!(code instanceof HTMLElement)) throw new Error("missing code element");
  return code;
}
