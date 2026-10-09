import { afterEach, describe, expect, it } from "vitest";
import { installEditFirewall } from "@/components/layout-editor/canvas/edit-firewall";

/**
 * The firewall is asserted through the app's OWN handlers (4.4): a listener on
 * a control inside the column, exactly where the composer's `onDrop` and the
 * header's `onClick` live. Asserting that `preventDefault` was called would
 * restate the implementation; asserting that the app never heard the gesture
 * is the outcome the rule exists for.
 */

/**
 * Named rather than read from the module's own list: a test that iterates the
 * same array cannot notice a gesture leaving it. The drag-and-drop and paste
 * five are here because the composer carries real handlers for all of them
 * (C-16).
 */
const SWALLOWED_EVENT_TYPES = [
  "click",
  "dblclick",
  "auxclick",
  "pointerdown",
  "keydown",
  "keypress",
  "submit",
  "dragstart",
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
  "paste",
];

let teardown: (() => void) | null = null;

interface Column {
  readonly column: HTMLElement;
  readonly control: HTMLButtonElement;
  readonly inspector: HTMLElement;
  readonly heard: Array<string>;
}

function mountColumn(): Column {
  const column = document.createElement("div");
  const control = document.createElement("button");
  const inspector = document.createElement("div");
  inspector.tabIndex = -1;
  column.append(control);
  document.body.append(column, inspector);

  const heard: Array<string> = [];
  // `contextmenu` is no longer on the swallowed list (L-129) but is still a
  // gesture this suite listens for, because whether the app hears it is now
  // the question rather than a given.
  for (const type of [...SWALLOWED_EVENT_TYPES, "contextmenu", "wheel"]) {
    control.addEventListener(type, () => {
      heard.push(type);
    });
    column.addEventListener(type, () => {
      heard.push(`column:${type}`);
    });
  }
  teardown = installEditFirewall({
    column,
    focusTarget: () => inspector,
  });
  return { column, control, inspector, heard };
}

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.replaceChildren();
});

describe("the edit firewall (4.4)", () => {
  it("swallows every listed gesture before the app hears it", () => {
    const { control, heard } = mountColumn();

    for (const type of SWALLOWED_EVENT_TYPES) {
      control.dispatchEvent(
        new Event(type, { bubbles: true, cancelable: true }),
      );
    }

    expect(heard).toEqual([]);
  });

  /**
   * L-129. `contextmenu` used to be on the swallowed list, which made quick
   * verbs - the mode-less half of the model (L-19) - unreachable from inside a
   * session: the menu's own trigger never saw the event. The rule is now a
   * named region WITH a mounted menu, so these three are the halves of it.
   */
  it("lets a right-click on a named region reach its menu (L-129)", () => {
    const { control, heard } = mountColumn();
    control.setAttribute("data-layout-region", "mic");
    // What `ContextMenuTrigger asChild` stamps on the element it takes over -
    // here the composer cluster's own box, which is the region's ancestor.
    control.setAttribute("data-slot", "context-menu-trigger");
    // The deepest node under the pointer is usually the control's own glyph,
    // not the named element itself, so the test is `closest` rather than the
    // target's own attribute - and the menu's trigger is an ancestor besides.
    const glyph = document.createElement("span");
    control.append(glyph);

    glyph.dispatchEvent(
      new Event("contextmenu", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual(["contextmenu", "column:contextmenu"]);
  });

  it("still swallows a right-click on a region with no menu to open", () => {
    // A named region whose menu host is not there: unmounted, not mounted
    // yet, or a region a call site never gave one. Naming a region is not on
    // its own a reason to let the event by - with no trigger above it the
    // press reaches nothing in the app and goes on to Electron's own menu
    // over sample content, which is the class of thing the firewall exists to
    // prevent. (L-144 has since put a trigger over every region a user can
    // point at, so this branch guards the gap rather than a standing set of
    // surfaces.)
    const { control, heard } = mountColumn();
    control.setAttribute("data-layout-region", "changedFiles");

    control.dispatchEvent(
      new Event("contextmenu", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual([]);
  });

  it("still swallows a right-click on a menu that is not about a region", () => {
    // The app's own context menu over the user's own content is the app
    // acting, trigger or no trigger.
    const { control, heard } = mountColumn();
    control.setAttribute("data-slot", "context-menu-trigger");

    control.dispatchEvent(
      new Event("contextmenu", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual([]);
  });

  it("still swallows a right-click that is not on a region", () => {
    // A chat message, a transcript, a text field: the app's own menu over the
    // user's own content, which is what the firewall is for.
    const { control, heard } = mountColumn();

    control.dispatchEvent(
      new Event("contextmenu", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual([]);
  });

  /**
   * Audit F1. The Customizing tab is the session's own tab, not the app
   * acting: activating it is a no-op and its close is a way out of the
   * editor, so pointer gestures on it must reach the tab strip rather than
   * being swallowed like every other press on the column.
   */
  it("lets a pointer press on the Customizing tab through, but still swallows a keydown on it", () => {
    const { control, heard } = mountColumn();
    control.setAttribute("data-tab-kind", "sample-workspace");

    control.dispatchEvent(
      new Event("click", { bubbles: true, cancelable: true }),
    );
    expect(heard).toEqual(["click", "column:click"]);

    heard.length = 0;
    control.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    expect(heard).toEqual(["pointerdown", "column:pointerdown"]);

    heard.length = 0;
    control.dispatchEvent(
      new Event("keydown", { bubbles: true, cancelable: true }),
    );
    expect(heard).toEqual([]);
  });

  it("lets the wheel through, so the app keeps scrolling (L-17)", () => {
    const { control, heard } = mountColumn();

    control.dispatchEvent(
      new Event("wheel", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual(["wheel", "column:wheel"]);
  });

  it("returns focus to the inspector when the column takes it", () => {
    const { control, inspector } = mountColumn();

    control.focus();
    control.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(document.activeElement).toBe(inspector);
  });

  it("bounces focus that was already inside the column when it installed", () => {
    const column = document.createElement("div");
    const control = document.createElement("button");
    const inspector = document.createElement("div");
    inspector.tabIndex = -1;
    column.append(control);
    document.body.append(column, inspector);
    control.focus();
    expect(document.activeElement).toBe(control);

    teardown = installEditFirewall({ column, focusTarget: () => inspector });

    expect(document.activeElement).toBe(inspector);
  });

  it("hides the column from assistive technology only while it is installed", () => {
    const { column } = mountColumn();
    expect(column.getAttribute("aria-hidden")).toBe("true");

    teardown?.();
    teardown = null;

    expect(column.hasAttribute("aria-hidden")).toBe(false);
  });

  it("leaves a sibling inspector's own gestures alone", () => {
    const { inspector, heard } = mountColumn();
    const button = document.createElement("button");
    button.addEventListener("click", () => {
      heard.push("inspector:click");
    });
    inspector.append(button);

    button.dispatchEvent(
      new Event("click", { bubbles: true, cancelable: true }),
    );

    expect(heard).toEqual(["inspector:click"]);
  });
});
