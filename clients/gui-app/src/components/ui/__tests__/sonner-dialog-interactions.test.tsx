import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { listBrowserOverlayElements } from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import {
  progressSuccessToast,
  progressToast,
} from "@/lib/toast/progress-toast";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

async function waitForDismissableLayerListener(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("<Toaster /> dialog interactions", () => {
  afterEach(() => {
    toast.dismiss();
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not dismiss an open dialog when a toast close button is clicked", async () => {
    const onOpenChange = vi.fn();

    render(
      <>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
          </DialogContent>
        </Dialog>
        <Toaster />
      </>,
    );

    await waitForDismissableLayerListener();

    act(() => {
      toast.info("Settings saved");
    });

    const closeToastButton = await screen.findByRole("button", {
      name: "Close toast",
    });

    fireEvent.pointerDown(closeToastButton, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(closeToastButton);

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("registers sonner's inner toast list once a toast exists", async () => {
    // The outer <section> Sonner renders is a static, zero-height wrapper;
    // the fixed, painted surface is the inner `<ol data-sonner-toaster>`,
    // mounted only once a toast exists for its position (sonner 2.0.8). This
    // pins the REAL wiring end to end - a live `<Toaster/>`'s `<ol>` gets
    // registered on mount and deregistered once its toasts are gone.
    render(<Toaster />);

    expect(listBrowserOverlayElements().some(isSonnerToasterList)).toBe(false);

    act(() => {
      toast.info("Registered toast");
    });
    await screen.findByText("Registered toast");

    await waitFor(() => {
      expect(listBrowserOverlayElements().some(isSonnerToasterList)).toBe(true);
    });

    act(() => {
      toast.dismiss();
    });
    await waitFor(() => {
      expect(screen.queryByText("Registered toast")).toBeNull();
    });

    await waitFor(() => {
      expect(listBrowserOverlayElements().some(isSonnerToasterList)).toBe(
        false,
      );
    });
  });

  it("renders progress with the shared close button", async () => {
    render(<Toaster />);

    act(() => {
      progressToast("Deleting worktrees", {
        description: "16/17 deleted",
        duration: Infinity,
      });
    });

    const closeToastButton = await screen.findByRole("button", {
      name: "Close toast",
    });

    fireEvent.click(closeToastButton);

    await waitFor(() => {
      expect(screen.queryByText("Deleting worktrees")).toBeNull();
    });
  });

  it("uses a four-second duration for completed progress", () => {
    const success = vi.spyOn(toast, "success").mockReturnValue("success");

    progressSuccessToast("Deleted 13 worktrees", {
      id: "worktree-delete-progress",
      cancel: null,
    });

    expect(success).toHaveBeenCalledWith("Deleted 13 worktrees", {
      id: "worktree-delete-progress",
      cancel: null,
      duration: 4000,
      icon: undefined,
    });
  });

  it("auto-dismisses a success that replaces persistent progress", async () => {
    render(<Toaster />);

    act(() => {
      progressToast("Deleting worktrees", {
        id: "worktree-delete-progress",
        description: "12/13 deleted",
        duration: Infinity,
        cancel: null,
      });
    });

    act(() => {
      progressSuccessToast("Deleted 13 worktrees", {
        id: "worktree-delete-progress",
        description: "13/13 deleted",
        duration: 20,
        cancel: null,
      });
    });

    await screen.findByText("Deleted 13 worktrees");
    expect(
      document.querySelector("[data-icon] span[aria-hidden='true']"),
    ).toBeNull();
    expect(
      document.querySelector("[data-icon] .lucide-circle-check"),
    ).not.toBeNull();

    await waitFor(
      () => {
        expect(screen.queryByText("Deleted 13 worktrees")).toBeNull();
      },
      { timeout: 500 },
    );
  });
});

function isSonnerToasterList(element: HTMLElement): boolean {
  return (
    element.tagName === "OL" && element.hasAttribute("data-sonner-toaster")
  );
}
