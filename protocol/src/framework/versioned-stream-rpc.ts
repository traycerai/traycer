import { z } from "zod";

/**
 * Versioned **streaming RPC** framework - the long-lived-subscription
 * counterpart to the request/response versioned RPC framework in
 * `versioned-rpc.ts`.
 *
 * A streaming RPC contract pairs three Zod schemas:
 *
 * - `openRequestSchema` - the parameters a client sends when opening a
 *   subscription. Always a `z.object(...)`.
 * - `serverFrameSchema` - the tagged union of frames the server pushes on
 *   the stream. Always a `z.discriminatedUnion(...)`.
 * - `clientFrameSchema` - the tagged union of frames the client can push
 *   back after the subscription opens. Always a `z.discriminatedUnion(...)`.
 *
 * The framework mirrors every structural invariant of the RPC framework:
 * `{ major, minor }` versioning, `latestMinor` must be the highest installed
 * minor in its line, contracts must line up with their registry slot and
 * registry key. In v1 there are **no cross-major downgrade bridges** for
 * streams - stream clients are expected to reconnect on a mismatched major.
 *
 * Schema compatibility is evaluated **separately** for each of the three
 * sub-schemas (open request, server frame, client frame):
 *
 * - Minors within a major line must be additive - no sub-schema may drop a
 *   field (or a discriminated-union variant) that an earlier minor of the
 *   same major declared.
 * - A major bump must carry at least one breaking change (a dropped field,
 *   a dropped variant, or a changed field schema) on the latest minor of
 *   either side of the bump, across any of the three sub-schemas. A
 *   purely-additive major bump is rejected - it should have shipped as a
 *   minor.
 */

export type SchemaVersion = {
  major: number;
  minor: number;
};

export type StreamRpcContract<
  OpenSchema extends z.ZodType,
  ServerFrameSchema extends z.ZodType,
  ClientFrameSchema extends z.ZodType,
> = {
  method: string;
  schemaVersion: SchemaVersion;
  openRequestSchema: OpenSchema;
  serverFrameSchema: ServerFrameSchema;
  clientFrameSchema: ClientFrameSchema;
};

export type AnyStreamRpcContract = StreamRpcContract<
  z.ZodType,
  z.ZodType,
  z.ZodType
>;

export type OpenRequestOf<Contract> =
  Contract extends StreamRpcContract<infer Open, infer _S, infer _C>
    ? z.infer<Open>
    : never;

export type ServerFrameOf<Contract> =
  Contract extends StreamRpcContract<infer _O, infer Server, infer _C>
    ? z.infer<Server>
    : never;

export type ClientFrameOf<Contract> =
  Contract extends StreamRpcContract<infer _O, infer _S, infer Client>
    ? z.infer<Client>
    : never;

export type StreamVersionEntry<Contract extends AnyStreamRpcContract> = {
  readonly contract: Contract;
};

export type AnyStreamVersionEntry = StreamVersionEntry<AnyStreamRpcContract>;

export type StreamMajorVersionLine<
  Versions extends Readonly<Record<number, AnyStreamVersionEntry>>,
  LatestMinor extends keyof Versions & number,
> = {
  readonly latestMinor: LatestMinor;
  readonly versions: Versions;
};

type AnyStreamMajorVersionLine = StreamMajorVersionLine<
  Readonly<Record<number, AnyStreamVersionEntry>>,
  number
>;

/**
 * Raw method registry shape before validation.
 */
export type UncheckedStreamMethodVersionRegistry = Readonly<
  Record<number, AnyStreamMajorVersionLine>
>;

/**
 * Raw multi-method registry shape before validation.
 */
export type UncheckedVersionedStreamRpcRegistry = Readonly<
  Record<string, UncheckedStreamMethodVersionRegistry>
>;

declare const validatedStreamMethodVersionRegistryBrand: unique symbol;
declare const validatedVersionedStreamRpcRegistryBrand: unique symbol;

/**
 * Validated method registry. Produced by `validateVersionedStreamRpcRegistry`
 * or `defineVersionedStreamRpcRegistry`.
 */
export type StreamMethodVersionRegistry<
  Registry extends
    UncheckedStreamMethodVersionRegistry = UncheckedStreamMethodVersionRegistry,
> = Registry & {
  readonly [validatedStreamMethodVersionRegistryBrand]: true;
};

/**
 * Validated multi-method stream registry.
 */
export type VersionedStreamRpcRegistry<
  Registry extends
    UncheckedVersionedStreamRpcRegistry = UncheckedVersionedStreamRpcRegistry,
> = {
  readonly [Method in keyof Registry &
    string]: StreamMethodVersionRegistry<Registry[Method]>;
} & {
  readonly [validatedVersionedStreamRpcRegistryBrand]: true;
};

/**
 * Preserves literal method and version information for downstream registry typing.
 */
export function defineStreamRpcContract<
  const Method extends string,
  const Version extends SchemaVersion,
  OpenSchema extends z.ZodType,
  ServerFrameSchema extends z.ZodType,
  ClientFrameSchema extends z.ZodType,
>(contract: {
  method: Method;
  schemaVersion: Version;
  openRequestSchema: OpenSchema;
  serverFrameSchema: ServerFrameSchema;
  clientFrameSchema: ClientFrameSchema;
}): {
  method: Method;
  schemaVersion: Version;
  openRequestSchema: OpenSchema;
  serverFrameSchema: ServerFrameSchema;
  clientFrameSchema: ClientFrameSchema;
} {
  return contract;
}

/**
 * Preferred authoring path for stream registries declared in source code.
 * Runs `validateVersionedStreamRpcRegistry` at module load so misconfigurations
 * surface immediately with readable errors.
 */
export function defineVersionedStreamRpcRegistry<
  const Registry extends UncheckedVersionedStreamRpcRegistry,
>(registry: Registry): VersionedStreamRpcRegistry<Registry> {
  validateVersionedStreamRpcRegistry(registry);
  return registry;
}

/**
 * Promotes a raw registry to the validated brand after checking every
 * invariant the stream framework cares about:
 *
 * 1. Structural - `latestMinor` points at the highest installed minor in its
 *    line, contracts line up with their slot and registry key.
 * 2. Schema - minors within a major line are additive for every sub-schema
 *    (no dropped fields, no dropped discriminated-union variants), and
 *    major bumps must carry at least one breaking change across any
 *    sub-schema on the latest minor of each side.
 */
export function validateVersionedStreamRpcRegistry<
  Registry extends UncheckedVersionedStreamRpcRegistry,
>(
  registry: Registry,
): asserts registry is Registry & VersionedStreamRpcRegistry<Registry> {
  for (const method in registry) {
    const methodRegistry = registry[method];
    const majorKeys = getSortedNumberKeys(methodRegistry);

    for (const major of majorKeys) {
      const line = methodRegistry[major];

      if (!hasOwnNumberKey(line.versions, line.latestMinor)) {
        throw new Error(
          `Latest minor ${line.latestMinor} is not defined for method '${method}' major ${major}`,
        );
      }

      const highestInstalledMinor = getHighestInstalledNumber(line.versions);

      if (highestInstalledMinor !== line.latestMinor) {
        throw new Error(
          `Latest minor ${line.latestMinor} for method '${method}' major ${major} must be the highest installed minor ${highestInstalledMinor}`,
        );
      }

      const minorKeys = getSortedNumberKeys(line.versions);

      for (const minor of minorKeys) {
        const contract = line.versions[minor].contract;

        if (contract.method !== method) {
          throw new Error(
            `Contract method '${contract.method}' does not match registry method '${method}'`,
          );
        }

        if (contract.schemaVersion.major !== major) {
          throw new Error(
            `Contract for method '${method}' minor ${minor} must declare major ${major}`,
          );
        }

        if (contract.schemaVersion.minor !== minor) {
          throw new Error(
            `Contract for method '${method}' major ${major} must declare minor ${minor}`,
          );
        }
      }
    }

    assertSchemaCompatibility(method, methodRegistry);
  }
}

type FieldMap = Readonly<Record<string, string>>;

type ContractFieldMaps = {
  readonly openRequest: FieldMap;
  readonly serverFrame: FieldMap;
  readonly clientFrame: FieldMap;
};

type SubSchemaKey = "openRequest" | "serverFrame" | "clientFrame";

const SUB_SCHEMA_KEYS: readonly SubSchemaKey[] = [
  "openRequest",
  "serverFrame",
  "clientFrame",
];

function assertSchemaCompatibility(
  method: string,
  methodRegistry: UncheckedStreamMethodVersionRegistry,
): void {
  const majors = getSortedNumberKeys(methodRegistry);
  const view: Record<number, Record<number, ContractFieldMaps>> = {};

  for (const major of majors) {
    const line = methodRegistry[major];
    const minorView: Record<number, ContractFieldMaps> = {};

    for (const minor of getSortedNumberKeys(line.versions)) {
      const contract = line.versions[minor].contract;
      minorView[minor] = {
        openRequest: flattenToFieldMap(
          contract.openRequestSchema,
          `${method} ${major}.${minor} openRequest`,
        ),
        serverFrame: flattenToFieldMap(
          contract.serverFrameSchema,
          `${method} ${major}.${minor} serverFrame`,
        ),
        clientFrame: flattenToFieldMap(
          contract.clientFrameSchema,
          `${method} ${major}.${minor} clientFrame`,
        ),
      };
    }

    view[major] = minorView;
  }

  for (const major of majors) {
    const line = methodRegistry[major];
    const minors = getSortedNumberKeys(line.versions);

    for (let index = 1; index < minors.length; index += 1) {
      const previousMinor = minors[index - 1];
      const currentMinor = minors[index];
      const previous = view[major][previousMinor];
      const current = view[major][currentMinor];

      for (const schemaKey of SUB_SCHEMA_KEYS) {
        const droppedField = findDroppedField(
          previous[schemaKey],
          current[schemaKey],
        );

        if (droppedField !== null) {
          throw new Error(
            `Minor ${major}.${currentMinor} for method '${method}' drops ${schemaKey} field '${droppedField}' from ${major}.${previousMinor}`,
          );
        }
      }
    }
  }

  for (let index = 1; index < majors.length; index += 1) {
    const previousMajor = majors[index - 1];
    const currentMajor = majors[index];
    const previousLatestMinor = methodRegistry[previousMajor].latestMinor;
    const currentLatestMinor = methodRegistry[currentMajor].latestMinor;
    const previous = view[previousMajor][previousLatestMinor];
    const current = view[currentMajor][currentLatestMinor];

    const hasAnyBreak = SUB_SCHEMA_KEYS.some(
      (schemaKey) =>
        findBreakingChange(previous[schemaKey], current[schemaKey]) !== null,
    );

    if (!hasAnyBreak) {
      throw new Error(
        `Major bump ${previousMajor} -> ${currentMajor} for method '${method}' is not a breaking change (could have shipped as a minor)`,
      );
    }
  }
}

/**
 * Flattens a stream sub-schema to a `Record<path, serialized-field-json-schema>`:
 *
 * - For a plain `z.object({...})`, keys are field names.
 * - For a `z.discriminatedUnion("kind", [z.object(...), ...])`, keys are
 *   `"<discriminator-value>.<field-name>"`, so adding a new variant or adding
 *   a field to an existing variant looks like a key addition, while dropping
 *   a variant or a field looks like a key removal.
 *
 * The comparison uses JSON-Schema serialization of each field, so "field schema
 * changed" is detected by string inequality of the serialized form.
 */
function flattenToFieldMap(schema: z.ZodType, context: string): FieldMap {
  if (schema instanceof z.ZodObject) {
    return flattenObjectShape(schema, context);
  }

  if (schema instanceof z.ZodDiscriminatedUnion) {
    const discriminator = schema.def.discriminator;
    const out: Record<string, string> = {};

    for (const option of schema.def.options) {
      if (!(option instanceof z.ZodObject)) {
        throw new Error(
          `${context}: every z.discriminatedUnion option must be a z.object()`,
        );
      }

      const discField = option.shape[discriminator];

      if (!(discField instanceof z.ZodLiteral)) {
        throw new Error(
          `${context}: discriminator field '${discriminator}' must be a z.literal on every option`,
        );
      }

      const literalValues = discField.def.values;

      if (literalValues.length !== 1) {
        throw new Error(
          `${context}: discriminator literal must carry exactly one value`,
        );
      }

      const discriminatorValue = literalValues[0];

      if (typeof discriminatorValue !== "string") {
        throw new Error(
          `${context}: discriminator literal must be a string`,
        );
      }

      for (const [field, fieldSchema] of Object.entries(option.shape)) {
        out[`${discriminatorValue}.${field}`] = JSON.stringify(
          z.toJSONSchema(fieldSchema),
        );
      }
    }

    return out;
  }

  throw new Error(
    `${context}: schema must be a z.object() or z.discriminatedUnion() of z.object()s`,
  );
}

function flattenObjectShape(schema: z.ZodObject, context: string): FieldMap {
  const out: Record<string, string> = {};

  for (const [field, fieldSchema] of Object.entries(schema.shape)) {
    if (!(fieldSchema instanceof z.ZodType)) {
      throw new Error(
        `${context}: field '${field}' is not a zod schema`,
      );
    }

    out[field] = JSON.stringify(z.toJSONSchema(fieldSchema));
  }

  return out;
}

function findDroppedField(previous: FieldMap, next: FieldMap): string | null {
  for (const key of Object.keys(previous)) {
    if (!(key in next)) {
      return key;
    }
  }

  return null;
}

type BreakingChange = {
  readonly field: string;
  readonly reason: "removed" | "schema-changed";
};

function findBreakingChange(
  previous: FieldMap,
  next: FieldMap,
): BreakingChange | null {
  for (const key of Object.keys(previous)) {
    if (!(key in next)) {
      return { field: key, reason: "removed" };
    }

    if (previous[key] !== next[key]) {
      return { field: key, reason: "schema-changed" };
    }
  }

  return null;
}

function hasOwnNumberKey<Value>(
  values: Readonly<Record<number, Value>>,
  key: number,
): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

function getSortedNumberKeys<Value>(
  values: Readonly<Record<number, Value>>,
): number[] {
  return Object.keys(values)
    .map((key) => Number(key))
    .sort((left, right) => left - right);
}

function getHighestInstalledNumber<Value>(
  values: Readonly<Record<number, Value>>,
): number {
  const keys = getSortedNumberKeys(values);
  const latest = keys.at(-1);

  if (latest === undefined) {
    throw new Error(
      "Stream registry line must define at least one installed version",
    );
  }

  return latest;
}
