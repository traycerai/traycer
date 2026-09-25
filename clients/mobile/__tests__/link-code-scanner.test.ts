/**
 * The link-login QR scanner's translation of the plugin's single rejection
 * channel into explicit states. The plugin is imported when a scan starts, so
 * these cases also pin that the use-time import reaches the mocked plugin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileLinkCodeScanner } from "../src/link-code-scanner";

const nativeMocks = vi.hoisted(() => ({
  scanBarcode: vi.fn(),
}));

vi.mock("@capacitor/barcode-scanner", () => ({
  CapacitorBarcodeScanner: { scanBarcode: nativeMocks.scanBarcode },
  CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 },
}));

describe("MobileLinkCodeScanner", () => {
  beforeEach(() => {
    nativeMocks.scanBarcode.mockReset();
  });

  it("returns the scanned text, asking the plugin for a QR code", async () => {
    nativeMocks.scanBarcode.mockResolvedValue({ ScanResult: "traycer://x" });

    await expect(new MobileLinkCodeScanner().scan()).resolves.toEqual({
      kind: "scanned",
      text: "traycer://x",
    });
    expect(nativeMocks.scanBarcode).toHaveBeenCalledWith(
      expect.objectContaining({ hint: 0 }),
    );
  });

  it("reads an empty result as a cancel", async () => {
    nativeMocks.scanBarcode.mockResolvedValue({ ScanResult: "" });

    await expect(new MobileLinkCodeScanner().scan()).resolves.toEqual({
      kind: "canceled",
    });
  });

  it("classifies the plugin's documented rejection codes", async () => {
    nativeMocks.scanBarcode.mockRejectedValueOnce({
      code: "OS-PLUG-BARC-0004",
    });
    nativeMocks.scanBarcode.mockRejectedValueOnce({
      code: "OS-PLUG-BARC-0003",
    });
    nativeMocks.scanBarcode.mockRejectedValueOnce(new Error("camera failed"));
    const scanner = new MobileLinkCodeScanner();

    await expect(scanner.scan()).resolves.toEqual({ kind: "canceled" });
    await expect(scanner.scan()).resolves.toEqual({
      kind: "permission-denied",
    });
    await expect(scanner.scan()).resolves.toEqual({ kind: "error" });
  });
});
