/**
 * Curated CDP vocabulary carried by the Electron-tab transport.
 *
 * Address-free on purpose: a command names what to do, never which native
 * session does it. `contracts.ts` wraps these in the `browser.sessions` frames
 * that carry the addressing, and `cdp-dispatch.ts` turns one command into one
 * raw CDP call. Re-exported from `contracts.ts`, so consumers keep importing
 * the whole browser vocabulary from one path.
 */
import { z } from "zod";

const browserCdpErrorSchema = z
  .object({
    kind: z.enum(["not_attached", "tab_not_found", "cdp_error"]),
    message: z.string(),
    code: z.number().nullable(),
  })
  .strict();
export type BrowserCdpError = z.infer<typeof browserCdpErrorSchema>;

const browserCdpFrameInfoSchema = z
  .object({
    frameId: z.string(),
    parentFrameId: z.string().nullable(),
    url: z.string(),
  })
  .strict();
export type BrowserCdpFrameInfo = z.infer<typeof browserCdpFrameInfoSchema>;

/** Logical page target. Native CDP session ids never cross the host wire. */
export const browserCdpTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }).strict(),
  z
    .object({
      kind: z.literal("frame"),
      frameId: z.string(),
      parentFrameId: z.string(),
    })
    .strict(),
]);
export type BrowserCdpTarget = z.infer<typeof browserCdpTargetSchema>;

const cdpNavigateCommandSchema = z
  .object({
    kind: z.literal("cdpNavigate"),
    url: z.string().min(1),
  })
  .strict();
const cdpCaptureScreenshotCommandSchema = z
  .object({
    kind: z.literal("cdpCaptureScreenshot"),
    format: z.enum(["png", "jpeg"]),
    quality: z.number().int().min(0).max(100).nullable(),
  })
  .strict();
const cdpGetFrameTreeCommandSchema = z
  .object({
    kind: z.literal("cdpGetFrameTree"),
  })
  .strict();
const cdpCreateIsolatedWorldCommandSchema = z
  .object({
    kind: z.literal("cdpCreateIsolatedWorld"),
    frameId: z.string(),
    worldName: z.string(),
    grantUniversalAccess: z.boolean(),
  })
  .strict();
const cdpEvaluateCommandSchema = z
  .object({
    kind: z.literal("cdpEvaluate"),
    expression: z.string(),
    awaitPromise: z.boolean(),
    returnByValue: z.boolean(),
    // Targets the isolated world from `cdpCreateIsolatedWorld`; null evaluates
    // in the page's main world (CDP's own default when omitted).
    contextId: z.number().int().nullable(),
  })
  .strict();
const cdpCallFunctionOnCommandSchema = z
  .object({
    kind: z.literal("cdpCallFunctionOn"),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("object"), objectId: z.string() }).strict(),
      z
        .object({
          kind: z.literal("context"),
          executionContextId: z.number().int(),
        })
        .strict(),
    ]),
    functionDeclaration: z.string(),
    arguments: z.array(z.object({ value: z.json() }).strict()).nullable(),
    returnByValue: z.boolean(),
  })
  .strict();
const cdpReleaseObjectCommandSchema = z
  .object({
    kind: z.literal("cdpReleaseObject"),
    objectId: z.string(),
  })
  .strict();
const cdpDispatchMouseEventCommandSchema = z
  .object({
    kind: z.literal("cdpDispatchMouseEvent"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["left", "right", "middle", "none"]).nullable(),
    clickCount: z.number().int().nonnegative().nullable(),
    deltaX: z.number().nullable(),
    deltaY: z.number().nullable(),
  })
  .strict();
const cdpInsertTextCommandSchema = z
  .object({
    kind: z.literal("cdpInsertText"),
    text: z.string(),
  })
  .strict();
const cdpDispatchKeyEventCommandSchema = z
  .object({
    kind: z.literal("cdpDispatchKeyEvent"),
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string().nullable(),
    code: z.string().nullable(),
    text: z.string().nullable(),
    // Defaulted rather than merely nullable: a caller that omits one of these
    // means "let CDP decide", which dispatch encodes by omitting the param.
    modifiers: z.number().int().nullable().default(null),
    unmodifiedText: z.string().nullable().default(null),
    windowsVirtualKeyCode: z.number().int().nullable().default(null),
    location: z.number().int().nonnegative().nullable().default(null),
    isKeypad: z.boolean().nullable().default(null),
    autoRepeat: z.boolean().nullable().default(null),
    commands: z.array(z.string()).nullable().default(null),
  })
  .strict();
const cdpSetDeviceMetricsOverrideCommandSchema = z
  .object({
    kind: z.literal("cdpSetDeviceMetricsOverride"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
    mobile: z.boolean(),
  })
  .strict();
/**
 * rrweb's injection pair (D17). `addScriptToEvaluateOnNewDocument` is what
 * makes a recording survive navigation: the script is re-installed by the
 * browser on every new document, so the recorder does not have to notice and
 * re-inject after each one.
 *
 * `worldName` is REQUIRED and PINNED HOST-SIDE - the caller of this curated
 * vocabulary is the host's recording controller, never the desktop, which
 * relays the command it is handed. Naming a world keeps the recorder out of the
 * page's main world, so the page cannot read, patch or throw from the
 * recorder's globals, and the recorder cannot collide with the page's. It is
 * not optional because the main world is the wrong answer, not a default: an
 * omitted `worldName` is exactly the injection this pair exists to avoid.
 */
const cdpAddScriptToEvaluateOnNewDocumentCommandSchema = z
  .object({
    kind: z.literal("cdpAddScriptToEvaluateOnNewDocument"),
    source: z.string(),
    worldName: z.string().min(1),
  })
  .strict();
/** Removal by the identifier the add returned. Injection ends with the run. */
const cdpRemoveScriptToEvaluateOnNewDocumentCommandSchema = z
  .object({
    kind: z.literal("cdpRemoveScriptToEvaluateOnNewDocument"),
    identifier: z.string(),
  })
  .strict();
const cdpDescribeNodeCommandSchema = z
  .object({
    kind: z.literal("cdpDescribeNode"),
    objectId: z.string(),
    depth: z.number().int().nullable(),
    pierce: z.boolean(),
  })
  .strict();

/** Address-free CDP vocabulary shared by every browser runtime. */
export const browserCdpCommandSchema = z.discriminatedUnion("kind", [
  cdpNavigateCommandSchema,
  cdpCaptureScreenshotCommandSchema,
  cdpGetFrameTreeCommandSchema,
  cdpCreateIsolatedWorldCommandSchema,
  cdpEvaluateCommandSchema,
  cdpCallFunctionOnCommandSchema,
  cdpReleaseObjectCommandSchema,
  cdpDispatchMouseEventCommandSchema,
  cdpInsertTextCommandSchema,
  cdpDispatchKeyEventCommandSchema,
  cdpSetDeviceMetricsOverrideCommandSchema,
  cdpDescribeNodeCommandSchema,
  cdpAddScriptToEvaluateOnNewDocumentCommandSchema,
  cdpRemoveScriptToEvaluateOnNewDocumentCommandSchema,
]);
export type BrowserCdpCommand = z.infer<typeof browserCdpCommandSchema>;

/**
 * The curated vocabulary's only per-command datum beyond its params schema.
 * Keyed by `BrowserCdpCommand["kind"]`, so a new command variant is a compile
 * error until its method lands here, and `dispatchCuratedCdp` reads the method
 * it sends from nowhere else.
 */
export const CURATED_CDP_METHOD_BY_KIND = {
  cdpNavigate: "Page.navigate",
  cdpCaptureScreenshot: "Page.captureScreenshot",
  cdpGetFrameTree: "Page.getFrameTree",
  cdpCreateIsolatedWorld: "Page.createIsolatedWorld",
  cdpEvaluate: "Runtime.evaluate",
  cdpCallFunctionOn: "Runtime.callFunctionOn",
  cdpReleaseObject: "Runtime.releaseObject",
  cdpDispatchMouseEvent: "Input.dispatchMouseEvent",
  cdpInsertText: "Input.insertText",
  cdpDispatchKeyEvent: "Input.dispatchKeyEvent",
  cdpSetDeviceMetricsOverride: "Emulation.setDeviceMetricsOverride",
  cdpDescribeNode: "DOM.describeNode",
  cdpAddScriptToEvaluateOnNewDocument: "Page.addScriptToEvaluateOnNewDocument",
  cdpRemoveScriptToEvaluateOnNewDocument:
    "Page.removeScriptToEvaluateOnNewDocument",
} as const satisfies Record<BrowserCdpCommand["kind"], string>;

export type CuratedCdpMethod =
  (typeof CURATED_CDP_METHOD_BY_KIND)[keyof typeof CURATED_CDP_METHOD_BY_KIND];

export const CURATED_CDP_METHODS: readonly CuratedCdpMethod[] = Object.values(
  CURATED_CDP_METHOD_BY_KIND,
);

/**
 * Derived from the command union rather than hand-listed: a hand-written array
 * would only be `satisfies`-checked as a subset, so a thirteenth command could
 * ship with the failure arm silently rejecting its errors.
 */
const browserCdpCommandKindSchema = z.enum(
  browserCdpCommandSchema.def.options.map(
    (option): BrowserCdpCommand["kind"] => option.shape.kind.def.values[0],
  ),
);

/**
 * A returned JavaScript value. CDP distinguishes an absent `RemoteObject.value`
 * (JavaScript `undefined`) from a present JSON `null`; the wire must preserve
 * that distinction instead of using `null` as an absence sentinel.
 */
export const browserCdpValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.json() }).strict(),
  z.object({ kind: z.literal("undefined") }).strict(),
]);

const browserCdpSuccessResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cdpNavigate"),
      ok: z.literal(true),
      errorText: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpCaptureScreenshot"),
      ok: z.literal(true),
      dataBase64: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpGetFrameTree"),
      ok: z.literal(true),
      frames: z.array(browserCdpFrameInfoSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpCreateIsolatedWorld"),
      ok: z.literal(true),
      executionContextId: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpEvaluate"),
      ok: z.literal(true),
      value: browserCdpValueSchema,
      objectId: z.string().nullable(),
      exceptionDescription: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpCallFunctionOn"),
      ok: z.literal(true),
      value: browserCdpValueSchema,
      objectId: z.string().nullable(),
      exceptionDescription: z.string().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("cdpReleaseObject"), ok: z.literal(true) })
    .strict(),
  z
    .object({ kind: z.literal("cdpDispatchMouseEvent"), ok: z.literal(true) })
    .strict(),
  z.object({ kind: z.literal("cdpInsertText"), ok: z.literal(true) }).strict(),
  z
    .object({ kind: z.literal("cdpDispatchKeyEvent"), ok: z.literal(true) })
    .strict(),
  z
    .object({
      kind: z.literal("cdpSetDeviceMetricsOverride"),
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpDescribeNode"),
      ok: z.literal(true),
      frameId: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      // The handle the removal takes. Narrowed off the raw reply the same way
      // `Page.captureScreenshot`'s `data` is: a missing or non-string
      // `identifier` is a malformed response, not an empty string, because a
      // recorder that "removed" a script it never identified would leave rrweb
      // injected into every future document of that tab.
      kind: z.literal("cdpAddScriptToEvaluateOnNewDocument"),
      ok: z.literal(true),
      identifier: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cdpRemoveScriptToEvaluateOnNewDocument"),
      ok: z.literal(true),
    })
    .strict(),
]);

export const browserCdpResultSchema = z.union([
  browserCdpSuccessResultSchema,
  z
    .object({
      kind: browserCdpCommandKindSchema,
      ok: z.literal(false),
      error: browserCdpErrorSchema,
    })
    .strict(),
]);
export type BrowserCdpResult = z.infer<typeof browserCdpResultSchema>;
