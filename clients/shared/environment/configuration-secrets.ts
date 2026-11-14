/**
 * The `environment.secrets.*` methods (Settings ▸ Secrets) as the app's own
 * calls to authn's environment secret routes, on the person's sign-in. Each
 * function answers what the host's and the pool's forwarder answered for the
 * same method (`packages/common/src/environments/configuration-forwarding/
 * secrets.ts` in the internal repository): path ids leave the request, the
 * body is exactly the fields authn takes, and the answer is the protocol's
 * arm. No value or body is kept or logged.
 *
 * Never answered here: create's `pending` arm and replaceValue's `pending`
 * arm (authn answers neither on a person's session; a refusal is an HTTP
 * error). A refusal other than replaceValue's `secret_version_stale` is the
 * caller's error with authn's message, bounded ({@link refusalMessage}).
 */
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
  NEEDS_PERMISSION_MESSAGE,
  SIGN_IN_AGAIN_MESSAGE,
  environmentPath,
  errorBodyCode,
  isCloudFailure,
  isSuccess,
  sendEnvironmentRequest,
  type EnvironmentAnswer,
  type EnvironmentCloud,
  type EnvironmentHttpMethod,
} from "./environment-cloud";

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
 * authn's row as the protocol's. `revoked` is false on every row because
 * authn's list answers live, unrevoked secrets only. The retired fields a
 * released desktop still requires get their values here
 * (`released-wire-rows.ts` holds them).
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

/** A list row: the protocol's row plus the variable names the secret's value is set under. */
function listRowOf(row: AuthnSecretRow): EnvironmentSecretV12 {
  return {
    ...secretOf(row),
    variables: row.variables.map((variable) => variable.name),
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
  };
}

/**
 * authn's human message, printable and bounded; the generic words when there
 * is none. It goes into the answer to the person whose request it was, who
 * could read the same body from authn on the same sign-in.
 */
export function refusalMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return REFUSED;
  const text =
    "error" in body && typeof body.error === "string"
      ? body.error
      : "message" in body && typeof body.message === "string"
        ? body.message
        : null;
  if (text === null) return REFUSED;
  const printable = text.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
  if (printable.length === 0) return REFUSED;
  return printable.length > MAX_MESSAGE_LENGTH
    ? `${printable.slice(0, MAX_MESSAGE_LENGTH)}…`
    : printable;
}

/** The secrets route's body for the create: the protocol's, with the consent as authn takes it. */
function createBodyOf(
  request: EnvironmentSecretsCreateRequestV11,
): Record<string, unknown> {
  // `mode` and `exportPolicy` are retired; authn's schema is strict and has no
  // column for either, so they stop here.
  const {
    plaintextConsent,
    environmentId: _environmentId,
    mode: _mode,
    exportPolicy: _exportPolicy,
    ...rest
  } = request;
  return { ...rest, plaintextConsent: plaintextConsent !== null };
}

function send(
  cloud: EnvironmentCloud,
  environmentId: string,
  method: EnvironmentHttpMethod,
  suffix: string,
  body: unknown,
): Promise<EnvironmentAnswer> {
  return sendEnvironmentRequest(
    cloud,
    "secrets",
    method,
    `${environmentPath(environmentId)}/secrets${suffix}`,
    body,
  );
}

/** The caller's error for an HTTP refusal. */
function refusal(answer: EnvironmentAnswer): EnvironmentCloudError {
  if (answer.status === 401) {
    return new EnvironmentCloudError(
      "unauthorized",
      SIGN_IN_AGAIN_MESSAGE.secrets,
    );
  }
  if (answer.status === 403)
    return new EnvironmentCloudError("forbidden", NEEDS_PERMISSION_MESSAGE);
  if (isCloudFailure(answer))
    return new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
  return new EnvironmentCloudError("invalid", refusalMessage(answer.body));
}

function unreadable(): EnvironmentCloudError {
  return new EnvironmentCloudError("unavailable", CLOUD_UNAVAILABLE_MESSAGE);
}

/** Parses a 2xx answer with `schema`, else throws the matching error. */
function answerAs<T>(answer: EnvironmentAnswer, schema: z.ZodType<T>): T {
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
): Promise<EnvironmentSecretsCreateResponse> {
  if (
    request.mode !== RETIRED_SECRET_CREATE_FIELDS.mode ||
    request.exportPolicy !== RETIRED_SECRET_CREATE_FIELDS.exportPolicy
  ) {
    return { outcome: "refused", code: "plane_removed" };
  }
  // authn records the acceptance itself, at its own disclosure version: a
  // different version shown here is not recorded as accepted.
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
  );
  // A server address with no address of its own: the screen names what the
  // person typed. Every other refusal keeps authn's own words.
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
  let answer: EnvironmentAnswer;
  if (request.target === "secret") {
    answer = await send(
      cloud,
      environmentId,
      "POST",
      `${id(request.secretId)}/verify`,
      {},
    );
  } else {
    // authn's candidate body is strict: every binding field, no `target`.
    answer = await send(cloud, environmentId, "POST", "/verify", {
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
    });
  }
  return answerAs(answer, environmentSecretsVerifyResponseSchema);
}

export async function replaceSecretValue(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsReplaceValueRequestV11,
): Promise<EnvironmentSecretsReplaceValueResponse> {
  const answer = await send(
    cloud,
    environmentId,
    "PATCH",
    id(request.secretId),
    { value: request.value, expectedVersionId: request.expectedVersionId },
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
    ),
    environmentSecretsUndoResponseSchema,
  );
}

/**
 * `allowCurrent` is whether the removal may take a secret's current version;
 * the answer's shape follows it.
 */
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
    ),
    environmentSecretsRotationResponseSchema,
  );
}

export async function consentToSecret(
  cloud: EnvironmentCloud,
  environmentId: string,
  request: EnvironmentSecretsConsentRequestV11,
): Promise<EnvironmentSecretsConsentResponse> {
  // authn's consent route records the plaintext-at-the-gateway disclosure for
  // one secret and nothing else.
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
    ),
    environmentSecretsConsentResponseSchema,
  );
}
