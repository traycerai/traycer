import { z } from "zod";
import {
  TUI_HARNESS_ID_TO_PROVIDER_ID,
  providerProfileAccentColorSchema,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { composeRequestAbort, untilAborted } from "../auth/request-abort";
import { PATH_ID_PATTERN } from "./path-id";

export type ProfileRecordFailure =
  | { readonly kind: "unauthorized" }
  | (typeof PROFILE_RECORD_ACTION_REFUSALS)[keyof typeof PROFILE_RECORD_ACTION_REFUSALS]["failure"]
  | { readonly kind: "failed" };
export type ProfileRecordFailureKind = ProfileRecordFailure["kind"];

export type ProfileRecordAction = "sign-out" | "remove" | "name";

/** Coded role refusals keep their existing copy; all other refusals use the action's fallback. */
export const PROFILE_RECORD_FAILURE_COPY = {
  unauthorized: "Please sign in again.",
  forbidden: "You don't have permission to do that.",
  action: {
    "sign-out": "Couldn't sign out.",
    remove: "Couldn't remove profile.",
    name: "Couldn't rename profile.",
  },
} as const;

export type ProfileRecordActionFailure = ProfileRecordFailure & {
  readonly message:
    | typeof PROFILE_RECORD_FAILURE_COPY.unauthorized
    | typeof PROFILE_RECORD_FAILURE_COPY.forbidden
    | (typeof PROFILE_RECORD_FAILURE_COPY.action)[ProfileRecordAction];
};

export const PROFILE_RECORD_ACTION_REFUSALS = {
  profile_record_not_found: {
    status: 404,
    failure: { kind: "not-found", code: "profile_record_not_found" },
    messages: PROFILE_RECORD_FAILURE_COPY.action,
  },
  profile_record_alias_ambiguous: {
    status: 409,
    failure: { kind: "ambiguous", code: "profile_record_alias_ambiguous" },
    messages: PROFILE_RECORD_FAILURE_COPY.action,
  },
  environment_action_forbidden: {
    status: 403,
    failure: { kind: "forbidden", code: "environment_action_forbidden" },
    messages: {
      "sign-out": PROFILE_RECORD_FAILURE_COPY.forbidden,
      remove: PROFILE_RECORD_FAILURE_COPY.forbidden,
      name: PROFILE_RECORD_FAILURE_COPY.forbidden,
    },
  },
  environment_not_found: {
    status: 404,
    failure: { kind: "not-found", code: "environment_not_found" },
    messages: PROFILE_RECORD_FAILURE_COPY.action,
  },
  profile_record_action_invalid: {
    status: 400,
    failure: { kind: "invalid", code: "profile_record_action_invalid" },
    messages: PROFILE_RECORD_FAILURE_COPY.action,
  },
} as const;

export function profileRecordActionFailure(
  action: ProfileRecordAction,
  failure: ProfileRecordFailure,
): ProfileRecordActionFailure {
  let message: ProfileRecordActionFailure["message"];
  if (failure.kind === "unauthorized") {
    message = PROFILE_RECORD_FAILURE_COPY.unauthorized;
  } else if (failure.kind === "failed") {
    message = PROFILE_RECORD_FAILURE_COPY.action[action];
  } else {
    message = PROFILE_RECORD_ACTION_REFUSALS[failure.code].messages[action];
  }
  return {
    ...failure,
    message,
  };
}

export interface EnvironmentProfileRecords {
  readonly profileSyncEnabled: boolean;
  readonly providers: readonly {
    readonly providerId: string;
    readonly profiles: readonly ProviderProfile[];
  }[];
}

export type ProfileRecordListResult =
  | { readonly kind: "ok"; readonly list: EnvironmentProfileRecords }
  | ProfileRecordFailure;
export interface ProfileRecordActionSuccess {
  readonly kind: "ok";
  readonly profileId: string;
  readonly harnessId: string;
  readonly recordRevision: string;
}
export type ProfileRecordActionResult =
  | ProfileRecordActionSuccess
  | ProfileRecordActionFailure;
export type ProfileRecordNameResult =
  | (ProfileRecordActionSuccess & { readonly name: string })
  | ProfileRecordActionFailure;

export interface ProfileRecordNameChange {
  readonly profileId: string;
  readonly name: string;
}

/** Implemented by AuthService; a caller never supplies or receives a bearer. */
export interface ProfileRecordClient {
  readProfileRecords(
    environmentId: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordListResult>;
  signOutProfileRecord(
    environmentId: string,
    providerId: string,
    profileId: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordActionResult>;
  removeProfileRecord(
    environmentId: string,
    providerId: string,
    profileId: string,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordActionResult>;
  nameProfileRecord(
    environmentId: string,
    providerId: string,
    change: ProfileRecordNameChange,
    callerSignal: AbortSignal | null,
  ): Promise<ProfileRecordNameResult>;
}

const profileIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const harnessIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const profileNameSchema = z.string().min(1).max(64);
const revisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
// The session wire shape excludes the computer's account key and joining fence.
const recordSchema = z.strictObject({
  profileId: profileIdSchema,
  harnessId: harnessIdSchema,
  name: profileNameSchema,
  color: z.string().max(32).nullable(),
  enabled: z.boolean(),
  kind: z
    .enum([
      "oauth_code",
      "setup_token",
      "device_auth",
      "api_key",
      "grok-oidc",
      "antigravity-google",
    ])
    .nullable(),
  state: z.enum(["live", "signed-out-by-person", "refused-by-provider"]),
  custodyMode: z.enum(["legacy", "owned"]),
  signInNumber: revisionSchema,
  renewalNumber: revisionSchema,
  recordRevision: revisionSchema,
  personIntentNumber: revisionSchema,
  expiresAt: z.number().int().positive().nullable(),
  renewal: z
    .strictObject({
      unsettledSince: z.number().int().positive(),
      standing: z.enum(["settling", "lost"]),
    })
    .nullable(),
  readerLabel: z.enum(["live", "waiting", "needs-sign-in"]),
  otherNames: z.array(profileNameSchema),
});
const removedRecordSchema = z.strictObject({
  profileId: profileIdSchema,
  harnessId: harnessIdSchema,
  removedAt: z.number().int().positive(),
  personIntentNumber: revisionSchema,
});
const recordAliasSchema = z.strictObject({
  harnessId: harnessIdSchema,
  sourceScope: z.union([z.uuid(), z.literal("environment")]),
  oldProfileId: profileIdSchema,
  profileId: profileIdSchema,
});
const providerKeyListRowSchema = z
  .strictObject({
    profileId: profileIdSchema,
    providerId: z.enum([
      "cursor",
      "kiro",
      "droid",
      "openrouter",
      "huggingface",
      "amp",
    ]),
    state: z.enum(["live", "removed"]),
    signInNumber: revisionSchema,
    recordRevision: revisionSchema,
    personIntentNumber: revisionSchema,
    removedAt: z.number().int().positive().nullable(),
  })
  .refine(
    (row) => (row.state === "removed") === (row.removedAt !== null),
    "removedAt is set exactly when removed",
  );
const listSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    environmentRevision: revisionSchema,
    records: z.array(recordSchema),
    removed: z.array(removedRecordSchema),
    aliases: z.array(recordAliasSchema),
    providerKeys: z.array(providerKeyListRowSchema),
  }),
]);
const actionSchema = z.strictObject({
  profileId: profileIdSchema,
  harnessId: harnessIdSchema,
  recordRevision: revisionSchema,
});
const namedSchema = actionSchema.extend({ name: profileNameSchema });
const codedBodySchema = z.strictObject({
  statusCode: z.number().int(),
  error: z.string(),
  code: z.enum([
    "profile_record_not_found",
    "profile_record_alias_ambiguous",
    "environment_action_forbidden",
    "environment_not_found",
    "profile_record_action_invalid",
  ]),
});

interface RecordAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** One direct app-session call. Neither a transport exception nor server text escapes. */
async function callRecord(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  suffix: string,
  body:
    | { readonly harnessId: string }
    | { readonly harnessId: string; readonly name: string }
    | null,
  callerSignal: AbortSignal | null,
): Promise<RecordAnswer | null> {
  if (!PATH_ID_PATTERN.test(environmentId)) return null;
  const abort = composeRequestAbort(callerSignal, 15_000);
  try {
    const base = authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`;
    const url = new URL(
      `api/v3/environments/${encodeURIComponent(environmentId)}/profile-records${suffix}`,
      base,
    );
    const response = await untilAborted(
      fetch(url, {
        method: body === null ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body === null ? null : JSON.stringify(body),
        redirect: "error",
        signal: abort.signal,
      }),
      abort.signal,
    );
    if (response.status === 401) return { status: response.status, body: null };
    const text = await untilAborted(response.text(), abort.signal);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: response.status, body: null };
    }
    return { status: response.status, body: parsed };
  } catch {
    return null;
  } finally {
    abort.clear();
  }
}

function failureResult(answer: RecordAnswer | null): ProfileRecordFailure {
  if (answer === null) return { kind: "failed" };
  if (answer.status === 401) return { kind: "unauthorized" };
  const coded = codedBodySchema.safeParse(answer.body);
  if (!coded.success) return { kind: "failed" };
  const refusal = PROFILE_RECORD_ACTION_REFUSALS[coded.data.code];
  if (
    answer.status !== refusal.status ||
    coded.data.statusCode !== refusal.status
  )
    return { kind: "failed" };
  return refusal.failure;
}

function harnessOf(providerId: string): string {
  return (
    Object.entries(TUI_HARNESS_ID_TO_PROVIDER_ID).find(
      ([, provider]) => provider === providerId,
    )?.[0] ?? providerId
  );
}

/** Standing is computed by the broker, never against the app's clock. */
export async function readProfileRecordsViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordListResult> {
  const answer = await callRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    "",
    null,
    callerSignal,
  );
  if (answer?.status !== 200) return failureResult(answer);
  const parsed = listSchema.safeParse(answer.body);
  if (!parsed.success) return { kind: "failed" };
  if (!parsed.data.enabled)
    return { kind: "ok", list: { profileSyncEnabled: false, providers: [] } };
  const groups = new Map<string, ProviderProfile[]>();
  for (const record of parsed.data.records) {
    const providerId =
      Object.entries(TUI_HARNESS_ID_TO_PROVIDER_ID).find(
        ([harness]) => harness === record.harnessId,
      )?.[1] ?? record.harnessId;
    const profiles = groups.get(providerId) ?? [];
    const color = providerProfileAccentColorSchema.safeParse(record.color);
    profiles.push({
      profileId: record.profileId,
      kind: "managed",
      label: record.name,
      accentColor: color.success ? color.data : null,
      enabled: record.enabled,
      authType: "oauth",
      auth: {
        status:
          record.readerLabel === "needs-sign-in"
            ? "unauthenticated"
            : "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      identity: null,
      usageUpdatedAt: null,
      rateLimitStatus: "unknown",
      rateLimitLimitedScopes: null,
      duplicateOfProfileId: null,
      ambientDriftNotice: null,
      personNotice: record.readerLabel === "live" ? null : record.readerLabel,
      otherNames: record.otherNames,
      ...(record.kind === "api_key"
        ? { apiKey: { supported: false, configured: true } }
        : {}),
    });
    groups.set(providerId, profiles);
  }
  return {
    kind: "ok",
    list: {
      profileSyncEnabled: true,
      providers: [...groups].map(([providerId, profiles]) => ({
        providerId,
        profiles,
      })),
    },
  };
}

export async function signOutProfileRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordActionResult> {
  const answer = await writeRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    providerId,
    profileId,
    "sign-out",
    null,
    callerSignal,
  );
  return actionResult("sign-out", answer, providerId);
}

export async function removeProfileRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordActionResult> {
  const answer = await writeRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    providerId,
    profileId,
    "remove",
    null,
    callerSignal,
  );
  return actionResult("remove", answer, providerId);
}

export async function nameProfileRecordViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  name: string,
  callerSignal: AbortSignal | null,
): Promise<ProfileRecordNameResult> {
  const answer = await writeRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    providerId,
    profileId,
    "name",
    name,
    callerSignal,
  );
  if (answer?.status !== 200)
    return profileRecordActionFailure("name", failureResult(answer));
  const parsed = namedSchema.safeParse(answer.body);
  if (!parsed.success || parsed.data.harnessId !== harnessOf(providerId))
    return profileRecordActionFailure("name", { kind: "failed" });
  return { kind: "ok", ...parsed.data };
}

function actionResult(
  action: "sign-out" | "remove",
  answer: RecordAnswer | null,
  providerId: string,
): ProfileRecordActionResult {
  if (answer?.status !== 200)
    return profileRecordActionFailure(action, failureResult(answer));
  const parsed = actionSchema.safeParse(answer.body);
  if (!parsed.success || parsed.data.harnessId !== harnessOf(providerId))
    return profileRecordActionFailure(action, { kind: "failed" });
  return { kind: "ok", ...parsed.data };
}

async function writeRecord(
  authnBaseUrl: string,
  bearerToken: string,
  environmentId: string,
  providerId: string,
  profileId: string,
  action: ProfileRecordAction,
  name: string | null,
  callerSignal: AbortSignal | null,
): Promise<RecordAnswer | null> {
  if (!profileIdSchema.safeParse(profileId).success) return null;
  const harnessId = harnessOf(providerId);
  return callRecord(
    authnBaseUrl,
    bearerToken,
    environmentId,
    `/${encodeURIComponent(profileId)}/${action}`,
    name === null ? { harnessId } : { harnessId, name },
    callerSignal,
  );
}
