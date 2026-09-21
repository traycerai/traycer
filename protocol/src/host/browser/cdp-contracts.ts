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
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

const browserCdpErrorSchema = lazySchema(() =>
  z
    .object({
      kind: z.enum(["not_attached", "tab_not_found", "cdp_error"]),
      message: z.string(),
      code: z.number().nullable(),
    })
    .strict(),
);
export type BrowserCdpError = z.infer<typeof browserCdpErrorSchema>;

const browserCdpFrameInfoSchema = lazySchema(() =>
  z
    .object({
      frameId: z.string(),
      parentFrameId: z.string().nullable(),
      url: z.string(),
    })
    .strict(),
);
export type BrowserCdpFrameInfo = z.infer<typeof browserCdpFrameInfoSchema>;

/** Logical page target. Native CDP session ids never cross the host wire. */
export const browserCdpTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("root") }).strict(),
    z
      .object({
        kind: z.literal("frame"),
        frameId: z.string(),
        parentFrameId: z.string(),
      })
      .strict(),
  ]),
);
export type BrowserCdpTarget = z.infer<typeof browserCdpTargetSchema>;

const cdpNavigateCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpNavigate"),
      url: z.string().min(1),
    })
    .strict(),
);
const cdpCaptureScreenshotCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpCaptureScreenshot"),
      format: z.enum(["png", "jpeg"]),
      quality: z.number().int().min(0).max(100).nullable(),
    })
    .strict(),
);
const cdpGetFrameTreeCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpGetFrameTree"),
    })
    .strict(),
);
const cdpCreateIsolatedWorldCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpCreateIsolatedWorld"),
      frameId: z.string(),
      worldName: z.string(),
      grantUniversalAccess: z.boolean(),
    })
    .strict(),
);
const cdpEvaluateCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpEvaluate"),
      expression: z.string(),
      awaitPromise: z.boolean(),
      returnByValue: z.boolean(),
      // Targets the isolated world from `cdpCreateIsolatedWorld`; null evaluates
      // in the page's main world (CDP's own default when omitted).
      contextId: z.number().int().nullable(),
    })
    .strict(),
);
const cdpCallFunctionOnCommandSchema = lazySchema(() =>
  z
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
    .strict(),
);
const cdpReleaseObjectCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpReleaseObject"),
      objectId: z.string(),
    })
    .strict(),
);
const cdpDispatchMouseEventCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpDispatchMouseEvent"),
      type: z.enum([
        "mousePressed",
        "mouseReleased",
        "mouseMoved",
        "mouseWheel",
      ]),
      x: z.number(),
      y: z.number(),
      button: z.enum(["left", "right", "middle", "none"]).nullable(),
      clickCount: z.number().int().nonnegative().nullable(),
      deltaX: z.number().nullable(),
      deltaY: z.number().nullable(),
    })
    .strict(),
);
const cdpInsertTextCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpInsertText"),
      text: z.string(),
    })
    .strict(),
);
const cdpDispatchKeyEventCommandSchema = lazySchema(() =>
  z
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
    .strict(),
);
const cdpSetDeviceMetricsOverrideCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpSetDeviceMetricsOverride"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      deviceScaleFactor: z.number().positive(),
      mobile: z.boolean(),
    })
    .strict(),
);
const cdpDescribeNodeCommandSchema = lazySchema(() =>
  z
    .object({
      kind: z.literal("cdpDescribeNode"),
      objectId: z.string(),
      depth: z.number().int().nullable(),
      pierce: z.boolean(),
    })
    .strict(),
);

/** Address-free CDP vocabulary shared by every browser runtime. */
export const browserCdpCommandSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
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
  ]),
);
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
const browserCdpCommandKindSchema = lazySchema(() =>
  z.enum(
    browserCdpCommandSchema.def.options.map(
      (option): BrowserCdpCommand["kind"] => option.shape.kind.def.values[0],
    ),
  ),
);

/**
 * A returned JavaScript value. CDP distinguishes an absent `RemoteObject.value`
 * (JavaScript `undefined`) from a present JSON `null`; the wire must preserve
 * that distinction instead of using `null` as an absence sentinel.
 */
export const browserCdpValueSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("json"), value: z.json() }).strict(),
    z.object({ kind: z.literal("undefined") }).strict(),
  ]),
);

const browserCdpSuccessResultSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
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
    z
      .object({ kind: z.literal("cdpInsertText"), ok: z.literal(true) })
      .strict(),
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
  ]),
);

export const browserCdpResultSchema = lazySchema(() =>
  z.union([
    browserCdpSuccessResultSchema,
    z
      .object({
        kind: browserCdpCommandKindSchema,
        ok: z.literal(false),
        error: browserCdpErrorSchema,
      })
      .strict(),
  ]),
);
export type BrowserCdpResult = z.infer<typeof browserCdpResultSchema>;
