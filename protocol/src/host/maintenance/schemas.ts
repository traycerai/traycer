import {
  hostInstallRecordSchema,
  hostStagedRecordSchema,
  storedCliInstallManifestSchema,
  // The browser-safe half deliberately: this module is on the RPC registry the
  // renderer imports, and `./installation` also carries the Node-only readers.
} from "@traycer/protocol/config/installation-records";
import { z } from "zod";

const emptyRequestSchema = z.object({});

/**
 * The CLI doctor report is intentionally represented structurally here rather
 * than importing CLI-owned issue-code constants into protocol. That keeps the
 * wire contract stable when the CLI adds a new diagnostic code.
 */
export const hostDoctorIssueSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warning", "error", "fatal"]),
  title: z.string(),
  message: z.string(),
  fixAction: z.string().nullable(),
  terminalCommand: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type HostDoctorIssue = z.infer<typeof hostDoctorIssueSchema>;

export const hostDoctorRequestSchema = emptyRequestSchema;
export type HostDoctorRequest = z.infer<typeof hostDoctorRequestSchema>;

export const hostDoctorResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    issues: z.array(hostDoctorIssueSchema),
    triviallyGreenIssueCodes: z.array(z.string()),
  }),
  z.object({ status: z.literal("cli-unavailable") }),
  z.object({ status: z.literal("cli-failed") }),
  z.object({ status: z.literal("invalid-output") }),
]);
export type HostDoctorResponse = z.infer<typeof hostDoctorResponseSchema>;

/**
 * The host can only caption doctor issues as trivially green when this RPC
 * arrived over a direct local WebSocket. A relay session proves the relay
 * connection, not the daemon's loopback listener or its local CLI state.
 *
 * `SERVICE_STOPPED`, `PORT_UNREACHABLE`, and `PORT_CONFLICT` are local-WS
 * facts: the responding process accepted the loopback connection on its
 * configured endpoint. PID sidecar codes remain meaningful (the listener may
 * have been started outside its service metadata), and the three host-RPC
 * credential/protocol codes remain meaningful because the spawned CLI uses a
 * separate stored bearer and performs its own negotiation.
 */
export type DoctorTransportVantage = "local-ws" | "relay";

export const LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES = [
  "SERVICE_STOPPED",
  "PORT_UNREACHABLE",
  "PORT_CONFLICT",
] as const;

/** No code is universally proven: a relay-served RPC gets this empty set. */
export const RPC_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES = [] as const;

export function doctorTriviallyGreenIssueCodesForVantage(
  vantage: DoctorTransportVantage,
): readonly string[] {
  return vantage === "local-ws"
    ? LOCAL_WS_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES
    : RPC_DOCTOR_TRIVIALLY_GREEN_ISSUE_CODES;
}

/**
 * Only `https:` and `http:`. A download URL is fetched, so leaving it a bare
 * string let a manifest name a `file:` or `javascript:` target that no
 * signature check would ever get to weigh in on.
 */
const httpAssetUrlSchema = z
  .string()
  .refine(
    (value) =>
      URL.canParse(value) &&
      (new URL(value).protocol === "https:" ||
        new URL(value).protocol === "http:"),
    { message: "must be an http(s) URL" },
  );

/**
 * The two arms are genuinely different records, not one record with optional
 * fields.
 *
 * This mirrors what `parsePlatformAsset` in the CLI's own registry parser
 * already enforces: for `available: true` every artifact field must be
 * present and usable - non-empty http(s) URLs, a positive `sizeBytes`, a
 * lowercase 64-char digest - because a partial entry must be published as
 * unavailable rather than half-filled. As one flat object the wire schema
 * accepted exactly the partial entries that parser refuses.
 *
 * That matters here and not only there: this schema validates what a REMOTE
 * host answered, and a remote host is not necessarily running a CLI whose
 * parser is this strict. Both arms keep `unavailableReason` nullable, since
 * an available asset may still carry a note.
 */
const hostPlatformAssetSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    unavailableReason: z.string().nullable(),
    url: httpAssetUrlSchema,
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    signatureUrl: httpAssetUrlSchema,
    signatureAlgorithm: z.literal("minisign"),
    publicKeyId: z.string().min(1),
  }),
  z.object({
    available: z.literal(false),
    unavailableReason: z.string().nullable(),
    // Left wide on purpose: an unavailable platform is published with empty
    // strings and `sizeBytes: 0`, and tightening these would reject the very
    // shape that says "there is no artifact here".
    url: z.string(),
    sizeBytes: z.number().finite(),
    sha256: z.string(),
    signatureUrl: z.string(),
    signatureAlgorithm: z.literal("minisign"),
    publicKeyId: z.string(),
  }),
]);

export const hostAvailableManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  latest: z.string(),
  versions: z.array(
    z.object({
      version: z.string(),
      releasedAt: z.string(),
      releaseNotesUrl: z.string(),
      yanked: z.boolean(),
      deprecationReason: z.string().nullable(),
      requiredCliVersion: z.string().nullable(),
      // The CLI projects this map to its platform before emitting it.
      platforms: z.record(z.string(), hostPlatformAssetSchema),
    }),
  ),
});
export type HostAvailableManifest = z.infer<typeof hostAvailableManifestSchema>;

export const hostUpdateCheckRequestSchema = emptyRequestSchema;
export type HostUpdateCheckRequest = z.infer<
  typeof hostUpdateCheckRequestSchema
>;

export const hostUpdateCheckResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), manifest: hostAvailableManifestSchema }),
  z.object({ outcome: z.literal("cli-unavailable") }),
  z.object({ outcome: z.literal("cli-failed") }),
  z.object({ outcome: z.literal("invalid-output") }),
]);
export type HostUpdateCheckResponse = z.infer<
  typeof hostUpdateCheckResponseSchema
>;

export const hostUpdateInstallRequestSchema = z.object({
  version: z.string().min(1),
  force: z.boolean(),
});
export type HostUpdateInstallRequest = z.infer<
  typeof hostUpdateInstallRequestSchema
>;

export const hostUpdateInstallResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted") }),
  z.object({ outcome: z.literal("externally-managed") }),
  z.object({ outcome: z.literal("cli-unavailable") }),
  z.object({ outcome: z.literal("cli-failed") }),
]);
export type HostUpdateInstallResponse = z.infer<
  typeof hostUpdateInstallResponseSchema
>;

export const hostGetInstallationInfoRequestSchema = emptyRequestSchema;
export type HostGetInstallationInfoRequest = z.infer<
  typeof hostGetInstallationInfoRequestSchema
>;

export const hostGetInstallationInfoResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("unmanaged") }),
    z.object({
      status: z.literal("managed"),
      installRecord: hostInstallRecordSchema,
      stagedRecord: hostStagedRecordSchema.nullable(),
      cliManifest: storedCliInstallManifestSchema.nullable(),
    }),
  ],
);
export type HostGetInstallationInfoResponse = z.infer<
  typeof hostGetInstallationInfoResponseSchema
>;
