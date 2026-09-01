import { z } from "zod";
import {
  browserCdpCommandSchema,
  browserCdpTargetSchema,
  browserSessionProfileKindSchema,
  browserStorageCookieSchema,
  browserStorageStateSchema,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartInput,
} from "../../ipc-contracts/browser-annotation-types";
import { BROWSER_VIEW_VIEWPORT_PRESET_IDS } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserViewAttachSurface,
  BrowserViewBoundsUpdate,
  BrowserViewCertificateTrust,
  BrowserViewDetachSurface,
  BrowserViewDownloadCancel,
  BrowserViewElectronTabCdpDispatch,
  BrowserViewElectronTabControl,
  BrowserViewEnsureTab,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayRelease,
} from "@traycer-clients/shared/platform/browser-view";
import type { PipCaptureStartInput } from "@traycer-clients/shared/platform/browser-view";

const nonEmptyStringSchema = z.string().min(1);
const viewportPresetSchema = z.enum(BROWSER_VIEW_VIEWPORT_PRESET_IDS);
const tileKeySchema = z.object({
  viewTabId: nonEmptyStringSchema,
  paneId: nonEmptyStringSchema,
  tileInstanceId: nonEmptyStringSchema,
  pageSessionId: nonEmptyStringSchema,
});
const annotationThemeSchema = z.object({
  appearance: z.enum(["light", "dark"]),
  background: nonEmptyStringSchema,
  foreground: nonEmptyStringSchema,
  popover: nonEmptyStringSchema,
  popoverForeground: nonEmptyStringSchema,
  mutedForeground: nonEmptyStringSchema,
  border: nonEmptyStringSchema,
  input: nonEmptyStringSchema,
  ring: nonEmptyStringSchema,
  primary: nonEmptyStringSchema,
  primaryForeground: nonEmptyStringSchema,
  accent: nonEmptyStringSchema,
  accentForeground: nonEmptyStringSchema,
  destructive: nonEmptyStringSchema,
  warning: nonEmptyStringSchema,
  warningForeground: nonEmptyStringSchema,
  fontFamily: nonEmptyStringSchema,
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

const boundsUpdateSchema: z.ZodType<BrowserViewBoundsUpdate> =
  tileKeySchema.extend({ bounds: boundsSchema });
const annotationStartSchema: z.ZodType<BrowserAnnotationStartInput> =
  tileKeySchema.extend({ theme: annotationThemeSchema });
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
const overlayOcclusionSchema: z.ZodType<BrowserViewOverlayOcclusion> = z.object(
  {
    overlayId: z.string(),
    tiles: z.array(tileKeySchema),
  },
);
const overlayReleaseSchema: z.ZodType<BrowserViewOverlayRelease> = z.object({
  overlayId: z.string(),
});
const overlayPaintAckSchema = z.object({ overlayId: z.string() });
const ensureTabSchema: z.ZodType<BrowserViewEnsureTab> =
  nativeTabKeySchema.extend({
    requestedUrl: nonEmptyStringSchema,
    // The renderer relays the host's frame verbatim; an older renderer that
    // does not know about profiles can only mean the shared jar.
    profile: browserSessionProfileKindSchema.default("primary"),
    seedStorageState: browserStorageStateSchema.nullable().default(null),
  });
const attachSurfaceSchema: z.ZodType<BrowserViewAttachSurface> =
  nativeTabCapabilitySchema.extend({
    bindingId: nonEmptyStringSchema,
    surface: tileKeySchema,
  });
const detachSurfaceSchema: z.ZodType<BrowserViewDetachSurface> =
  nativeTabCapabilitySchema.extend({ bindingId: nonEmptyStringSchema });
const electronTabControlSchema: z.ZodType<BrowserViewElectronTabControl> =
  nativeTabCapabilitySchema.extend({ action: electronTabControlActionSchema });
const electronTabCdpDispatchSchema: z.ZodType<BrowserViewElectronTabCdpDispatch> =
  nativeTabCapabilitySchema.extend({
    target: browserCdpTargetSchema,
    command: browserCdpCommandSchema,
  });
const pipCaptureStartSchema: z.ZodType<PipCaptureStartInput> =
  nativeTabCapabilitySchema.extend({
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    quality: z.number().int().min(0).max(100),
  });

/** Base64 key material crossing the store-key handshake (ticket 05). */
const storeKeyMaterialSchema = z.base64();

/**
 * The registrable domain an evict names (ticket 07). Non-empty only: the scope
 * is what bounds the removal, and an empty one would name the whole jar.
 */
const evictDomainSchema = z.object({ domain: z.string().min(1) });

/**
 * One `primaryProfileObserved` frame on its way to the jar (universal-sign-in
 * ticket 03).
 *
 * `connectionId` and `hostId` name the host stream that delivered it, which the
 * renderer knows and the frame never carries - the rate limiter is keyed by the
 * connection, so an identity taken from the payload would be an identity the
 * sender chose.
 *
 * The cookie array is deliberately NOT bounded here. A schema bound would turn
 * an over-bound frame into a parse failure at the IPC edge, where there is no
 * domain to key a WARN by and no `over-bound` trace to find afterwards; the
 * applier counts and rejects instead (see the bounds' own contract note).
 */
const observedProfileSchema = z.object({
  connectionId: nonEmptyStringSchema,
  hostId: nonEmptyStringSchema,
  domain: nonEmptyStringSchema,
  cookies: z.array(browserStorageCookieSchema),
});

/** The saved-logins toggle's new value. */
const saveLoginsSchema = z.boolean();

export const browserViewIpcPayload = {
  annotationAttachResult: annotationAttachResultSchema,
  annotationStart: annotationStartSchema,
  annotationTargetChatLabel: annotationTargetChatLabelSchema,
  attachSurface: attachSurfaceSchema,
  boundsUpdate: boundsUpdateSchema,
  certificateTrust: certificateTrustSchema,
  detachSurface: detachSurfaceSchema,
  downloadCancel: downloadCancelSchema,
  electronTabCdpDispatch: electronTabCdpDispatchSchema,
  electronTabControl: electronTabControlSchema,
  ensureTab: ensureTabSchema,
  evictDomain: evictDomainSchema,
  findRequest: findRequestSchema,
  findStop: findStopSchema,
  nativeTabCapability: nativeTabCapabilitySchema,
  observedProfile: observedProfileSchema,
  overlayOcclusion: overlayOcclusionSchema,
  overlayPaintAck: overlayPaintAckSchema,
  overlayRelease: overlayReleaseSchema,
  pipCaptureStart: pipCaptureStartSchema,
  saveLogins: saveLoginsSchema,
  storeKeyMaterial: storeKeyMaterialSchema,
  tileKey: tileKeySchema,
} as const;

const reservedChordTokensSchema = z.object({
  tokens: z.array(z.string()).catch([]),
});

export function parseReservedChordTokens(payload: unknown): readonly string[] {
  const parsed = reservedChordTokensSchema.safeParse(payload);
  return parsed.success ? parsed.data.tokens : [];
}
