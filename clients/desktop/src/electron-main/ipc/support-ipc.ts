import type { IpcMainInvokeEvent } from "electron";
import { app, shell, systemPreferences } from "electron";
import { log } from "../app/logger";
import { showNativeNotification } from "../notifications";
import { safelyOpenExternal } from "../app/security";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import {
  assertInteger,
  assertNumber,
  assertString,
  parseSupportLogTarget,
  readSenderWebContentsId,
} from "./ipc-parsers";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import type {
  SupportCapturedField,
  SupportContextRegistrySnapshot,
  SupportFreezeEvidenceInput,
  SupportLogTarget,
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
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
    (event, form: unknown) => {
      const parsed = parseSupportSubmitReportRequest(form);
      return bridge.support.submitReport(
        parsed,
        frozenEvidenceKey(event, parsed.draftId),
      );
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
    (event, input: unknown) => {
      const parsed = parseSupportFreezeEvidenceInput(input);
      return bridge.support.freezeEvidence(
        frozenEvidenceKey(event, parsed.draftId),
        parsed.fingerprint,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportGetFingerprintOccurrence,
    (_event, fingerprint: unknown) => {
      assertString(fingerprint, "supportGetFingerprintOccurrence.fingerprint");
      if (fingerprint.length === 0) {
        throw new Error(
          "supportGetFingerprintOccurrence.fingerprint must be non-empty",
        );
      }
      return bridge.support.getFingerprintOccurrence(fingerprint);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportDiscardFrozenEvidence,
    (event, draftId: unknown) => {
      assertInteger(draftId, "supportDiscardFrozenEvidence.draftId");
      bridge.support.discardFrozenEvidence(frozenEvidenceKey(event, draftId));
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportReadFrozenLogTail,
    (event, input: unknown) => {
      const parsed = parseSupportReadFrozenLogTailInput(input);
      return bridge.support.readFrozenLogTail(
        frozenEvidenceKey(event, parsed.draftId),
        parsed.target,
      );
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.supportSaveDiagnosticBundle,
    (event, form: unknown) => {
      const parsed = parseSupportSubmitReportRequest(form);
      return bridge.support.saveDiagnosticBundle(
        parsed,
        frozenEvidenceKey(event, parsed.draftId),
      );
    },
  );
}

// A draftId is only unique within one renderer realm (`desktop-dialog-store`
// resets its counter to 0 per window), and the frozen-evidence store is one
// process-wide map - without the sender scoped in, two windows' draft 1 would
// collide (overwritten freezes, cross-window discards, a submit consuming the
// other window's report id). `-1` is a defensive fallback for the
// (practically unreachable) case where the real Electron event carries no
// sender id at all; it does not itself dedupe across such calls.
const UNKNOWN_SENDER_ID = -1;

function frozenEvidenceKey(event: IpcMainInvokeEvent, draftId: number): string {
  return `${readSenderWebContentsId(event) ?? UNKNOWN_SENDER_ID}:${draftId}`;
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
]);

// Exactly ticket 05's five `SerializedReportIssuePrivateDiagnostics` keys,
// all required whenever `privateDiagnostics` is sent at all - the serializer
// never omits one (an "empty" cause/registry is `null`/all-`unavailable`,
// not a missing key), so a missing key here is a real contract violation,
// not an optional field left out.
const PRIVATE_DIAGNOSTICS_KEYS = new Set([
  "cause",
  "registry",
  "fingerprint",
  "stackFamily",
  "correlationId",
]);

const PRIVATE_DIAGNOSTICS_CAUSE_KEYS = new Set([
  "type",
  "message",
  "stack",
  "componentStack",
  "errorCode",
  "sourceAction",
  "timestamp",
]);

const CONTEXT_REGISTRY_KEYS = new Set([
  "routeTemplate",
  "hostId",
  "epicId",
  "tabId",
  "artifactId",
  "chatId",
  "agentId",
  "harnessId",
  "model",
  "profileId",
  "providerSelectionClass",
  "providerVersion",
]);

const CAPTURED_FIELD_KNOWN_KEYS = new Set(["status", "value"]);
const CAPTURED_FIELD_UNAVAILABLE_KEYS = new Set(["status"]);

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

function assertHasKey(
  record: Record<string, unknown>,
  key: string,
  context: string,
): void {
  if (!(key in record)) {
    throw new Error(`${context} is missing required field: ${key}`);
  }
}

function parseRequiredStringValue(value: unknown, context: string): string {
  assertString(value, context);
  return value;
}

function parseProviderSelectionClassValue(
  value: unknown,
  context: string,
): "bundled" | "path" | "custom" {
  if (value === "bundled" || value === "path" || value === "custom") {
    return value;
  }
  throw new Error(`${context} must be "bundled", "path", or "custom"`);
}

/**
 * A `CapturedField<T>` is validated by its `status` first: `unavailable`
 * allows no other keys (there is no value to carry), `known`/`stale` require
 * exactly `{ status, value }` with `parseValue` applied to `value`.
 */
function parseCapturedField<T>(
  value: unknown,
  context: string,
  parseValue: (value: unknown, context: string) => T,
): SupportCapturedField<T> {
  assertPlainObject(value, context);
  const status = value.status;
  if (status === "unavailable") {
    assertOnlyAllowedKeys(value, CAPTURED_FIELD_UNAVAILABLE_KEYS, context);
    return { status: "unavailable" };
  }
  if (status === "known" || status === "stale") {
    assertOnlyAllowedKeys(value, CAPTURED_FIELD_KNOWN_KEYS, context);
    return { status, value: parseValue(value.value, `${context}.value`) };
  }
  throw new Error(
    `${context}.status must be "known", "stale", or "unavailable"`,
  );
}

function parseContextRegistrySnapshot(
  value: unknown,
  context: string,
): SupportContextRegistrySnapshot {
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, CONTEXT_REGISTRY_KEYS, context);
  return {
    routeTemplate: parseCapturedField(
      value.routeTemplate,
      `${context}.routeTemplate`,
      parseRequiredStringValue,
    ),
    hostId: parseCapturedField(
      value.hostId,
      `${context}.hostId`,
      parseRequiredStringValue,
    ),
    epicId: parseCapturedField(
      value.epicId,
      `${context}.epicId`,
      parseRequiredStringValue,
    ),
    tabId: parseCapturedField(
      value.tabId,
      `${context}.tabId`,
      parseRequiredStringValue,
    ),
    artifactId: parseCapturedField(
      value.artifactId,
      `${context}.artifactId`,
      parseRequiredStringValue,
    ),
    chatId: parseCapturedField(
      value.chatId,
      `${context}.chatId`,
      parseRequiredStringValue,
    ),
    agentId: parseCapturedField(
      value.agentId,
      `${context}.agentId`,
      parseRequiredStringValue,
    ),
    harnessId: parseCapturedField(
      value.harnessId,
      `${context}.harnessId`,
      parseRequiredStringValue,
    ),
    model: parseCapturedField(
      value.model,
      `${context}.model`,
      parseRequiredStringValue,
    ),
    profileId: parseCapturedField(
      value.profileId,
      `${context}.profileId`,
      parseNullableString,
    ),
    providerSelectionClass: parseCapturedField(
      value.providerSelectionClass,
      `${context}.providerSelectionClass`,
      parseProviderSelectionClassValue,
    ),
    providerVersion: parseCapturedField(
      value.providerVersion,
      `${context}.providerVersion`,
      parseNullableString,
    ),
  };
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

function parsePrivateDiagnostics(
  value: unknown,
): SupportPrivateDiagnostics | undefined {
  if (value === undefined) return undefined;
  const context = "supportSubmitReport.privateDiagnostics";
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, PRIVATE_DIAGNOSTICS_KEYS, context);
  for (const key of PRIVATE_DIAGNOSTICS_KEYS) {
    assertHasKey(value, key, context);
  }
  assertString(value.correlationId, `${context}.correlationId`);
  return {
    cause: parsePrivateDiagnosticsCause(value.cause),
    registry: parseContextRegistrySnapshot(
      value.registry,
      `${context}.registry`,
    ),
    fingerprint: parseNullableString(
      value.fingerprint,
      `${context}.fingerprint`,
    ),
    stackFamily: parseNullableString(
      value.stackFamily,
      `${context}.stackFamily`,
    ),
    correlationId: value.correlationId,
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
  assertInteger(form.draftId, "supportSubmitReport.draftId");
  assertString(form.title, "supportSubmitReport.title");
  assertString(form.whatHappened, "supportSubmitReport.whatHappened");
  assertString(form.stepsToReproduce, "supportSubmitReport.stepsToReproduce");
  assertString(form.expectedBehavior, "supportSubmitReport.expectedBehavior");
  assertString(form.actualBehavior, "supportSubmitReport.actualBehavior");
  const privateDiagnostics = parsePrivateDiagnostics(form.privateDiagnostics);
  return {
    draftId: form.draftId,
    title: form.title,
    whatHappened: form.whatHappened,
    stepsToReproduce: form.stepsToReproduce,
    expectedBehavior: form.expectedBehavior,
    actualBehavior: form.actualBehavior,
    ...(privateDiagnostics === undefined ? {} : { privateDiagnostics }),
  };
}

const READ_FROZEN_LOG_TAIL_KEYS = new Set(["draftId", "target"]);

export function parseSupportReadFrozenLogTailInput(
  input: unknown,
): SupportReadFrozenLogTailInput {
  const context = "supportReadFrozenLogTail";
  assertPlainObject(input, context);
  assertOnlyAllowedKeys(input, READ_FROZEN_LOG_TAIL_KEYS, context);
  assertInteger(input.draftId, `${context}.draftId`);
  return {
    draftId: input.draftId,
    target: parseSupportLogTarget(input.target),
  };
}

const FREEZE_EVIDENCE_KEYS = new Set(["draftId", "fingerprint"]);

export function parseSupportFreezeEvidenceInput(
  input: unknown,
): SupportFreezeEvidenceInput {
  const context = "supportFreezeEvidence";
  assertPlainObject(input, context);
  assertOnlyAllowedKeys(input, FREEZE_EVIDENCE_KEYS, context);
  assertInteger(input.draftId, `${context}.draftId`);
  // fingerprint is always present on the wire (null when unknown) - a missing
  // key is a contract violation, not an optional field left out.
  assertHasKey(input, "fingerprint", context);
  return {
    draftId: input.draftId,
    fingerprint: parseNullableString(
      input.fingerprint,
      `${context}.fingerprint`,
    ),
  };
}
