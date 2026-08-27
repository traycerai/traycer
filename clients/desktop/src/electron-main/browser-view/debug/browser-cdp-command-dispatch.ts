import type {
  BrowserCdpCommand,
  BrowserCdpResult,
} from "@traycer/protocol/host/browser/contracts";
import { dispatchCuratedCdp } from "@traycer/protocol/host/browser/cdp-dispatch";
import type { BrowserViewDebugger } from "../browser-view-port";

/**
 * Maps the renderer's curated command vocabulary onto validated CDP calls.
 * The table is `@traycer/protocol`'s `dispatchCuratedCdp`, shared with the
 * host's Playwright dispatcher; this binds it to the attached debugger and
 * the child session the command is addressed to.
 */
export async function dispatchBrowserCdpCommand(
  browserDebugger: BrowserViewDebugger,
  sessionId: string | undefined,
  command: BrowserCdpCommand,
): Promise<BrowserCdpResult> {
  return await dispatchCuratedCdp(
    (method, params) => browserDebugger.sendCommand(method, params, sessionId),
    command,
  );
}
