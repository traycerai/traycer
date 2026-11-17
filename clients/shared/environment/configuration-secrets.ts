// The app's own calls to authn's environment secret routes, on the person's sign-in.
// No value or body is kept or logged; a refusal's message never carries the
// request's bearer or a secret value.
import { z } from "zod";
import { environmentChangedBySchema } from "@traycer/protocol/framework/environment-stale-write";
import {
  environmentSecretsConsentResponseSchema,
  environmentSecretsDestroyResponseSchema,
  environmentSecretsDestroyResponseSchemaV11,
  environmentSecretsListResponseSchemaV12,
  environmentSecretsRotationResponseSchema,
  environmentSecretsUndoResponseSchema,
  environmentSecretsVerifyResponseSchema,
  environmentSecretsVersionsResponseSchemaV11,
  type EnvironmentSecret,
  type EnvironmentSecretV12,
  type EnvironmentSecretsConsentRequestV11,
  type EnvironmentSecretsConsentResponse,
  type EnvironmentSecretsCreateRequestV11,
  type EnvironmentSecretsCreateResponse,
  type EnvironmentSecretsDestroyRequestV11,
  type EnvironmentSecretsDestroyResponseV11,
  type EnvironmentSecretsListResponseV12,
  type EnvironmentSecretsReplaceValueRequestV11,
  type EnvironmentSecretsReplaceValueResponse,
  type EnvironmentSecretsRotationRequestV11,
  type EnvironmentSecretsRotationResponse,
  type EnvironmentSecretsUndoRequestV11,
  type EnvironmentSecretsUndoResponse,
  type EnvironmentSecretsVerifyRequestV11,
  type EnvironmentSecretsVerifyResponse,
  type EnvironmentSecretsVersionsRequestV11,
  type EnvironmentSecretsVersionsResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_CREATE_FIELDS,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";
import { SANDBOX_PLAINTEXT_DISCLOSURE_VERSION } from "@traycer/protocol/host/secret-intake-catalogue";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  SECRETS_LIST_INCLUDES,
  authnSecretRowSchema,
  authnSecretsListSchema,
  type AuthnSecretRow,
} from "./authn-environment-schemas";
import {
  CLOUD_UNAVAILABLE_MESSAGE,
  EnvironmentCloudError,
  SIGN_IN_AGAIN_MESSAGE,
  environmentPath,
  errorBodyCode,
  isCloudFailure,
  isSuccess,
  sendEnvironmentRequestWithBearer,
  type EnvironmentAnswer,
  type EnvironmentCloud,
  type EnvironmentHttpMethod,
} from "./environment-cloud";

/** The app's authn create never queues a host upload. */
export type AuthnSecretsCreateResponse = Exclude<
  EnvironmentSecretsCreateResponse,
  { readonly outcome: "pending" }
>;

export type AuthnSecretsReplaceValueResponse = Exclude<
  EnvironmentSecretsReplaceValueResponse,
  { readonly outcome: "pending" }
>;

const CONSENT_NOT_OFFERED = "This consent is not offered.";
const REFUSED = "Your environment did not accept this change.";
const MAX_MESSAGE_LENGTH = 300;

const authnCreateSchema = lazySchema(() =>
  z.object({ secret: authnSecretRowSchema }),
);
const authnPatchSchema = lazySchema(() =>
  z.object({
    rotation: z
      .object({
        rotationId: z.string().min(1),
        versionId: z.string().min(1),
      })
      .nullable(),
  }),
);
const authnStaleSchema = lazySchema(() =>
  z.object({
    code: z.literal("secret_version_stale"),
    currentVersionId: z.string().min(1),
    changedBy: environmentChangedBySchema,
  }),
);

/**
 * `revoked` is false: authn lists live secrets only. Retired fields a released
 * desktop still requires are filled here.
 */
function secretOf(row: AuthnSecretRow): EnvironmentSecret {
  return {
    secretId: row.id,
    name: row.name,
    kind: row.kind,
    protocol: row.protocol,
    destinations: row.hosts,
    ...RETIRED_SECRET_ROW_FIELDS,
    currentVersionId: row.currentVersionId,
    revoked: false,
    updatedAt: row.updatedAt,
  };
}

function listRowOf(row: AuthnSecretRow): EnvironmentSecretV12 {
  return {
    ...secretOf(row),
    variables: row.variables.map((variable) => variable.name),
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
  };
}

function authnTextOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  if ("error" in body && typeof body.error === "string") return body.error;
  if ("message" in body && typeof body.message === "string")
    return body.message;
  return null;
}

/**
 * Bounded and printable; the generic words when there is none or it holds any of
 * `withheld` (this request's bearer, a secret value it sent). It reaches the
 * person and the app's log.
 */
export function refusalMessageWithout(
  body: unknown,
  withheld: readonly string[],
): string {
  const text = authnTextOf(body);
  if (text === null) return REFUSED;
  const holdsWithheld = withheld.some(
    (value) => value.length > 0 && text.includes(value),
  );
  if (holdsWithheld) return REFUSED;
  const printable = text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
  if (printable.length === 0) return REFUSED;
  return printable.length > MAX_MESSAGE_LENGTH
    ? `${printable.slice(0, MAX_MESSAGE_LENGTH)}…`
    : printable;
}

function createBodyOf(
  request: EnvironmentSecretsCreateRequestV11,
): Record<string, unknown> {
  // Retired: authn's strict schema has no column for either.
  const {
    plaintextConsent,
    environmentId: _environmentId,
    mode: _mode,
    exportPolicy: _exportPolicy,
    ...rest
  } = request;
  return { ...rest, plaintextConsent: plaintextConsent !== null };
}

interface SecretsAnswer extends EnvironmentAnswer {
  readonly withheld: readonly string[];
}

async function send(
  cloud: EnvironmentCloud,
  environmentId: string,
  method: EnvironmentHttpMethod,
  suffix: string,
  body: unknown,
  secretValue: string | null,
): Promise<SecretsAnswer> {
  const sent = await sendEnvironmentRequestWithBearer(
    cloud,
    "secrets",
    method,
    `${environmentPath(environmentId)}/secrets${suffix}`,
    body,
  );
  return {
    ...sent.answer,
    withheld: secretValue === null ? [sent.bearer] : [sent.bearer, secretValue],
  };
}

function refusal(answer: SecretsAnswer): EnvironmentCloudError {
  if (answer.status === 401) {
    return new EnvironmentCloudError(
      "unauthorized",
      SIGN_IN_AGAIN_MESSAGE.secrets,
    );
  }
  if (isCloudFailure(answer))
    return new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
  return new EnvironmentCloudError(
    "invalid",
    refusalMessageWithout(answer.body, answer.withheld),
  );
}

function unreadable(): EnvironmentCloudError {
  return new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
}

function answerAs<T>(answer: SecretsAnswer, schema: z.ZodType<T>): T {
  if (!isSuccess(answer)) throw refusal(answer);
  const parsed = schema.safeParse(answer.body);
  if (!parsed.success) throw unreadable();
  return parsed.data;
}

const id = (value: string): string => `/${encodeURIComponent(value)}`;

export async function listSecrets(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentSecretsListResponseV12> {
  const answer = await send(
    cloud,
    environmentId,
    "GET",
    `?include=${SECRETS_LIST_INCLUDES.join(",")}`,
    null,
    null,
  );
  const list = answerAs(answer, authnSecretsListSchema);
  const result = environmentSecretsListResponseSchemaV12.safeParse({
    secrets: list.secrets.map(listRowOf),
    removed: list.removed,
  });
  if (!result.success) throw unreadable();
  return result.data;
}

export async function createSecret(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsCreateRequestV11,
): Promise<AuthnSecretsCreateResponse> {
  if (
    request.mode !== RETIRED_SECRET_CREATE_FIELDS.mode ||
    request.exportPolicy !== RETIRED_SECRET_CREATE_FIELDS.exportPolicy
  ) {
    return { outcome: "refused", code: "plane_removed" };
  }
  // authn records the acceptance at its own disclosure version: a different version
  // shown here is not recorded.
  if (
    request.plaintextConsent !== null &&
    request.plaintextConsent.disclosureVersion !==
      SANDBOX_PLAINTEXT_DISCLOSURE_VERSION
  ) {
    throw new EnvironmentCloudError("invalid", CONSENT_NOT_OFFERED);
  }
  const answer = await send(
    cloud,
    environmentId,
    "POST",
    "",
    createBodyOf(request),
    request.value,
  );
  // A server address with no address of its own: the screen names what was typed.
  if (
    answer.status === 422 &&
    errorBodyCode(answer.body) === "destination_unresolvable"
  )
    return { outcome: "refused", code: "destination_unresolvable" };
  const created = answerAs(answer, authnCreateSchema);
  return { outcome: "created", secret: secretOf(created.secret) };
}

export async function verifySecret(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsVerifyRequestV11,
): Promise<EnvironmentSecretsVerifyResponse> {
  let answer: SecretsAnswer;
  if (request.target === "secret") {
    answer = await send(
      cloud,
      environmentId,
      "POST",
      `${id(request.secretId)}/verify`,
      {},
      null,
    );
  } else {
    // authn's candidate body is strict: every binding field, no `target`.
    answer = await send(
      cloud,
      environmentId,
      "POST",
      "/verify",
      {
        kind: request.kind,
        protocol: request.protocol,
        hosts: request.hosts,
        port: request.port,
        identity: request.identity,
        database: request.database,
        policy: request.policy,
        tlsPolicy: request.tlsPolicy,
        pinnedHostKeys: request.pinnedHostKeys,
        connectorId: request.connectorId,
        confirmedAddresses: request.confirmedAddresses,
        value: request.value,
      },
      request.value,
    );
  }
  return answerAs(answer, environmentSecretsVerifyResponseSchema);
}

export async function replaceSecretValue(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsReplaceValueRequestV11,
): Promise<AuthnSecretsReplaceValueResponse> {
  const answer = await send(
    cloud,
    environmentId,
    "PATCH",
    id(request.secretId),
    { value: request.value, expectedVersionId: request.expectedVersionId },
    request.value,
  );
  if (answer.status === 409) {
    const stale = authnStaleSchema.safeParse(answer.body);
    if (stale.success) {
      return {
        outcome: "stale",
        currentVersionId: stale.data.currentVersionId,
        changedBy: stale.data.changedBy,
      };
    }
  }
  const patched = answerAs(answer, authnPatchSchema);
  if (patched.rotation === null) throw unreadable();
  return {
    outcome: "accepted",
    rotationId: patched.rotation.rotationId,
    versionId: patched.rotation.versionId,
  };
}

export async function readSecretVersions(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsVersionsRequestV11,
): Promise<EnvironmentSecretsVersionsResponseV11> {
  return answerAs(
    await send(
      cloud,
      environmentId,
      "GET",
      `${id(request.secretId)}/versions`,
      null,
      null,
    ),
    environmentSecretsVersionsResponseSchemaV11,
  );
}

export async function undoSecretVersion(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsUndoRequestV11,
): Promise<EnvironmentSecretsUndoResponse> {
  return answerAs(
    await send(
      cloud,
      environmentId,
      "POST",
      `${id(request.secretId)}/versions${id(request.versionId)}/undo`,
      { regrant: request.regrant },
      null,
    ),
    environmentSecretsUndoResponseSchema,
  );
}

/** `allowCurrent` lets the removal take the current version; the answer's shape follows it. */
export async function destroySecretVersion(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsDestroyRequestV11,
  allowCurrent: boolean,
): Promise<EnvironmentSecretsDestroyResponseV11> {
  const answer = await send(
    cloud,
    environmentId,
    "POST",
    `${id(request.secretId)}/versions${id(request.versionId)}/destroy`,
    { allowCurrent },
    null,
  );
  return allowCurrent
    ? answerAs(answer, environmentSecretsDestroyResponseSchemaV11)
    : answerAs(answer, environmentSecretsDestroyResponseSchema);
}

export async function readSecretRotation(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsRotationRequestV11,
): Promise<EnvironmentSecretsRotationResponse> {
  return answerAs(
    await send(
      cloud,
      environmentId,
      "GET",
      `${id(request.secretId)}/rotation`,
      null,
      null,
    ),
    environmentSecretsRotationResponseSchema,
  );
}

export async function consentToSecret(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsConsentRequestV11,
): Promise<EnvironmentSecretsConsentResponse> {
  // The consent route records the disclosure for one secret and nothing else.
  if (
    request.disclosure !== "plaintext_gateway" ||
    request.scope !== "secret"
  ) {
    throw new EnvironmentCloudError("invalid", CONSENT_NOT_OFFERED);
  }
  return answerAs(
    await send(
      cloud,
      environmentId,
      "POST",
      `${id(request.secretId)}/consent`,
      { disclosureVersion: request.disclosureVersion },
      null,
    ),
    environmentSecretsConsentResponseSchema,
  );
}
