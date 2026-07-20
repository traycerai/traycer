import { app, shell, systemPreferences } from "electron";
import { log } from "../app/logger";
import { showNativeNotification } from "../notifications";
import { safelyOpenExternal } from "../app/security";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import { assertString, parseSupportLogTarget } from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import type { SupportLogTarget } from "../../ipc-contracts/window-types";

export function registerSupportIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.openExternalLink,
    async (_event, url: unknown) => {
      if (typeof url !== "string") {
        throw new Error("openExternalLink requires a string URL");
      }
      await safelyOpenExternal(url);
    },
  );

  // Reports which of the requested URL schemes have a registered handler on
  // this machine. `getApplicationNameForProtocol` consults the same OS registry
  // (LaunchServices / Windows registry / xdg) that backs `scheme://` launches,
  // so a non-empty handler name means a `scheme://` open would resolve. The
  // query is by scheme only - no app-name or bundle-path matching - so a
  // renamed install still reports as available. Synchronous and side-effect
  // free; it never launches anything.
  bridge.handleInvoke(
    RunnerHostInvoke.getRegisteredUrlSchemes,
    (_event, schemes: unknown): readonly string[] => {
      if (!Array.isArray(schemes)) {
        throw new Error(
          "getRegisteredUrlSchemes requires an array of scheme strings",
        );
      }
      return schemes.filter(
        (scheme): scheme is string =>
          typeof scheme === "string" &&
          scheme.length > 0 &&
          app.getApplicationNameForProtocol(`${scheme}://`).trim().length > 0,
      );
    },
  );

  // Ensures mic access before capture. macOS shows the native prompt only when
  // status is undetermined; a denied app is never re-prompted (the renderer
  // routes to openMicrophoneSettings). Non-macOS lets getUserMedia drive.
  bridge.handleInvoke(
    RunnerHostInvoke.requestMicrophoneAccess,
    async (): Promise<"granted" | "denied"> => {
      if (process.platform !== "darwin") return "granted";
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") return "granted";
      if (status === "denied" || status === "restricted") return "denied";
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return granted ? "granted" : "denied";
    },
  );

  // Opens the OS Privacy → Microphone pane so the user can re-grant access.
  // The URL is hardcoded per-platform (never renderer-supplied), so it bypasses
  // the http-only `safelyOpenExternal` gate intentionally.
  bridge.handleInvoke(RunnerHostInvoke.openMicrophoneSettings, async () => {
    const url =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        : process.platform === "win32"
          ? "ms-settings:privacy-microphone"
          : null;
    if (url === null) {
      log.warn("[support] openMicrophoneSettings unsupported on this platform");
      return;
    }
    await shell.openExternal(url);
  });

  bridge.handleInvoke(
    RunnerHostInvoke.notificationShow,
    async (
      _event,
      title: unknown,
      body: unknown,
      payload: unknown,
      replaceKey: unknown,
      deliveryKey: unknown,
    ) => {
      assertString(title, "notifications.show");
      assertString(body, "notifications.show");
      if (replaceKey !== null && typeof replaceKey !== "string") {
        throw new Error(
          "notifications.show requires a replacement key or null",
        );
      }
      if (deliveryKey !== null && typeof deliveryKey !== "string") {
        throw new Error("notifications.show requires a delivery key or null");
      }
      showNativeNotification({
        title,
        body,
        replaceKey,
        deliveryKey,
        onClick: () => bridge.deliverNotificationClick(payload),
      });
    },
  );

  bridge.handleInvoke(RunnerHostInvoke.supportSnapshotGet, () => {
    return bridge.support.getSnapshot();
  });

  bridge.handleInvoke(
    RunnerHostInvoke.supportRevealLog,
    (_event, target: unknown) => {
      return bridge.support.revealLog(parseSupportLogTarget(target));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportSubmitReport,
    (_event, form: unknown) => {
      if (form === null || typeof form !== "object") {
        throw new Error("supportSubmitReport: form must be an object");
      }
      const f = form as Record<string, unknown>;
      assertString(f["title"], "supportSubmitReport.title");
      assertString(f["whatHappened"], "supportSubmitReport.whatHappened");
      assertString(
        f["stepsToReproduce"],
        "supportSubmitReport.stepsToReproduce",
      );
      assertString(
        f["expectedBehavior"],
        "supportSubmitReport.expectedBehavior",
      );
      assertString(f["actualBehavior"], "supportSubmitReport.actualBehavior");
      return bridge.support.submitReport({
        title: f["title"] as string,
        whatHappened: f["whatHappened"] as string,
        stepsToReproduce: f["stepsToReproduce"] as string,
        expectedBehavior: f["expectedBehavior"] as string,
        actualBehavior: f["actualBehavior"] as string,
      });
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportTailLog,
    (_event, input: unknown) => {
      return bridge.support.tailLog(parseSupportTailLogInput(input));
    },
  );
}

function parseSupportTailLogInput(input: unknown): {
  readonly target: SupportLogTarget;
  readonly tailLines: number;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { target: "desktop", tailLines: 100 };
  }
  const payload = input as Record<string, unknown>;
  const requestedLines = payload.tailLines;
  const tailLines =
    typeof requestedLines === "number" && Number.isFinite(requestedLines)
      ? Math.min(Math.max(Math.trunc(requestedLines), 1), 500)
      : 100;
  return {
    target: parseSupportLogTarget(payload.target),
    tailLines,
  };
}
