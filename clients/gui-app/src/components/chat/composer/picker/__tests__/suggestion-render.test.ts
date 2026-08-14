import { afterEach, describe, expect, it } from "vitest";

import {
  createComposerPickerStore,
  type ComposerPickerCommit,
  type ComposerPickerItem,
} from "../composer-picker-store";
import { createComposerSuggestionRender } from "../suggestion-render";

const NOOP_COMMIT: ComposerPickerCommit = () => undefined;

/**
 * Minimal harness for `onKeyDown` alone: it reads only the picker store (via
 * closure) and the real DOM, never `latestProps`, so opening the store
 * directly - the same way `composer-picker-store.test.ts` drives it - is
 * enough. No suite anywhere calls `createComposerSuggestionRender` yet; this
 * is the first, scoped to the Shift+Tab chrome handoff the production change
 * added. Return type left to inference: `SuggestionRender` is not exported
 * from `suggestion-render.ts`, and this is a test-only helper, not a public
 * boundary.
 */
function openedMentionRender() {
  const pickerStore = createComposerPickerStore();
  const render = createComposerSuggestionRender<ComposerPickerItem>({
    pickerStore,
    kind: "mention",
    slashTrigger: null,
    slashScopeForProps: null,
    suggestionPluginKey: null,
  })();
  pickerStore.getState().openPicker({
    sessionId: 1,
    kind: "mention",
    slashScope: null,
    slashTrigger: null,
    range: { from: 1, to: 2 },
    query: "",
    commit: NOOP_COMMIT,
    dismiss: null,
    focusEditor: null,
    clientRect: null,
  });
  return render;
}

function shiftTabEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey: true });
}

/**
 * Shift+Tab is the keyboard route to the picker's own chrome (Filter/Refresh),
 * which renders through a portal into `document.body` after the editor - no
 * native traversal direction can reach it from the composer. Under jsdom this
 * handler was once measured as never receiving Shift+Tab at all, so these
 * tests invoke the handler directly rather than trusting a simulated keydown
 * to reach it (see the comment on the `Tab` branch in `suggestion-render.ts`).
 */
describe("createComposerSuggestionRender onKeyDown - Shift+Tab chrome handoff", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("moves focus into the step chrome and reports the key as consumed", () => {
    const chrome = document.createElement("div");
    chrome.setAttribute("data-mention-step-chrome", "");
    const button = document.createElement("button");
    button.textContent = "Filter";
    chrome.appendChild(button);
    document.body.appendChild(chrome);

    const render = openedMentionRender();
    const consumed = render.onKeyDown({ event: shiftTabEvent() });

    expect(consumed).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("falls through to the browser default when the step publishes no chrome", () => {
    // The control: no `[data-mention-step-chrome]` node anywhere in the
    // document, so there is nothing to focus and the key must not be
    // swallowed.
    const render = openedMentionRender();
    const consumed = render.onKeyDown({ event: shiftTabEvent() });

    expect(consumed).toBe(false);
    expect(document.activeElement).not.toBeNull();
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });
});
