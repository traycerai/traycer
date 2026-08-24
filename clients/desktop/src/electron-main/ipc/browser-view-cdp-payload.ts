import type { BrowserViewCdpCommand } from "../../ipc-contracts/browser-view-types";

/**
 * Payload parsing for ticket 03's typed CDP bridge, shared by the two IPC
 * registrars that can receive one.
 *
 * It started life inside `agent-browser-view-ipc.ts` when the agent's own
 * tile was the only tile the host could drive. Ticket 09 gives the same
 * bridge a second consumer - a *borrowed* tile, one the user already had
 * open in `persist:traycer-browser`, which they asked the agent in chat to
 * drive - registered through `browser-view-ipc.ts` instead.
 *
 * It is shared rather than copied deliberately, and this is the one place in
 * these two files where that is the right call. They duplicate their small
 * `parseTileKey`/`readString`/`assertRecord` helpers, which is fine: those
 * are three lines each and a divergence would be visible immediately. This
 * is ~180 lines covering fourteen enumerated CDP methods, and a drift
 * between the two copies would not fail loudly - it would silently
 * mis-parse one command shape on one of the two tile kinds, which is
 * exactly the class of bug that only shows up against a real browser.
 *
 * Capability parity between the agent's own tile and a borrowed one is a
 * v3 ruling, so "the same fourteen methods, parsed the same way" is a
 * property to enforce structurally, not a coincidence to maintain by hand.
 */
export function parseBrowserViewCdpCommand(
  value: unknown,
): BrowserViewCdpCommand {
  const record = assertRecord(value, "Browser view CDP command");
  const kind = readString(record.kind, "command.kind");
  switch (kind) {
    case "cdpNavigate":
      return {
        kind: "cdpNavigate",
        url: readString(record.url, "command.url"),
      };
    case "cdpCaptureScreenshot":
      return {
        kind: "cdpCaptureScreenshot",
        format: readScreenshotFormat(record.format),
        quality: readNullableFiniteNumber(record.quality, "command.quality"),
      };
    case "cdpGetFrameTree":
      return { kind: "cdpGetFrameTree" };
    case "cdpCreateIsolatedWorld":
      return {
        kind: "cdpCreateIsolatedWorld",
        frameId: readString(record.frameId, "command.frameId"),
        worldName: readString(record.worldName, "command.worldName"),
        grantUniversalAccess: readBoolean(
          record.grantUniversalAccess,
          "command.grantUniversalAccess",
        ),
      };
    case "cdpEvaluate":
      return {
        kind: "cdpEvaluate",
        expression: readString(record.expression, "command.expression"),
        awaitPromise: readBoolean(record.awaitPromise, "command.awaitPromise"),
        returnByValue: readBoolean(
          record.returnByValue,
          "command.returnByValue",
        ),
        contextId: readNullableFiniteNumber(
          record.contextId,
          "command.contextId",
        ),
      };
    case "cdpCallFunctionOn":
      return {
        kind: "cdpCallFunctionOn",
        objectId: readCdpNullableString(record.objectId, "command.objectId"),
        executionContextId: readNullableFiniteNumber(
          record.executionContextId,
          "command.executionContextId",
        ),
        functionDeclaration: readString(
          record.functionDeclaration,
          "command.functionDeclaration",
        ),
        argumentsJson: record.argumentsJson ?? null,
        returnByValue: readBoolean(
          record.returnByValue,
          "command.returnByValue",
        ),
      };
    case "cdpReleaseObject":
      return {
        kind: "cdpReleaseObject",
        objectId: readString(record.objectId, "command.objectId"),
      };
    case "cdpDispatchMouseEvent":
      return {
        kind: "cdpDispatchMouseEvent",
        type: readMouseEventType(record.type),
        x: readFiniteNumber(record.x, "command.x"),
        y: readFiniteNumber(record.y, "command.y"),
        button: readNullableMouseButton(record.button),
        clickCount: readNullableFiniteNumber(
          record.clickCount,
          "command.clickCount",
        ),
        deltaX: readNullableFiniteNumber(record.deltaX, "command.deltaX"),
        deltaY: readNullableFiniteNumber(record.deltaY, "command.deltaY"),
      };
    case "cdpInsertText":
      return {
        kind: "cdpInsertText",
        text: readString(record.text, "command.text"),
      };
    case "cdpDispatchKeyEvent":
      return {
        kind: "cdpDispatchKeyEvent",
        type: readKeyEventType(record.type),
        key: readCdpNullableString(record.key, "command.key"),
        code: readCdpNullableString(record.code, "command.code"),
        text: readCdpNullableString(record.text, "command.text"),
        modifiers: readNullableInteger(
          record.modifiers ?? null,
          "command.modifiers",
          false,
        ),
        unmodifiedText: readCdpNullableString(
          record.unmodifiedText ?? null,
          "command.unmodifiedText",
        ),
        windowsVirtualKeyCode: readNullableInteger(
          record.windowsVirtualKeyCode ?? null,
          "command.windowsVirtualKeyCode",
          false,
        ),
        location: readNullableInteger(
          record.location ?? null,
          "command.location",
          true,
        ),
        isKeypad: readNullableBoolean(
          record.isKeypad ?? null,
          "command.isKeypad",
        ),
        autoRepeat: readNullableBoolean(
          record.autoRepeat ?? null,
          "command.autoRepeat",
        ),
        commands: readNullableStringArray(
          record.commands ?? null,
          "command.commands",
        ),
      };
    case "cdpSetDeviceMetricsOverride":
      return {
        kind: "cdpSetDeviceMetricsOverride",
        width: readFiniteNumber(record.width, "command.width"),
        height: readFiniteNumber(record.height, "command.height"),
        deviceScaleFactor: readFiniteNumber(
          record.deviceScaleFactor,
          "command.deviceScaleFactor",
        ),
        mobile: readBoolean(record.mobile, "command.mobile"),
      };
    case "cdpSetAutoAttach":
      return {
        kind: "cdpSetAutoAttach",
        autoAttach: readBoolean(record.autoAttach, "command.autoAttach"),
        waitForDebuggerOnStart: readBoolean(
          record.waitForDebuggerOnStart,
          "command.waitForDebuggerOnStart",
        ),
      };
    case "cdpDescribeNode":
      return {
        kind: "cdpDescribeNode",
        objectId: readString(record.objectId, "command.objectId"),
        depth: readNullableFiniteNumber(record.depth, "command.depth"),
        pierce: readBoolean(record.pierce, "command.pierce"),
      };
    case "cdpGetFullAXTree":
      return {
        kind: "cdpGetFullAXTree",
        depth: readNullableFiniteNumber(record.depth, "command.depth"),
      };
    default:
      throw new Error(`Unknown browser view CDP command kind: ${kind}`);
  }
}

export function readCdpNullableString(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`Browser view ${field} must be a string or null`);
}

function readScreenshotFormat(value: unknown): "png" | "jpeg" {
  if (value === "png" || value === "jpeg") return value;
  throw new Error("Browser view CDP screenshot format must be png or jpeg");
}

function readMouseEventType(
  value: unknown,
): "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel" {
  if (
    value === "mousePressed" ||
    value === "mouseReleased" ||
    value === "mouseMoved" ||
    value === "mouseWheel"
  ) {
    return value;
  }
  throw new Error("Browser view CDP mouse event type is invalid");
}

function readNullableMouseButton(
  value: unknown,
): "left" | "right" | "middle" | "none" | null {
  if (value === null) return null;
  if (
    value === "left" ||
    value === "right" ||
    value === "middle" ||
    value === "none"
  ) {
    return value;
  }
  throw new Error("Browser view CDP mouse button is invalid");
}

function readKeyEventType(
  value: unknown,
): "keyDown" | "keyUp" | "rawKeyDown" | "char" {
  if (
    value === "keyDown" ||
    value === "keyUp" ||
    value === "rawKeyDown" ||
    value === "char"
  ) {
    return value;
  }
  throw new Error("Browser view CDP key event type is invalid");
}

function readNullableFiniteNumber(
  value: unknown,
  field: string,
): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Browser view ${field} must be a finite number or null`);
}

function readNullableInteger(
  value: unknown,
  field: string,
  nonnegative: boolean,
): number | null {
  if (value === null) return null;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (!nonnegative || value >= 0)
  ) {
    return value;
  }
  throw new Error(
    `Browser view ${field} must be ${nonnegative ? "a nonnegative integer" : "an integer"} or null`,
  );
}

function readNullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  throw new Error(`Browser view ${field} must be a boolean or null`);
}

function readNullableStringArray(
  value: unknown,
  field: string,
): string[] | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error(`Browser view ${field} must be a string array or null`);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be an object`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Browser view ${field} must be a string`);
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Browser view ${field} must be a boolean`);
}

function readFiniteNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Browser view ${field} must be a finite number`);
}
