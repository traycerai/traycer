import type { IpcMainInvokeEvent } from "electron";
import { app, shell, systemPreferences } from "electron";
import { log } from "../app/logger";
import {
  showNativeFeedNotification,
  showNativeNotification,
} from "../notifications";
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
  SupportEnvironmentItem,
  SupportEnvironmentItemArgs,
  SupportEnvironmentPolicy,
  SupportEnvironmentReachDenial,
  SupportEnvironmentRotation,
  SupportEnvironmentRotationEvidence,
  SupportEnvironmentRotationProducer,
  SupportEnvironmentSection,
  SupportEnvironmentServedTask,
  SupportEnvironmentSetupAttempt,
  SupportFreezeEvidenceInput,
  SupportImageAttachmentInput,
  SupportLogTarget,
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
  SupportPrivateOutcome,
  SupportReadFrozenLogTailInput,
  SupportReportFrequency,
  SupportReportType,
  SupportSubmitReportRequest,
} from "../../ipc-contracts/window-types";
import type {
  DesktopNotificationFeedSource,
  DesktopNotificationFeedOccurrence,
  DesktopNotificationForegroundAppLocal,
  DesktopNotificationForegroundDisplay,
} from "../../ipc-contracts/notification-types";
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGES,
  MAX_REPORT_LOG_ATTACHMENTS,
  matchesReportImageMagicBytes,
  reportImageMediaTypeForMimeType,
  reportImagesExceedBudget,
} from "@traycer-clients/shared/support/image-attachment-guards";

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

  // Opens the macOS Privacy → Full Disk Access pane, where the login import
  // sends a user whose Safari jar the OS refused. Hardcoded in main for the
  // same reason as the microphone link: `x-apple.systempreferences:` is not
  // an http(s) scheme, so `openExternalLink` would refuse it and report
  // nothing (`safelyOpenExternal` answers `false`, which that handler drops).
  bridge.handleInvoke(RunnerHostInvoke.openFullDiskAccessSettings, async () => {
    if (process.platform !== "darwin") {
      log.warn(
        "[support] openFullDiskAccessSettings unsupported on this platform",
      );
      return;
    }
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    );
  });

  // Opens the native notification-preferences page. The URL is selected in
  // main rather than supplied by the renderer, so this intentionally bypasses
  // the http-only external-link gate just like the microphone settings link.
  bridge.handleInvoke(
    RunnerHostInvoke.notificationOpenSystemSettings,
    async () => {
      const url =
        process.platform === "darwin"
          ? "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
          : process.platform === "win32"
            ? "ms-settings:notifications"
            : null;
      if (url === null) {
        log.warn(
          "[support] notification system settings unsupported on this platform",
        );
        return;
      }
      await shell.openExternal(url);
    },
  );

  bridge.handleInvoke(
    RunnerHostInvoke.notificationShow,
    async (
      event,
      title: unknown,
      body: unknown,
      payload: unknown,
      replaceKey: unknown,
      deliveryKey: unknown,
      feedSource: unknown,
      foregroundAppLocal: unknown,
      feedOccurrences: unknown,
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
      const parsedForegroundAppLocal =
        parseForegroundAppLocal(foregroundAppLocal);
      const occurrences = parseNotificationFeedOccurrences(feedOccurrences);
      const parsedFeedSource = parseNotificationFeedSource(feedSource);
      const forwardDisplay = (
        display: DesktopNotificationForegroundDisplay,
      ): void => {
        const delivered = bridge.deliverForegroundNotificationDisplay(
          readSenderWebContentsId(event),
          display,
        );
        if (!delivered) {
          throw new Error(
            "notifications.show could not reach the focused renderer",
          );
        }
      };
      if (occurrences !== null) {
        if (parsedForegroundAppLocal !== null) {
          throw new Error(
            "notifications.show cannot mix feed and app-local delivery",
          );
        }
        return showNativeFeedNotification(
          occurrences,
          (entryPayload) => bridge.deliverNotificationClick(entryPayload),
          forwardDisplay,
        );
      }
      const foregroundDisplay: DesktopNotificationForegroundDisplay = {
        title,
        body,
        payload,
        replaceKey,
        deliveryKey,
        feedSource: parsedFeedSource,
        foregroundAppLocal: parsedForegroundAppLocal,
      };
      return showNativeNotification({
        title,
        body,
        replaceKey,
        deliveryKey,
        onClick: () => bridge.deliverNotificationClick(payload),
        onForegroundSuppressed: () => forwardDisplay(foregroundDisplay),
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
      const parsed = parseSupportReportRequest(form, "supportSubmitReport");
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
      const parsed = parseSupportReportRequest(
        form,
        "supportSaveDiagnosticBundle",
      );
      return bridge.support.saveDiagnosticBundle(
        parsed,
        frozenEvidenceKey(event, parsed.draftId),
      );
    },
  );

  // Ticket 09 / T6: same wire shape as `supportSubmitReport` (draftId + the
  // five public fields + optional privateDiagnostics), so it reuses that
  // parser rather than duplicating an identical one.
  bridge.handleInvoke(
    RunnerHostInvoke.supportBuildPublicDraft,
    (event, form: unknown) => {
      const parsed = parseSupportReportRequest(form, "supportBuildPublicDraft");
      return bridge.support.buildPublicDraft(
        parsed,
        frozenEvidenceKey(event, parsed.draftId),
      );
    },
  );
}

function parseNotificationFeedOccurrences(
  value: unknown,
): ReadonlyArray<DesktopNotificationFeedOccurrence> | null {
  // Older renderer/preload pairs omit this argument.
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 5_000) {
    throw new Error(
      "notifications.show requires a non-empty bounded feed batch",
    );
  }
  return value.map((entry: unknown): DesktopNotificationFeedOccurrence => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("key" in entry) ||
      typeof entry.key !== "string" ||
      entry.key.length === 0 ||
      !("userId" in entry) ||
      (entry.userId !== null && typeof entry.userId !== "string") ||
      !("chimeEventType" in entry) ||
      (entry.chimeEventType !== "needs_action" &&
        entry.chimeEventType !== "failure" &&
        entry.chimeEventType !== "done" &&
        entry.chimeEventType !== "info") ||
      !("title" in entry) ||
      typeof entry.title !== "string" ||
      !("body" in entry) ||
      typeof entry.body !== "string" ||
      !("replaceKey" in entry) ||
      typeof entry.replaceKey !== "string" ||
      !("payload" in entry) ||
      !("originHostId" in entry) ||
      (entry.originHostId !== null && typeof entry.originHostId !== "string") ||
      !("epicId" in entry) ||
      (entry.epicId !== null && typeof entry.epicId !== "string") ||
      !("chatId" in entry) ||
      (entry.chatId !== null && typeof entry.chatId !== "string") ||
      !("feedSource" in entry) ||
      (entry.feedSource !== "host" && entry.feedSource !== "cloud")
    ) {
      throw new Error("notifications.show requires valid feed occurrences");
    }
    return {
      key: entry.key,
      userId: entry.userId,
      chimeEventType: entry.chimeEventType,
      title: entry.title,
      body: entry.body,
      payload: entry.payload,
      replaceKey: entry.replaceKey,
      feedSource: entry.feedSource,
      originHostId: entry.originHostId,
      epicId: entry.epicId,
      chatId: entry.chatId,
    };
  });
}

function parseNotificationFeedSource(
  value: unknown,
): DesktopNotificationFeedSource | null {
  if (value === null) return null;
  if (
    value === "host" ||
    value === "cloud" ||
    value === "app-local" ||
    value === "global"
  ) {
    return value;
  }
  throw new Error("notifications.show requires a known feed source or null");
}

function parseForegroundAppLocal(
  value: unknown,
): DesktopNotificationForegroundAppLocal | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("userId" in value) ||
    typeof value.userId !== "string" ||
    !("entry" in value)
  ) {
    throw new Error(
      "notifications.show requires foreground app-local context or null",
    );
  }
  return {
    userId: value.userId,
    entry: value.entry,
  };
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

export function parseSupportTailLogInput(input: unknown): {
  readonly target: SupportLogTarget;
  readonly tailLines: number;
} {
  assertPlainObject(input, "supportTailLog");
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

function contractKeySet<T extends object>(
  keys: Record<keyof T, true>,
): ReadonlySet<string> {
  return new Set(Object.keys(keys));
}

const SUPPORT_SUBMIT_REPORT_KEYS = contractKeySet<SupportSubmitReportRequest>({
  draftId: true,
  type: true,
  intent: true,
  frequency: true,
  location: true,
  allowContact: true,
  includeDesktopLog: true,
  includeHostLog: true,
  includeBrowserDiagnostics: true,
  includeDiagnostics: true,
  images: true,
  overrideTitle: true,
  privateOutcome: true,
  privateDiagnostics: true,
});

const SUPPORT_IMAGE_ATTACHMENT_KEYS =
  contractKeySet<SupportImageAttachmentInput>({
    fileName: true,
    mimeType: true,
    bytes: true,
  });

function parseSupportReportType(
  value: unknown,
  context: string,
): SupportReportType {
  if (value === "bug" || value === "idea" || value === "other") return value;
  throw new Error(`${context} must be "bug", "idea", or "other"`);
}

function parseSupportReportFrequency(
  value: unknown,
  context: string,
): SupportReportFrequency | null {
  if (value === null) return null;
  if (
    value === "once" ||
    value === "sometimes" ||
    value === "every_time" ||
    value === "not_sure"
  ) {
    return value;
  }
  throw new Error(
    `${context} must be "once", "sometimes", "every_time", "not_sure", or null`,
  );
}

function assertBoolean(
  value: unknown,
  context: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean`);
  }
}

function parseSupportPrivateOutcome(
  value: unknown,
  context: string,
): SupportPrivateOutcome {
  if (value === "delivered" || value === "unconfirmed" || value === "none") {
    return value;
  }
  throw new Error(`${context} must be "delivered", "unconfirmed", or "none"`);
}

// Exactly ticket 05's five `SerializedReportIssuePrivateDiagnostics` keys,
// plus ticket E11's `environment` (checkpoint 5),
// all required whenever `privateDiagnostics` is sent at all - the serializer
// never omits one (an "empty" cause/registry is `null`/all-`unavailable`,
// not a missing key), so a missing key here is a real contract violation,
// not an optional field left out.
const PRIVATE_DIAGNOSTICS_KEYS = contractKeySet<SupportPrivateDiagnostics>({
  cause: true,
  registry: true,
  fingerprint: true,
  stackFamily: true,
  correlationId: true,
  environment: true,
});

const PRIVATE_DIAGNOSTICS_CAUSE_KEYS =
  contractKeySet<SupportPrivateDiagnosticsCause>({
    type: true,
    message: true,
    stack: true,
    componentStack: true,
    errorCode: true,
    sourceAction: true,
    timestamp: true,
  });

const CONTEXT_REGISTRY_KEYS = contractKeySet<SupportContextRegistrySnapshot>({
  routeTemplate: true,
  hostId: true,
  tabHostId: true,
  epicId: true,
  tabId: true,
  artifactId: true,
  chatId: true,
  agentId: true,
  harnessId: true,
  model: true,
  profileId: true,
  providerSelectionClass: true,
  providerVersion: true,
});

// The environment section (ticket E11, checkpoint 5): one closed key set per
// record of the renderer's `SupportEnvironmentSection`, every key required.
// Anything else, a pending upload, an override, a value, the policy body, a
// team or owner label, connector detail among them, is refused by name.
const ENVIRONMENT_SECTION_KEYS = contractKeySet<SupportEnvironmentSection>({
  hostId: true,
  principal: true,
  reachability: true,
  bindingGeneration: true,
  desiredRevision: true,
  receivedRevision: true,
  appliedRevision: true,
  receiptAgeMs: true,
  items: true,
  setupAttempts: true,
  policy: true,
  rotations: true,
  reachDenials: true,
  servedTask: true,
});

// A refusal is references and categories only (ticket E13 checkpoint 4): a
// host's label, a display name or an owner's id inside one is refused by name.
const ENVIRONMENT_REACH_DENIAL_KEYS =
  contractKeySet<SupportEnvironmentReachDenial>({
    denialId: true,
    at: true,
    sourceHostRef: true,
    targetHostRef: true,
    taskRef: true,
    reason: true,
    sourcePrincipal: true,
    targetPrincipal: true,
    count: true,
  });

const ENVIRONMENT_SERVED_TASK_KEYS =
  contractKeySet<SupportEnvironmentServedTask>({
    taskRef: true,
    otherHostPrincipals: true,
  });

const ENVIRONMENT_ITEM_KEYS = contractKeySet<SupportEnvironmentItem>({
  kind: true,
  key: true,
  os: true,
  status: true,
  code: true,
  args: true,
});

const ENVIRONMENT_ITEM_ARGS_KEYS = contractKeySet<SupportEnvironmentItemArgs>({
  exitStatus: true,
  stage: true,
  durationMs: true,
  kind: true,
});

const ENVIRONMENT_SETUP_ATTEMPT_KEYS =
  contractKeySet<SupportEnvironmentSetupAttempt>({
    attemptId: true,
    scriptHash: true,
    trigger: true,
    startedAt: true,
    endedAt: true,
    exitStatus: true,
    stageReached: true,
    result: true,
  });

const ENVIRONMENT_POLICY_KEYS = contractKeySet<SupportEnvironmentPolicy>({
  source: true,
  readState: true,
  teamState: true,
  teamPolicyVersion: true,
});

const ENVIRONMENT_ROTATION_KEYS = contractKeySet<SupportEnvironmentRotation>({
  secretName: true,
  state: true,
  producers: true,
});

const ENVIRONMENT_ROTATION_PRODUCER_KEYS =
  contractKeySet<SupportEnvironmentRotationProducer>({
    producer: true,
    workerClass: true,
    hostId: true,
    hostName: true,
    status: true,
    evidence: true,
  });

const ENVIRONMENT_ROTATION_EVIDENCE_KEYS =
  contractKeySet<SupportEnvironmentRotationEvidence>({
    kind: true,
    count: true,
  });

/**
 * The longest each environment text field may be: the renderer's
 * `SUPPORT_ENVIRONMENT_TEXT_MAX`, the same numbers. The two names are the
 * person's own (an item key, a secret name), bounded by the account's own
 * rules; everything else is a closed code, a hash or an opaque id.
 */
const SUPPORT_ENVIRONMENT_TEXT_MAX = {
  itemKey: 3072,
  secretName: 128,
  code: 64,
  hash: 128,
  id: 256,
} as const;

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
    assertHasKey(value, "value", context);
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
    tabHostId: parseCapturedField(
      value.tabHostId,
      `${context}.tabHostId`,
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

/** A record with exactly `keys`, every one present. */
function assertClosedRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  context: string,
): asserts value is Record<string, unknown> {
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, keys, context);
  for (const key of keys) {
    assertHasKey(value, key, context);
  }
}

function parseBoundedString(
  value: unknown,
  max: number,
  context: string,
): string {
  assertString(value, context);
  if (value.length > max) {
    throw new Error(`${context} is longer than ${max} characters`);
  }
  return value;
}

function parseNullableBoundedString(
  value: unknown,
  max: number,
  context: string,
): string | null {
  if (value === null) return null;
  return parseBoundedString(value, max, context);
}

function parseNullableNumber(value: unknown, context: string): number | null {
  if (value === null) return null;
  assertNumber(value, context);
  return value;
}

function parseArray<T>(
  value: unknown,
  context: string,
  parseEntry: (entry: unknown, context: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((entry: unknown, index) =>
    parseEntry(entry, `${context}[${index}]`),
  );
}

function parseNullableArray<T>(
  value: unknown,
  context: string,
  parseEntry: (entry: unknown, context: string) => T,
): readonly T[] | null {
  if (value === null) return null;
  return parseArray(value, context, parseEntry);
}

function parseEnvironmentCode(value: unknown, context: string): string {
  return parseBoundedString(value, SUPPORT_ENVIRONMENT_TEXT_MAX.code, context);
}

function parseNullableEnvironmentCode(
  value: unknown,
  context: string,
): string | null {
  return parseNullableBoundedString(
    value,
    SUPPORT_ENVIRONMENT_TEXT_MAX.code,
    context,
  );
}

function parseEnvironmentId(value: unknown, context: string): string {
  return parseBoundedString(value, SUPPORT_ENVIRONMENT_TEXT_MAX.id, context);
}

function parseEnvironmentPrincipal(
  value: unknown,
  context: string,
): "personal" | "team" | null {
  if (value === null || value === "personal" || value === "team") {
    return value;
  }
  throw new Error(`${context} must be "personal", "team", or null`);
}

function parseEnvironmentItemArgs(
  value: unknown,
  context: string,
): SupportEnvironmentItemArgs {
  assertClosedRecord(value, ENVIRONMENT_ITEM_ARGS_KEYS, context);
  return {
    exitStatus: parseNullableNumber(value.exitStatus, `${context}.exitStatus`),
    stage: parseNullableEnvironmentCode(value.stage, `${context}.stage`),
    durationMs: parseNullableNumber(value.durationMs, `${context}.durationMs`),
    kind: parseNullableEnvironmentCode(value.kind, `${context}.kind`),
  };
}

function parseEnvironmentItem(
  value: unknown,
  context: string,
): SupportEnvironmentItem {
  assertClosedRecord(value, ENVIRONMENT_ITEM_KEYS, context);
  // Destructured, not `value.key` / `value.code`: the keyboard-read
  // inventory counts a `.key` read beside a `.code` read as a key event.
  const { key, code } = value;
  return {
    kind: parseEnvironmentCode(value.kind, `${context}.kind`),
    key: parseBoundedString(
      key,
      SUPPORT_ENVIRONMENT_TEXT_MAX.itemKey,
      `${context}.key`,
    ),
    os: parseEnvironmentCode(value.os, `${context}.os`),
    status: parseEnvironmentCode(value.status, `${context}.status`),
    code: parseEnvironmentCode(code, `${context}.code`),
    args: parseEnvironmentItemArgs(value.args, `${context}.args`),
  };
}

function parseEnvironmentSetupAttempt(
  value: unknown,
  context: string,
): SupportEnvironmentSetupAttempt {
  assertClosedRecord(value, ENVIRONMENT_SETUP_ATTEMPT_KEYS, context);
  assertNumber(value.startedAt, `${context}.startedAt`);
  return {
    attemptId: parseEnvironmentId(value.attemptId, `${context}.attemptId`),
    scriptHash: parseBoundedString(
      value.scriptHash,
      SUPPORT_ENVIRONMENT_TEXT_MAX.hash,
      `${context}.scriptHash`,
    ),
    trigger: parseEnvironmentCode(value.trigger, `${context}.trigger`),
    startedAt: value.startedAt,
    endedAt: parseNullableNumber(value.endedAt, `${context}.endedAt`),
    exitStatus: parseNullableNumber(value.exitStatus, `${context}.exitStatus`),
    stageReached: parseNullableEnvironmentCode(
      value.stageReached,
      `${context}.stageReached`,
    ),
    result: parseNullableEnvironmentCode(value.result, `${context}.result`),
  };
}

function parseEnvironmentPolicy(
  value: unknown,
  context: string,
): SupportEnvironmentPolicy | null {
  if (value === null) return null;
  assertClosedRecord(value, ENVIRONMENT_POLICY_KEYS, context);
  return {
    source: parseEnvironmentCode(value.source, `${context}.source`),
    readState: parseEnvironmentCode(value.readState, `${context}.readState`),
    teamState: parseNullableEnvironmentCode(
      value.teamState,
      `${context}.teamState`,
    ),
    teamPolicyVersion: parseNullableEnvironmentCode(
      value.teamPolicyVersion,
      `${context}.teamPolicyVersion`,
    ),
  };
}

function parseEnvironmentRotationEvidence(
  value: unknown,
  context: string,
): SupportEnvironmentRotationEvidence {
  assertClosedRecord(value, ENVIRONMENT_ROTATION_EVIDENCE_KEYS, context);
  return {
    kind: parseEnvironmentCode(value.kind, `${context}.kind`),
    count: parseNullableNumber(value.count, `${context}.count`),
  };
}

function parseEnvironmentRotationProducer(
  value: unknown,
  context: string,
): SupportEnvironmentRotationProducer {
  assertClosedRecord(value, ENVIRONMENT_ROTATION_PRODUCER_KEYS, context);
  // A host travels as its opaque id; its name never rides.
  if (value.hostName !== null) {
    throw new Error(`${context}.hostName must be null`);
  }
  return {
    producer: parseEnvironmentCode(value.producer, `${context}.producer`),
    workerClass: parseNullableEnvironmentCode(
      value.workerClass,
      `${context}.workerClass`,
    ),
    hostId:
      value.hostId === null
        ? null
        : parseEnvironmentId(value.hostId, `${context}.hostId`),
    hostName: null,
    status: parseEnvironmentCode(value.status, `${context}.status`),
    evidence: parseNullableArray(
      value.evidence,
      `${context}.evidence`,
      parseEnvironmentRotationEvidence,
    ),
  };
}

function parseEnvironmentRotation(
  value: unknown,
  context: string,
): SupportEnvironmentRotation {
  assertClosedRecord(value, ENVIRONMENT_ROTATION_KEYS, context);
  return {
    secretName: parseBoundedString(
      value.secretName,
      SUPPORT_ENVIRONMENT_TEXT_MAX.secretName,
      `${context}.secretName`,
    ),
    state: parseEnvironmentCode(value.state, `${context}.state`),
    producers: parseArray(
      value.producers,
      `${context}.producers`,
      parseEnvironmentRotationProducer,
    ),
  };
}

function parseReachPrincipalCategory(value: unknown, context: string): string {
  if (value === "personal" || value === "team" || value === "unknown") {
    return value;
  }
  throw new Error(`${context} must be "personal", "team", or "unknown"`);
}

function parseEnvironmentReachDenial(
  value: unknown,
  context: string,
): SupportEnvironmentReachDenial {
  assertClosedRecord(value, ENVIRONMENT_REACH_DENIAL_KEYS, context);
  assertNumber(value.at, `${context}.at`);
  assertNumber(value.count, `${context}.count`);
  if (value.reason !== "principal_mismatch") {
    throw new Error(`${context}.reason must be "principal_mismatch"`);
  }
  return {
    denialId: parseEnvironmentId(value.denialId, `${context}.denialId`),
    at: value.at,
    sourceHostRef: parseEnvironmentId(
      value.sourceHostRef,
      `${context}.sourceHostRef`,
    ),
    targetHostRef: parseEnvironmentId(
      value.targetHostRef,
      `${context}.targetHostRef`,
    ),
    taskRef:
      value.taskRef === null
        ? null
        : parseEnvironmentId(value.taskRef, `${context}.taskRef`),
    reason: "principal_mismatch",
    sourcePrincipal: parseReachPrincipalCategory(
      value.sourcePrincipal,
      `${context}.sourcePrincipal`,
    ),
    targetPrincipal: parseReachPrincipalCategory(
      value.targetPrincipal,
      `${context}.targetPrincipal`,
    ),
    count: value.count,
  };
}

function parseEnvironmentServedTask(
  value: unknown,
  context: string,
): SupportEnvironmentServedTask | null {
  if (value === null) return null;
  assertClosedRecord(value, ENVIRONMENT_SERVED_TASK_KEYS, context);
  return {
    taskRef: parseEnvironmentId(value.taskRef, `${context}.taskRef`),
    otherHostPrincipals: parseArray(
      value.otherHostPrincipals,
      `${context}.otherHostPrincipals`,
      parseReachPrincipalCategory,
    ),
  };
}

function parseEnvironmentSection(
  value: unknown,
  context: string,
): SupportEnvironmentSection {
  assertClosedRecord(value, ENVIRONMENT_SECTION_KEYS, context);
  return {
    hostId: parseEnvironmentId(value.hostId, `${context}.hostId`),
    principal: parseEnvironmentPrincipal(
      value.principal,
      `${context}.principal`,
    ),
    reachability: parseEnvironmentCode(
      value.reachability,
      `${context}.reachability`,
    ),
    bindingGeneration: parseNullableNumber(
      value.bindingGeneration,
      `${context}.bindingGeneration`,
    ),
    desiredRevision: parseNullableNumber(
      value.desiredRevision,
      `${context}.desiredRevision`,
    ),
    receivedRevision: parseNullableNumber(
      value.receivedRevision,
      `${context}.receivedRevision`,
    ),
    appliedRevision: parseNullableNumber(
      value.appliedRevision,
      `${context}.appliedRevision`,
    ),
    receiptAgeMs: parseNullableNumber(
      value.receiptAgeMs,
      `${context}.receiptAgeMs`,
    ),
    items: parseArray(value.items, `${context}.items`, parseEnvironmentItem),
    setupAttempts: parseNullableArray(
      value.setupAttempts,
      `${context}.setupAttempts`,
      parseEnvironmentSetupAttempt,
    ),
    policy: parseEnvironmentPolicy(value.policy, `${context}.policy`),
    rotations: parseNullableArray(
      value.rotations,
      `${context}.rotations`,
      parseEnvironmentRotation,
    ),
    reachDenials: parseNullableArray(
      value.reachDenials,
      `${context}.reachDenials`,
      parseEnvironmentReachDenial,
    ),
    servedTask: parseEnvironmentServedTask(
      value.servedTask,
      `${context}.servedTask`,
    ),
  };
}

function parsePrivateDiagnosticsCause(
  value: unknown,
  context: string,
): SupportPrivateDiagnosticsCause | null {
  if (value === null || value === undefined) return null;
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
  context: string,
): SupportPrivateDiagnostics | undefined {
  if (value === undefined) return undefined;
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, PRIVATE_DIAGNOSTICS_KEYS, context);
  for (const key of PRIVATE_DIAGNOSTICS_KEYS) {
    assertHasKey(value, key, context);
  }
  assertString(value.correlationId, `${context}.correlationId`);
  return {
    cause: parsePrivateDiagnosticsCause(value.cause, `${context}.cause`),
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
    environment: parseCapturedField(
      value.environment,
      `${context}.environment`,
      parseEnvironmentSection,
    ),
  };
}

function assertArrayBuffer(
  value: unknown,
  context: string,
): asserts value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new Error(`${context} must be an ArrayBuffer`);
  }
}

/**
 * Full revalidation of one attached screenshot, independent of whatever the
 * renderer's attach-time checks already did (ticket 08 guardrail: Electron
 * main trusts nothing from the renderer). Checks shape, the MIME allowlist,
 * per-image size, and the actual magic bytes against the declared type - a
 * mismatched extension/Content-Type pair is exactly what a crafted payload
 * would present.
 */
function parseSupportImageAttachment(
  value: unknown,
  context: string,
): SupportImageAttachmentInput {
  assertPlainObject(value, context);
  assertOnlyAllowedKeys(value, SUPPORT_IMAGE_ATTACHMENT_KEYS, context);
  assertString(value.fileName, `${context}.fileName`);
  assertString(value.mimeType, `${context}.mimeType`);
  assertArrayBuffer(value.bytes, `${context}.bytes`);
  const mediaType = reportImageMediaTypeForMimeType(value.mimeType);
  if (mediaType === null) {
    throw new Error(
      `${context}.mimeType must be one of image/png, image/jpeg, image/jpg, image/gif, image/webp`,
    );
  }
  if (value.bytes.byteLength === 0) {
    throw new Error(`${context}.bytes must not be empty`);
  }
  if (value.bytes.byteLength > MAX_REPORT_IMAGE_BYTES) {
    throw new Error(
      `${context}.bytes exceeds the ${MAX_REPORT_IMAGE_BYTES}-byte limit`,
    );
  }
  if (!matchesReportImageMagicBytes(new Uint8Array(value.bytes), mediaType)) {
    throw new Error(
      `${context}.bytes does not match declared type ${mediaType}`,
    );
  }
  return {
    fileName: value.fileName,
    mimeType: value.mimeType,
    bytes: value.bytes,
  };
}

function parseSupportImageAttachments(
  value: unknown,
  context: string,
): readonly SupportImageAttachmentInput[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }
  if (value.length > MAX_REPORT_IMAGES) {
    throw new Error(
      `${context} must contain at most ${MAX_REPORT_IMAGES} images`,
    );
  }
  const images = value.map((entry, index) =>
    parseSupportImageAttachment(entry, `${context}[${index}]`),
  );
  const totalBytes = images.reduce(
    (sum, image) => sum + image.bytes.byteLength,
    0,
  );
  if (reportImagesExceedBudget(totalBytes, MAX_REPORT_LOG_ATTACHMENTS)) {
    throw new Error(`${context} exceeds the total attachment size budget`);
  }
  return images;
}

export function parseSupportSubmitReportRequest(
  form: unknown,
): SupportSubmitReportRequest {
  return parseSupportReportRequest(form, "supportSubmitReport");
}

function parseSupportReportRequest(
  form: unknown,
  context: string,
): SupportSubmitReportRequest {
  assertPlainObject(form, context);
  assertOnlyAllowedKeys(form, SUPPORT_SUBMIT_REPORT_KEYS, context);
  assertInteger(form.draftId, `${context}.draftId`);
  const type = parseSupportReportType(form.type, `${context}.type`);
  assertString(form.intent, `${context}.intent`);
  // frequency/location are always present on the wire (null when unset) - a
  // missing key is a contract violation, matching `freezeEvidence.fingerprint`.
  assertHasKey(form, "frequency", context);
  assertHasKey(form, "location", context);
  const frequency = parseSupportReportFrequency(
    form.frequency,
    `${context}.frequency`,
  );
  const location = parseNullableString(form.location, `${context}.location`);
  assertBoolean(form.allowContact, `${context}.allowContact`);
  assertBoolean(form.includeDesktopLog, `${context}.includeDesktopLog`);
  assertBoolean(form.includeHostLog, `${context}.includeHostLog`);
  assertBoolean(
    form.includeBrowserDiagnostics,
    `${context}.includeBrowserDiagnostics`,
  );
  assertBoolean(form.includeDiagnostics, `${context}.includeDiagnostics`);
  // Always present on the wire (empty array when nothing attached), matching
  // frequency/location's "no missing key" contract.
  assertHasKey(form, "images", context);
  const images = parseSupportImageAttachments(form.images, `${context}.images`);
  assertHasKey(form, "overrideTitle", context);
  const overrideTitle = parseNullableString(
    form.overrideTitle,
    `${context}.overrideTitle`,
  );
  const privateOutcome = parseSupportPrivateOutcome(
    form.privateOutcome,
    `${context}.privateOutcome`,
  );
  const privateDiagnostics = parsePrivateDiagnostics(
    form.privateDiagnostics,
    `${context}.privateDiagnostics`,
  );
  assertHasSubmittableEvidence(
    {
      intent: form.intent,
      location,
      images,
      privateDiagnostics,
    },
    context,
  );
  return {
    draftId: form.draftId,
    type,
    intent: form.intent,
    frequency,
    location,
    allowContact: form.allowContact,
    includeDesktopLog: form.includeDesktopLog,
    includeHostLog: form.includeHostLog,
    includeBrowserDiagnostics: form.includeBrowserDiagnostics,
    includeDiagnostics: form.includeDiagnostics,
    images,
    overrideTitle,
    privateOutcome,
    ...(privateDiagnostics === undefined ? {} : { privateDiagnostics }),
  };
}

// G15: mirrors the dialog's own evidence gate (tech-plan T4/T5 - a sentence,
// a screenshot, or (bug-only) an actively-changed location satisfies it;
// an error envelope always does) at the wire boundary, so a stale or buggy
// client can never smuggle a genuinely-empty report past a UI gate that was
// supposed to be the only thing blocking it. `location` is non-null on the
// wire ONLY when the client's own gate already treated an actively-changed
// bug location as satisfying evidence (see `buildRequest` in the dialog),
// so checking it here is an exact mirror, not a re-derivation. Every
// non-empty case the client's own gate accepts must still be accepted here:
// this must never regress into rejecting an error-triggered report with no
// typed text, or a bug report satisfied by location alone.
function assertHasSubmittableEvidence(
  input: {
    readonly intent: string;
    readonly location: string | null;
    readonly images: readonly SupportImageAttachmentInput[];
    readonly privateDiagnostics: SupportPrivateDiagnostics | undefined;
  },
  context: string,
): void {
  const hasErrorEnvelope =
    input.privateDiagnostics !== undefined &&
    (input.privateDiagnostics.cause !== null ||
      input.privateDiagnostics.fingerprint !== null);
  const hasEvidence =
    hasErrorEnvelope ||
    input.intent.trim().length > 0 ||
    input.images.length > 0 ||
    (input.location !== null && input.location.trim().length > 0);
  if (!hasEvidence) {
    throw new Error(
      `${context} requires a sentence, a screenshot, a location, or a captured error - none were present`,
    );
  }
}

const READ_FROZEN_LOG_TAIL_KEYS = contractKeySet<SupportReadFrozenLogTailInput>(
  {
    draftId: true,
    target: true,
  },
);

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

const FREEZE_EVIDENCE_KEYS = contractKeySet<SupportFreezeEvidenceInput>({
  draftId: true,
  fingerprint: true,
});

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
