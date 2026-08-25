import { z } from "zod";
import {
  browserCdpCommandSchema,
  browserStorageStateSchema,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSetTargetChatLabelInput,
} from "../../ipc-contracts/browser-annotation-types";
import type {
  BrowserLabsStateUpdate,
  BrowserViewAttachSurface,
  BrowserViewBoundsUpdate,
  BrowserViewCdpDispatch,
  BrowserViewCertificateTrust,
  BrowserViewControlAction,
  BrowserViewControlGrant,
  BrowserViewControlRevoke,
  BrowserViewDetachSurface,
  BrowserViewDownloadCancel,
  BrowserViewElectronTabCdpDispatch,
  BrowserViewElectronTabControl,
  BrowserViewEnsureTab,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayRelease,
  BrowserViewStorageStateApply,
  BrowserViewStorageStateCapture,
  BrowserViewTileUpsert,
  BrowserViewViewportPresetChange,
} from "../../ipc-contracts/browser-view-types";
import type { PipCaptureStartInput } from "../../ipc-contracts/pip-capture-types";

const nonEmptyStringSchema = z.string().min(1);
const viewportPresetSchema = z.enum([
  "responsive",
  "mobile",
  "tablet",
  "desktop",
]);
const tileKeySchema = z.object({
  viewTabId: nonEmptyStringSchema,
  paneId: nonEmptyStringSchema,
  tileInstanceId: nonEmptyStringSchema,
  pageSessionId: nonEmptyStringSchema,
});
const nativeTabKeySchema = z.object({
  hostId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  tabId: nonEmptyStringSchema,
});
const nativeTabCapabilitySchema = nativeTabKeySchema.extend({
  registrationId: nonEmptyStringSchema,
});
const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const userControlActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), selector: z.string() }),
  z.object({
    kind: z.literal("type"),
    selector: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("scroll"),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({ kind: z.literal("navigate"), url: z.string() }),
]);
const electronTabControlActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: nonEmptyStringSchema }),
  z.object({ kind: z.literal("reload") }),
  z.object({ kind: z.literal("goBack") }),
  z.object({ kind: z.literal("goForward") }),
  z.object({
    kind: z.literal("setViewportPreset"),
    viewportPreset: viewportPresetSchema,
  }),
  z.object({ kind: z.literal("zoomIn") }),
  z.object({ kind: z.literal("zoomOut") }),
  z.object({ kind: z.literal("resetZoom") }),
  z.object({ kind: z.literal("openDevTools") }),
]);

const tileUpsertSchema: z.ZodType<BrowserViewTileUpsert> =
  tileKeySchema.extend({
    url: z.string(),
    visible: z.boolean(),
    viewportPreset: viewportPresetSchema,
  });
const boundsUpdateSchema: z.ZodType<BrowserViewBoundsUpdate> =
  tileKeySchema.extend({ bounds: boundsSchema });
const viewportPresetChangeSchema: z.ZodType<BrowserViewViewportPresetChange> =
  tileKeySchema.extend({ viewportPreset: viewportPresetSchema });
const cdpDispatchSchema: z.ZodType<BrowserViewCdpDispatch> =
  tileKeySchema.extend({
    sessionId: z.string().nullable(),
    command: browserCdpCommandSchema,
  });
const annotationTargetChatLabelSchema: z.ZodType<BrowserAnnotationSetTargetChatLabelInput> =
  tileKeySchema.extend({
    targets: z.preprocess(
      (value) => (Array.isArray(value) ? value : []),
      z.array(z.object({ chatId: z.string(), label: z.string() })),
    ),
    defaultChatId: z.string().nullable(),
  });
const annotationAttachResultSchema: z.ZodType<BrowserAnnotationAttachResultInput> =
  z.object({
    annotationId: z.string(),
    status: z.enum(["attached", "failed"]),
  });
const findRequestSchema: z.ZodType<BrowserViewFindRequest> =
  tileKeySchema.extend({
    requestId: z.number(),
    query: z.string(),
    matchCase: z.boolean(),
    forward: z.boolean(),
    findNext: z.boolean(),
  });
const findStopSchema: z.ZodType<BrowserViewFindStop> = tileKeySchema.extend({
  requestId: z.number(),
});
const downloadCancelSchema: z.ZodType<BrowserViewDownloadCancel> = z.object({
  downloadId: z.string(),
});
const certificateTrustSchema: z.ZodType<BrowserViewCertificateTrust> =
  tileKeySchema.extend({ certificateErrorId: z.string() });
const overlayOcclusionSchema: z.ZodType<BrowserViewOverlayOcclusion> =
  z.object({
    overlayId: z.string(),
    tiles: z.array(tileKeySchema),
  });
const overlayReleaseSchema: z.ZodType<BrowserViewOverlayRelease> = z.object({
  overlayId: z.string(),
});
const overlayPaintAckSchema = z.object({ overlayId: z.string() });
const labsStateUpdateSchema: z.ZodType<BrowserLabsStateUpdate> = z.object({
  inAppBrowserBetaEnabled: z.boolean(),
});
const storageStateApplySchema: z.ZodType<BrowserViewStorageStateApply> =
  z.object({
    storageState: browserStorageStateSchema,
    sessionId: z.string().nullable(),
    tabId: z.string().nullable(),
    purpose: z.enum(["primary-profile-seed", "sync-back"]),
  });
const storageStateCaptureSchema: z.ZodType<BrowserViewStorageStateCapture> =
  tileKeySchema.extend({ origin: z.string() });
const controlGrantSchema: z.ZodType<BrowserViewControlGrant> =
  tileKeySchema.extend({
    controlId: z.string(),
    chatId: z.string(),
    agentRunId: z.string().nullable(),
    agentLabel: z.string(),
    origin: z.string(),
    expiresAt: z.number(),
  });
const controlRevokeSchema: z.ZodType<BrowserViewControlRevoke> =
  tileKeySchema.extend({ controlId: z.string(), reason: z.string() });
const controlActionSchema: z.ZodType<BrowserViewControlAction> =
  tileKeySchema.extend({
    controlId: z.string(),
    actionId: z.string(),
    sensitiveApprovalId: z.string().nullable(),
    action: userControlActionSchema,
  });
const ensureTabSchema: z.ZodType<BrowserViewEnsureTab> =
  nativeTabKeySchema.extend({
    requestedUrl: nonEmptyStringSchema,
    seedStorageState: browserStorageStateSchema.nullable().default(null),
  });
const attachSurfaceSchema: z.ZodType<BrowserViewAttachSurface> =
  nativeTabCapabilitySchema.extend({
    bindingId: nonEmptyStringSchema,
    surface: tileKeySchema,
    visible: z.boolean(),
  });
const detachSurfaceSchema: z.ZodType<BrowserViewDetachSurface> =
  nativeTabCapabilitySchema.extend({ bindingId: nonEmptyStringSchema });
const electronTabControlSchema: z.ZodType<BrowserViewElectronTabControl> =
  nativeTabCapabilitySchema.extend({ action: electronTabControlActionSchema });
const electronTabCdpDispatchSchema: z.ZodType<BrowserViewElectronTabCdpDispatch> =
  nativeTabCapabilitySchema.extend({
    cdpSessionId: nonEmptyStringSchema.nullable(),
    command: browserCdpCommandSchema,
  });
const pipCaptureStartSchema: z.ZodType<PipCaptureStartInput> =
  nativeTabCapabilitySchema.extend({
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    quality: z.number().int().min(0).max(100),
  });

export const browserViewIpcPayload = {
  annotationAttachResult: annotationAttachResultSchema,
  annotationTargetChatLabel: annotationTargetChatLabelSchema,
  attachSurface: attachSurfaceSchema,
  boundsUpdate: boundsUpdateSchema,
  cdpCommand: browserCdpCommandSchema,
  cdpDispatch: cdpDispatchSchema,
  certificateTrust: certificateTrustSchema,
  controlAction: controlActionSchema,
  controlGrant: controlGrantSchema,
  controlRevoke: controlRevokeSchema,
  detachSurface: detachSurfaceSchema,
  downloadCancel: downloadCancelSchema,
  electronTabCdpDispatch: electronTabCdpDispatchSchema,
  electronTabControl: electronTabControlSchema,
  ensureTab: ensureTabSchema,
  findRequest: findRequestSchema,
  findStop: findStopSchema,
  labsStateUpdate: labsStateUpdateSchema,
  nativeTabCapability: nativeTabCapabilitySchema,
  overlayOcclusion: overlayOcclusionSchema,
  overlayPaintAck: overlayPaintAckSchema,
  overlayRelease: overlayReleaseSchema,
  pipCaptureStart: pipCaptureStartSchema,
  storageStateApply: storageStateApplySchema,
  storageStateCapture: storageStateCaptureSchema,
  tileKey: tileKeySchema,
  tileUpsert: tileUpsertSchema,
  viewportPresetChange: viewportPresetChangeSchema,
} as const;

const reservedChordTokensSchema = z.object({
  tokens: z.array(z.string()).catch([]),
});

export function parseReservedChordTokens(payload: unknown): readonly string[] {
  const parsed = reservedChordTokensSchema.safeParse(payload);
  return parsed.success ? parsed.data.tokens : [];
}
