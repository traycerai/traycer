import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ZoomLevelField } from "../zoom-controls";

afterEach(cleanup);

function Viewer(props: { readonly onZoomTo: (percent: number) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton>
        <DialogTitle>Viewer</DialogTitle>
        <ZoomLevelField ready scalePercent={150} onZoomTo={props.onZoomTo} />
        <button type="button">Another control</button>
      </DialogContent>
    </Dialog>
  );
}

function field(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Zoom level");
}

describe("zoom edit within a dismissible viewer", () => {
  it("cancels just the edit, retains focus and never commits its later blur; the next Escape dismisses", () => {
    const onZoomTo = vi.fn();
    render(<Viewer onZoomTo={onZoomTo} />);
    field().focus();
    fireEvent.change(field(), { target: { value: "200" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(field().value).toBe("150%");
    expect(document.activeElement).toBe(field());
    fireEvent.blur(field());
    expect(onZoomTo).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves composition Enter and Escape to the IME without dismissing or changing the draft", () => {
    const onZoomTo = vi.fn();
    render(<Viewer onZoomTo={onZoomTo} />);
    fireEvent.change(field(), { target: { value: "175" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(field(), escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(field().value).toBe("175");
    expect(onZoomTo).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onZoomTo).toHaveBeenCalledExactlyOnceWith(175);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not intercept Escape from another control while the field still has a draft", () => {
    render(<Viewer onZoomTo={vi.fn()} />);
    fireEvent.change(field(), { target: { value: "200" } });
    fireEvent.keyDown(screen.getByRole("button", { name: "Another control" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not keep a cancelled field's draft when the live percentage changes", () => {
    const onZoomTo = vi.fn();
    const { rerender } = render(
      <ZoomLevelField ready scalePercent={100} onZoomTo={onZoomTo} />,
    );
    fireEvent.change(field(), { target: { value: "175" } });
    rerender(<ZoomLevelField ready scalePercent={120} onZoomTo={onZoomTo} />);
    expect(field().value).toBe("175");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("120%");
    fireEvent.blur(field());
    expect(onZoomTo).not.toHaveBeenCalled();
  });
});
