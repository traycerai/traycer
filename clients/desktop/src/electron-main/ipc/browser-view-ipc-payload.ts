import { z } from "zod";
import {
  BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS,
  browserSessionsClientFrameSchema,
} from "@traycer/protocol/host/browser/contracts";
import { registrableDomain } from "@traycer/protocol/host/browser/registrable-domain";
import type {
  BrowserAnnotationAttachResultInput,
  BrowserAnnotationSetTargetChatLabelInput,
  BrowserAnnotationStartInput,
} from "../../ipc-contracts/browser-annotation-types";
import { BROWSER_VIEW_VIEWPORT_PRESET_IDS } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserSessionsStreamKey,
  BrowserSessionsStreamSend,
  BrowserViewAttachSurface,
  BrowserViewBoundsUpdate,
  BrowserViewCertificateTrust,
  BrowserViewDetachSurface,
  BrowserViewDownloadCancel,
  BrowserViewElectronTabControl,
  BrowserViewFindRequest,
  BrowserViewFindStop,
  LoginImportRequest,
  BrowserViewOverlayOcclusion,
  BrowserViewOverlayRelease,
  BrowserViewReservedChord,
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
const attachSurfaceSchema: z.ZodType<BrowserViewAttachSurface> =
  nativeTabCapabilitySchema.extend({
    bindingId: nonEmptyStringSchema,
    surface: tileKeySchema,
  });
const detachSurfaceSchema: z.ZodType<BrowserViewDetachSurface> =
  nativeTabCapabilitySchema.extend({ bindingId: nonEmptyStringSchema });
const electronTabControlSchema: z.ZodType<BrowserViewElectronTabControl> =
  nativeTabCapabilitySchema.extend({ action: electronTabControlActionSchema });
const pipCaptureStartSchema: z.ZodType<PipCaptureStartInput> =
  nativeTabCapabilitySchema.extend({
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
    quality: z.number().int().min(0).max(100),
  });

/** The saved-logins toggle's new value. */
const saveLoginsSchema = z.boolean();

/**
 * Which main-owned `browser.sessions` stream a renderer means.
 *
 * A host ID, never a directory row: the row carries the host's static Noise
 * key, and accepting one from a renderer would let a compromised renderer aim
 * main's jar stream at a host it controls. Bounded because every field is
 * echoed into a map key and a log line.
 */
const sessionsStreamKeySchema: z.ZodType<BrowserSessionsStreamKey> =
  z.strictObject({
    epicId: nonEmptyStringSchema.max(128),
    hostId: nonEmptyStringSchema.max(128),
    identityKey: nonEmptyStringSchema.max(512),
  });

/**
 * One user-initiated request onto that stream, parsed against the PROTOCOL's
 * own client-frame schema and then narrowed to the three kinds a renderer may
 * ask for.
 *
 * The narrowing is the gate, not the parse: `forgetLogins` and `clearSite`
 * shred every connected host's slice of the user's logins, so they are
 * produced in main behind its own confirmation and refused here.
 */
const sessionsStreamSendSchema = z
  .strictObject({
    key: sessionsStreamKeySchema,
    frame: browserSessionsClientFrameSchema,
  })
  .refine(
    (value): value is BrowserSessionsStreamSend =>
      UX_CLIENT_FRAME_KINDS.has(value.frame.kind),
    { message: "Only tab requests may be sent from a renderer." },
  );

/** The protocol's own list, so this gate cannot drift from the type it guards. */
const UX_CLIENT_FRAME_KINDS: ReadonlySet<string> = new Set(
  BROWSER_SESSIONS_UX_CLIENT_FRAME_KINDS,
);

/**
 * One saved-login row's domain, as Settings names it.
 *
 * A REGISTRABLE domain and nothing else. It is interpolated into a native
 * confirmation dialog and it is the blast radius of the clear that dialog
 * authorises, so a renderer that could name `x` could write the sentence the
 * user is answering. Anything that does not collapse to itself - a subdomain, a
 * url, a sentence - is refused rather than narrowed, because narrowing would
 * clear a scope the caller did not name.
 */
const savedLoginSiteSchema = z.strictObject({
  domain: nonEmptyStringSchema
    .max(253)
    .refine((domain) => registrableDomain(domain) === domain, {
      message: "A saved-login site is a registrable domain.",
    }),
});

/** A source id the desktop listed for this renderer. */
const loginImportScanSchema = z.object({ sourceId: nonEmptyStringSchema });

/**
 * The import request: registrable domains from the scan's own site list. A
 * ceiling bounds the write; a real jar has a few hundred sites at most.
 */
const LOGIN_IMPORT_MAX_DOMAINS = 5_000;
const loginImportRunSchema: z.ZodType<LoginImportRequest> = z.object({
  sourceId: nonEmptyStringSchema,
  domains: z.array(nonEmptyStringSchema).max(LOGIN_IMPORT_MAX_DOMAINS),
  includeDeviceBound: z.boolean(),
});
export const browserViewIpcPayload = {
  annotationAttachResult: annotationAttachResultSchema,
  annotationStart: annotationStartSchema,
  annotationTargetChatLabel: annotationTargetChatLabelSchema,
  attachSurface: attachSurfaceSchema,
  boundsUpdate: boundsUpdateSchema,
  certificateTrust: certificateTrustSchema,
  detachSurface: detachSurfaceSchema,
  downloadCancel: downloadCancelSchema,
  electronTabControl: electronTabControlSchema,
  findRequest: findRequestSchema,
  findStop: findStopSchema,
  loginImportRun: loginImportRunSchema,
  loginImportScan: loginImportScanSchema,
  nativeTabCapability: nativeTabCapabilitySchema,
  overlayOcclusion: overlayOcclusionSchema,
  overlayPaintAck: overlayPaintAckSchema,
  overlayRelease: overlayReleaseSchema,
  pipCaptureStart: pipCaptureStartSchema,
  savedLoginSite: savedLoginSiteSchema,
  saveLogins: saveLoginsSchema,
  sessionsStreamKey: sessionsStreamKeySchema,
  sessionsStreamSend: sessionsStreamSendSchema,
  tileKey: tileKeySchema,
} as const;

/**
 * Per-ROW catch, deliberately. A newer renderer may list a command this build
 * has never heard of; catching on the ARRAY would discard the whole policy
 * table over that one row and leave every chord unclaimed.
 */
const reservedChordRowSchema = z
  .object({
    token: z.string(),
    command: z
      .union([
        z.literal("closeTab"),
        z.literal("newTab"),
        z.literal("focusAddressBar"),
      ])
      .nullable(),
  })
  .nullable()
  .catch(null);

const reservedChordsSchema = z.object({
  chords: z.array(reservedChordRowSchema).catch([]),
});

export function parseReservedChords(
  payload: unknown,
): readonly BrowserViewReservedChord[] {
  const parsed = reservedChordsSchema.safeParse(payload);
  if (!parsed.success) return [];
  return parsed.data.chords.filter((row) => row !== null);
}
