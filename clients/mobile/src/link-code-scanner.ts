import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";
import type {
  ILinkCodeScanner,
  LinkCodeScanResult,
} from "@traycer-clients/shared/platform/runner-host";

/**
 * The plugin's documented error codes. It rejects for every non-scan outcome
 * and puts the reason in `code`; the message beside it is human-facing prose
 * that is localized and reworded between releases, so matching on it is a
 * guess that silently degrades into "error" the first time the wording moves.
 */
const SCAN_CANCELED_CODE = "OS-PLUG-BARC-0004";
const SCAN_PERMISSION_DENIED_CODE = "OS-PLUG-BARC-0003";

function scanErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code: unknown = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * Which explicit state a plugin rejection means. Reads `code` first and falls
 * back to the message, because the fallback still beats reporting a cancel as
 * a failure - a user who backed out of the camera should not be told anything
 * went wrong.
 */
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

/**
 * Native QR scanner for the link-login sign-in path, backed by the official
 * `@capacitor/barcode-scanner` plugin — chosen over the ML Kit community
 * plugin because this iOS project consumes Capacitor plugins through SPM
 * (`CapApp-SPM/Package.swift`) and the ML Kit one ships CocoaPods-only.
 *
 * Constructed by the entry point only on a native platform; `scanBarcode`
 * owns the whole native interaction — the permission prompt and the
 * fullscreen scan UI — and rejects for every non-scan outcome, so this
 * adapter's job is to translate that single rejection channel into the
 * surface's explicit states.
 */
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
