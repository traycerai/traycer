/**
 * The export controls both usage surfaces render. What is asserted here is the
 * part that is the same wherever they are mounted: which buttons exist for a
 * given set of shell capabilities, what they are called, and how one running
 * export gates all of them.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsageExportImageActions } from "@/components/usage-analytics/usage-export-image-actions";
import type { UsageImageExportAction } from "@/hooks/usage-analytics/use-usage-image-export";

afterEach(cleanup);

interface Overrides {
  readonly exportReady: boolean;
  readonly pendingAction: UsageImageExportAction | null;
  readonly copyImage: (() => void) | null;
  readonly shareImage: (() => void) | null;
  readonly downloadImage: () => void;
  readonly variant: "icon" | "labelled";
}

/** The shell shape where `saveFile` IS the download: desktop, browser tab. */
function ownDownloadShell(): Pick<Overrides, "copyImage" | "shareImage"> {
  return { copyImage: () => undefined, shareImage: null };
}

/** The shell shape where `saveFile` reaches an OS chooser: the mobile app. */
function shareSheetShell(): Pick<Overrides, "copyImage" | "shareImage"> {
  return { copyImage: null, shareImage: () => undefined };
}

function renderActions(overrides: Overrides): void {
  render(
    <TooltipProvider>
      <UsageExportImageActions
        exportReady={overrides.exportReady}
        pendingAction={overrides.pendingAction}
        copyImage={overrides.copyImage}
        shareImage={overrides.shareImage}
        downloadImage={overrides.downloadImage}
        testIdPrefix="usage"
        variant={overrides.variant}
        buttonClassName={undefined}
      />
    </TooltipProvider>,
  );
}

/** Every export button on screen, in render order. */
function buttonTestIds(): readonly string[] {
  return screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("data-testid") ?? "");
}

describe("<UsageExportImageActions />", () => {
  it("renders copy then download where the shell has no share surface", () => {
    renderActions({
      exportReady: true,
      pendingAction: null,
      ...ownDownloadShell(),
      downloadImage: () => undefined,
      variant: "icon",
    });

    expect(buttonTestIds()).toEqual([
      "usage-copy-image",
      "usage-download-image",
    ]);
  });

  it("renders share then download where the shell's save route is a chooser", () => {
    renderActions({
      exportReady: true,
      pendingAction: null,
      ...shareSheetShell(),
      downloadImage: () => undefined,
      variant: "icon",
    });

    expect(buttonTestIds()).toEqual([
      "usage-share-image",
      "usage-download-image",
    ]);
  });

  it("names an icon-only button for assistive tech", () => {
    renderActions({
      exportReady: true,
      pendingAction: null,
      ...shareSheetShell(),
      downloadImage: () => undefined,
      variant: "icon",
    });

    // The icon variant carries no visible text at all, so the accessible name
    // is the ONLY name these buttons have.
    expect(screen.getByLabelText("Share usage image")).toBeTruthy();
    expect(screen.getByLabelText("Download usage image")).toBeTruthy();
  });

  it("labels the buttons in the labelled variant instead", () => {
    renderActions({
      exportReady: true,
      pendingAction: null,
      ...shareSheetShell(),
      downloadImage: () => undefined,
      variant: "labelled",
    });

    expect(screen.getByTestId("usage-share-image").textContent).toContain(
      "Share image",
    );
    expect(screen.getByTestId("usage-download-image").textContent).toContain(
      "Download image",
    );
  });

  it("disables every control while any export runs", () => {
    renderActions({
      exportReady: true,
      pendingAction: "share",
      ...shareSheetShell(),
      downloadImage: () => undefined,
      variant: "labelled",
    });

    // A capture is an expensive full-region rasterisation, so a second one
    // must not start while the first is in flight - whichever control it was.
    for (const button of screen.getAllByRole("button")) {
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
    }
  });

  it("disables every control until the surface has something truthful to capture", () => {
    renderActions({
      exportReady: false,
      pendingAction: null,
      ...ownDownloadShell(),
      downloadImage: () => undefined,
      variant: "icon",
    });

    for (const button of screen.getAllByRole("button")) {
      expect(button instanceof HTMLButtonElement && button.disabled).toBe(true);
    }
  });

  it("spins only the control that started the export", () => {
    renderActions({
      exportReady: true,
      pendingAction: "download",
      ...shareSheetShell(),
      downloadImage: () => undefined,
      variant: "labelled",
    });

    const download = screen.getByTestId("usage-download-image");
    const share = screen.getByTestId("usage-share-image");
    // The spinner replaces the glyph, so the pending button loses its icon and
    // the other one keeps it.
    expect(download.querySelector("svg")).toBeNull();
    expect(share.querySelector("svg")).not.toBeNull();
  });

  it("runs the handler belonging to the control that was pressed", async () => {
    const user = userEvent.setup();
    const shareImage = vi.fn();
    const downloadImage = vi.fn();
    render(
      <TooltipProvider>
        <UsageExportImageActions
          exportReady
          pendingAction={null}
          copyImage={null}
          shareImage={shareImage}
          downloadImage={downloadImage}
          testIdPrefix="usage"
          variant="labelled"
          buttonClassName={undefined}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByTestId("usage-share-image"));
    expect(shareImage).toHaveBeenCalledTimes(1);
    expect(downloadImage).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("usage-download-image"));
    expect(downloadImage).toHaveBeenCalledTimes(1);
    expect(shareImage).toHaveBeenCalledTimes(1);
  });
});
