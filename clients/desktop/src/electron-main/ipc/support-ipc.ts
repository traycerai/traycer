import { app, shell, systemPreferences } from "electron";
import { log } from "../app/logger";
import { showNativeNotification } from "../notifications";
import { safelyOpenExternal } from "../app/security";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  assertNumber,
  assertString,
  parseSupportLogTarget,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import type {
  SupportLogTarget,
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
  SupportPrivateDiagnosticsSession,
  SupportReadFrozenLogTailInput,
  SupportSubmitReportRequest,
} from "../../ipc-contracts/window-types";

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
      return bridge.support.submitReport(parseSupportSubmitReportRequest(form));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportTailLog,
    (_event, input: unknown) => {
      return bridge.support.tailLog(parseSupportTailLogInput(input));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportFreezeEvidence,
    (_event, draftId: unknown) => {
      assertNumber(draftId, "supportFreezeEvidence.draftId");
      return bridge.support.freezeEvidence(draftId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportDiscardFrozenEvidence,
    (_event, draftId: unknown) => {
      assertNumber(draftId, "supportDiscardFrozenEvidence.draftId");
      bridge.support.discardFrozenEvidence(draftId);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportReadFrozenLogTail,
    (_event, input: unknown) => {
      return bridge.support.readFrozenLogTail(
        parseSupportReadFrozenLogTailInput(input),
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportSaveDiagnosticBundle,
    (_event, form: unknown) => {
      return bridge.support.saveDiagnosticBundle(
        parseSupportSubmitReportRequest(form),
      );
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

const SUPPORT_SUBMIT_REPORT_KEYS = new Set([
  "draftId",
  "title",
  "whatHappened",
  "stepsToReproduce",
  "expectedBehavior",
  "actualBehavior",
  "privateDiagnostics",
  "fingerprint",
  "correlationId",
]);

const PRIVATE_DIAGNOSTICS_KEYS = new Set(["cause", "session"]);

const PRIVATE_DIAGNOSTICS_CAUSE_KEYS = new Set([
  "type",
  "message",
  "stack",
  "componentStack",
  "errorCode",
  "sourceAction",
  "timestamp",
]);

const PRIVATE_DIAGNOSTICS_SESSION_KEYS = new Set([
  "routeTemplate",
  "hostId",
  "epicId",
  "tabId",
  "artifactId",
  "chatId",
  "agentId",
  "harness",
  "model",
  "profileId",
  "profileMode",
  "providerVersion",
  "providerClass",
]);

// Renderer and main ship from the same build in this Electron app (no
// independent client/server versioning), so rejecting unknown fields outright
// carries no forward-compat risk - and is the point: an allowlisted field
// must never become a smuggling path for an untyped object.
function assertOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${context} contains a disallowed field: ${key}`);
    }
  }
}

function assertPlainObject(
  value: unknown,
  context: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
}

function parseNullableString(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null;
  assertString(value, context);
  return value;
}

function parseOptionalString(
  value: unknown,
  context: string,
): string | undefined {
  if (value === undefined) return undefined;
  assertString(value, context);
  return value;
}

function parsePrivateDiagnosticsProviderClass(
  value: unknown,
): "bundled" | "custom" | null {
  if (value === null || value === undefined) return null;
  if (value === "bundled" || value === "custom") return value;
  throw new Error(
    'supportSubmitReport.privateDiagnostics.session.providerClass must be "bundled", "custom", or null',
  );
}

function parsePrivateDiagnosticsCause(
  value: unknown,
): SupportPrivateDiagnosticsCause | null {
  if (value === null || value === undefined) return null;
  const context = "supportSubmitReport.privateDiagnostics.cause";
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, PRIVATE_DIAGNOSTICS_CAUSE_KEYS, context);
  assertString(value.type, `${context}.type`);
  assertString(value.message, `${context}.message`);
  assertNumber(value.timestamp, `${context}.timestamp`);
  return {
    type: value.type,
    message: value.message,
    stack: parseNullableString(value.stack, `${context}.stack`),
    componentStack: parseNullableString(
      value.componentStack,
      `${context}.componentStack`,
    ),
    errorCode: parseNullableString(value.errorCode, `${context}.errorCode`),
    sourceAction: parseNullableString(
      value.sourceAction,
      `${context}.sourceAction`,
    ),
    timestamp: value.timestamp,
  };
}

function parsePrivateDiagnosticsSession(
  value: unknown,
): SupportPrivateDiagnosticsSession | null {
  if (value === null || value === undefined) return null;
  const context = "supportSubmitReport.privateDiagnostics.session";
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, PRIVATE_DIAGNOSTICS_SESSION_KEYS, context);
  return {
    routeTemplate: parseNullableString(
      value.routeTemplate,
      `${context}.routeTemplate`,
    ),
    hostId: parseNullableString(value.hostId, `${context}.hostId`),
    epicId: parseNullableString(value.epicId, `${context}.epicId`),
    tabId: parseNullableString(value.tabId, `${context}.tabId`),
    artifactId: parseNullableString(value.artifactId, `${context}.artifactId`),
    chatId: parseNullableString(value.chatId, `${context}.chatId`),
    agentId: parseNullableString(value.agentId, `${context}.agentId`),
    harness: parseNullableString(value.harness, `${context}.harness`),
    model: parseNullableString(value.model, `${context}.model`),
    profileId: parseNullableString(value.profileId, `${context}.profileId`),
    profileMode: parseNullableString(
      value.profileMode,
      `${context}.profileMode`,
    ),
    providerVersion: parseNullableString(
      value.providerVersion,
      `${context}.providerVersion`,
    ),
    providerClass: parsePrivateDiagnosticsProviderClass(value.providerClass),
  };
}

function parsePrivateDiagnostics(
  value: unknown,
): SupportPrivateDiagnostics | undefined {
  if (value === undefined) return undefined;
  const context = "supportSubmitReport.privateDiagnostics";
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, PRIVATE_DIAGNOSTICS_KEYS, context);
  return {
    cause: parsePrivateDiagnosticsCause(value.cause),
    session: parsePrivateDiagnosticsSession(value.session),
  };
}

export function parseSupportSubmitReportRequest(
  form: unknown,
): SupportSubmitReportRequest {
  assertPlainObject(form, "supportSubmitReport");
  assertOnlyAllowedKeys(
    form,
    SUPPORT_SUBMIT_REPORT_KEYS,
    "supportSubmitReport",
  );
  assertNumber(form.draftId, "supportSubmitReport.draftId");
  assertString(form.title, "supportSubmitReport.title");
  assertString(form.whatHappened, "supportSubmitReport.whatHappened");
  assertString(form.stepsToReproduce, "supportSubmitReport.stepsToReproduce");
  assertString(form.expectedBehavior, "supportSubmitReport.expectedBehavior");
  assertString(form.actualBehavior, "supportSubmitReport.actualBehavior");
  const privateDiagnostics = parsePrivateDiagnostics(form.privateDiagnostics);
  const fingerprint = parseOptionalString(
    form.fingerprint,
    "supportSubmitReport.fingerprint",
  );
  const correlationId = parseOptionalString(
    form.correlationId,
    "supportSubmitReport.correlationId",
  );
  return {
    draftId: form.draftId,
    title: form.title,
    whatHappened: form.whatHappened,
    stepsToReproduce: form.stepsToReproduce,
    expectedBehavior: form.expectedBehavior,
    actualBehavior: form.actualBehavior,
    ...(privateDiagnostics === undefined ? {} : { privateDiagnostics }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function parseSupportReadFrozenLogTailInput(
  input: unknown,
): SupportReadFrozenLogTailInput {
  const context = "supportReadFrozenLogTail";
  assertPlainObject(input, context);
  assertNumber(input.draftId, `${context}.draftId`);
  return {
    draftId: input.draftId,
    target: parseSupportLogTarget(input.target),
  };
}
