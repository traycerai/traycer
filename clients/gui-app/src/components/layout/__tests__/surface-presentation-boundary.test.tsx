import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SurfacePresentationBoundary } from "@/components/layout/surface-presentation-boundary";
import {
  isPresentationLossBlur,
  usePaneCloseAutoFocusGuard,
  usePanePortalContainer,
} from "@/components/epic-tabs/pane-visibility-context";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

afterEach(() => cleanup());

function inputByTestId(testId: string): HTMLInputElement {
  const el = screen.getByTestId(testId);
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`${testId} is not an input`);
  }
  return el;
}

function portalHostFor(testId: string): HTMLElement {
  const el = screen
    .getByTestId(testId)
    .closest("[data-slot='pane-portal-host']");
  if (!(el instanceof HTMLElement)) {
    throw new Error(`${testId} is not inside a pane portal host`);
  }
  return el;
}

function Pane(props: {
  readonly focused: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SurfacePresentationBoundary visible focused={props.focused}>
      {props.children}
    </SurfacePresentationBoundary>
  );
}

function AllPrimitives(props: { readonly suffix: string }) {
  return (
    <>
      <Dialog open>
        <DialogContent>
          <div data-testid={`dialog-${props.suffix}`} />
        </DialogContent>
      </Dialog>
      <Popover open>
        <PopoverTrigger>a</PopoverTrigger>
        <PopoverContent>
          <div data-testid={`popover-${props.suffix}`} />
        </PopoverContent>
      </Popover>
      <DropdownMenu open>
        <DropdownMenuTrigger>a</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            <span data-testid={`dropdown-${props.suffix}`} />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Select open>
        <SelectTrigger>a</SelectTrigger>
        <SelectContent>
          <SelectItem value="x">
            <span data-testid={`select-${props.suffix}`} />
          </SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}

describe("surface presentation boundary — generic portal suppression", () => {
  it("suppresses every Radix portal primitive in an unfocused (non-Epic) pane while presenting them in a focused pane", () => {
    render(
      <>
        <Pane focused>
          <AllPrimitives suffix="focused" />
        </Pane>
        <Pane focused={false}>
          <AllPrimitives suffix="unfocused" />
        </Pane>
      </>,
    );

    for (const primitive of ["dialog", "popover", "dropdown", "select"]) {
      expect(
        screen.queryByTestId(`${primitive}-focused`),
        `${primitive} should present in the focused pane`,
      ).not.toBeNull();
      expect(
        screen.queryByTestId(`${primitive}-unfocused`),
        `${primitive} should be suppressed in the unfocused pane`,
      ).toBeNull();
    }
  });

  it("suppresses a real context menu opened in an unfocused pane while presenting it in a focused pane", () => {
    function ContextPane(props: {
      readonly focused: boolean;
      readonly suffix: string;
    }) {
      return (
        <Pane focused={props.focused}>
          <ContextMenu>
            <ContextMenuTrigger data-testid={`ctx-trigger-${props.suffix}`}>
              target
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem>
                <span data-testid={`context-${props.suffix}`} />
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </Pane>
      );
    }
    render(
      <>
        <ContextPane focused suffix="focused" />
        <ContextPane focused={false} suffix="unfocused" />
      </>,
    );
    fireEvent.contextMenu(screen.getByTestId("ctx-trigger-focused"));
    fireEvent.contextMenu(screen.getByTestId("ctx-trigger-unfocused"));

    expect(screen.queryByTestId("context-focused")).not.toBeNull();
    expect(screen.queryByTestId("context-unfocused")).toBeNull();
  });
});

function ManualPortal(props: { readonly testId: string }) {
  const container = usePanePortalContainer();
  const [value, setValue] = useState("draft");
  return createPortal(
    <input
      data-testid={props.testId}
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />,
    container ?? document.body,
  );
}

describe("surface presentation boundary — kept-mounted manual portals", () => {
  it("routes a manual portal into the pane container, and when unfocused hides it + makes it inert + blurs it + relinquishes keyboard — without unmounting (state survives)", () => {
    const { rerender } = render(
      <SurfacePresentationBoundary visible focused>
        <ManualPortal testId="manual" />
      </SurfacePresentationBoundary>,
    );

    // Lands inside the pane's portal host, not document.body directly.
    expect(portalHostFor("manual")).not.toBeNull();
    fireEvent.change(inputByTestId("manual"), {
      target: { value: "user typed" },
    });
    act(() => {
      inputByTestId("manual").focus();
    });
    expect(document.activeElement).toBe(inputByTestId("manual"));

    // Unfocus: hidden + inert, the active descendant is blurred (so keyboard no
    // longer targets it), but the portal stays MOUNTED (typed state survives).
    act(() => {
      rerender(
        <SurfacePresentationBoundary visible focused={false}>
          <ManualPortal testId="manual" />
        </SurfacePresentationBoundary>,
      );
    });
    expect(portalHostFor("manual").style.visibility).toBe("hidden");
    expect(portalHostFor("manual").hasAttribute("inert")).toBe(true);
    expect(portalHostFor("manual").getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).not.toBe(inputByTestId("manual"));
    expect(inputByTestId("manual").value).toBe("user typed");

    // Refocus: the container is shown again, not inert, and state is intact.
    act(() => {
      rerender(
        <SurfacePresentationBoundary visible focused>
          <ManualPortal testId="manual" />
        </SurfacePresentationBoundary>,
      );
    });
    expect(portalHostFor("manual").style.visibility).toBe("");
    expect(portalHostFor("manual").hasAttribute("inert")).toBe(false);
    expect(inputByTestId("manual").value).toBe("user typed");
  });
});

function CommitOnBlurPortal(props: {
  readonly testId: string;
  readonly onBlur: (presentationLoss: boolean) => void;
}) {
  const container = usePanePortalContainer();
  return createPortal(
    <input
      data-testid={props.testId}
      onBlur={() => props.onBlur(isPresentationLossBlur())}
    />,
    container ?? document.body,
  );
}

describe("surface presentation boundary — presentation-loss blur signal (HIGH2)", () => {
  it("raises isPresentationLossBlur() while it force-blurs a backgrounded portal descendant, then clears it — so a blur-as-commit consumer can skip its side effect", () => {
    const seen: boolean[] = [];
    const { rerender } = render(
      <SurfacePresentationBoundary visible focused>
        <CommitOnBlurPortal testId="commit" onBlur={(v) => seen.push(v)} />
      </SurfacePresentationBoundary>,
    );
    act(() => {
      inputByTestId("commit").focus();
    });
    expect(document.activeElement).toBe(inputByTestId("commit"));

    act(() => {
      rerender(
        <SurfacePresentationBoundary visible focused={false}>
          <CommitOnBlurPortal testId="commit" onBlur={(v) => seen.push(v)} />
        </SurfacePresentationBoundary>,
      );
    });

    // The forced relinquish-blur fired exactly once, and the flag was up while
    // the consumer's onBlur ran (letting it tell this from a real user blur).
    expect(seen).toEqual([true]);
    // The flag is scoped to the synchronous blur and is cleared afterwards.
    expect(isPresentationLossBlur()).toBe(false);
  });
});

function CloseGuardButton(props: {
  readonly caller: (event: Event) => void;
  readonly event: Event;
}) {
  const guard = usePaneCloseAutoFocusGuard(props.caller);
  return (
    <button
      type="button"
      data-testid="fire-guard"
      onClick={() => guard(props.event)}
    />
  );
}

describe("surface presentation boundary — close-autofocus guard (HIGH1)", () => {
  // The guard reads the boundary's live `data-pane-focused` (via the focus probe)
  // at close-autofocus time and preventDefaults Radix's restore only while the
  // pane is unfocused. Killing the restore at the source is what stops the
  // background pane from being reactivated. The full end-to-end bounce is proven
  // in a REAL browser (jsdom neither fires Radix's onUnmountAutoFocus on an
  // external unmount nor models Chrome's trusted `.focus()`); this covers the
  // guard's contract against the real boundary + probe.
  it("preventDefaults the restore for an unfocused pane, and passes it through for a focused pane", () => {
    const caller = vi.fn();
    const blocked = new Event("radix", { cancelable: true });
    render(
      <SurfacePresentationBoundary visible focused={false}>
        <CloseGuardButton caller={caller} event={blocked} />
      </SurfacePresentationBoundary>,
    );
    fireEvent.click(screen.getByTestId("fire-guard"));
    expect(blocked.defaultPrevented).toBe(true);
    expect(caller).not.toHaveBeenCalled();

    cleanup();
    const passed = new Event("radix", { cancelable: true });
    render(
      <SurfacePresentationBoundary visible focused>
        <CloseGuardButton caller={caller} event={passed} />
      </SurfacePresentationBoundary>,
    );
    fireEvent.click(screen.getByTestId("fire-guard"));
    expect(passed.defaultPrevented).toBe(false);
    expect(caller).toHaveBeenCalledWith(passed);
  });
});
