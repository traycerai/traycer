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
import { progressToast } from "@/lib/toast/progress-toast";

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
});
