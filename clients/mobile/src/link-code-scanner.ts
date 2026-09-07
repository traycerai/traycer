import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import type {
  ILinkCodeScanner,
  LinkCodeScanResult,
} from "@traycer-clients/shared/platform/runner-host";

const SCAN_CANCELED_CODE = "OS-PLUG-BARC-0004";
const SCAN_PERMISSION_DENIED_CODE = "OS-PLUG-BARC-0003";

function scanErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

function classifyScanRejection(error: unknown): LinkCodeScanResult {
  const code = scanErrorCode(error);
  if (code === SCAN_CANCELED_CODE) {
    return { kind: "canceled" };
  }
  if (code === SCAN_PERMISSION_DENIED_CODE) {
    return { kind: "permission-denied" };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("cancel")) {
    return { kind: "canceled" };
  }
  if (message.includes("permission") || message.includes("denied")) {
    return { kind: "permission-denied" };
  }
  return { kind: "error" };
}

export class MobileLinkCodeScanner implements ILinkCodeScanner {
  async scan(): Promise<LinkCodeScanResult> {
    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: "Point the camera at the QR on your desktop",
      });
      const text = result.ScanResult;
      if (typeof text !== "string" || text.length === 0) {
        return { kind: "canceled" };
      }
      return { kind: "scanned", text };
    } catch (error) {
      return classifyScanRejection(error);
    }
  }
}
