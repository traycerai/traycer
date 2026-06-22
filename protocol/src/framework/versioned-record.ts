import { z } from "zod";
import type {
  AnyRecordContract,
  ContractForInstalledVersion,
  DowngradeResult,
  InstalledSchemaVersion,
  LatestRecordContract,
  RecordDowngradePath,
  RecordUpgradePath,
  RecordVersionRegistry,
  RuntimeRecordDowngradePath,
  RuntimeRecordUpgradePath,
  SchemaVersion,
  UncheckedVersionedRecordRegistry,
  ValidateVersionedRecordRegistry,
  ValueOf,
  VersionedRecordRegistry,
} from "./versioned-record-types";

export type {
  AnyRecordContract,
  AnyRecordDowngradePath,
  AnyRecordUpgradePath,
  AnyRecordVersionEntry,
  ContractForInstalledVersion,
  DowngradeResult,
  InstalledSchemaVersion,
  LatestRecordContract,
  MajorRecordVersionLine,
  RecordContract,
  RecordDowngradePath,
  RecordErrorCode,
  RecordErrorDetails,
  RecordUpgradePath,
  RecordVersionEntry,
  RecordVersionRegistry,
  SchemaVersion,
  UncheckedRecordVersionRegistry,
  UncheckedVersionedRecordRegistry,
  ValueOf,
  VersionedRecordRegistry,
} from "./versioned-record-types";

/**
 * Public authoring and traversal helpers for versioned record registries.
 *
 * Typical flow:
 * 1. Define contracts with `defineRecordContract()`.
 * 2. Define transforms with `defineRecordUpgradePath()` and
 *    `defineRecordDowngradePath()`.
 * 3. Build static registries with `defineVersionedRecordRegistry()`, or
 *    validate dynamic registries with `validateVersionedRecordRegistry()`.
 * 4. Use traversal helpers only with validated registries.
 *
 * The shape mirrors `versioned-rpc.ts`, but every contract carries a single
 * `schema` instead of a request/response pair - persistence records live on
 * disk on their own, not as two halves of a call.
 */

export function defineRecordContract<
  const Name extends string,
  const Version extends SchemaVersion,
  Schema extends z.ZodType,
>(contract: {
  name: Name;
  schemaVersion: Version;
  schema: Schema;
}): {
  name: Name;
  schemaVersion: Version;
  schema: Schema;
} {
  return contract;
}

export function defineRecordUpgradePath<
  From extends AnyRecordContract,
  To extends AnyRecordContract,
>(path: RecordUpgradePath<From, To>): RecordUpgradePath<From, To> {
  return path;
}

export function defineRecordDowngradePath<
  From extends AnyRecordContract,
  To extends AnyRecordContract,
>(path: RecordDowngradePath<From, To>): RecordDowngradePath<From, To> {
  return path;
}

export function defineVersionedRecordRegistry<
  const Registry extends UncheckedVersionedRecordRegistry,
>(
  registry: Registry & ValidateVersionedRecordRegistry<Registry>,
): VersionedRecordRegistry<Registry>;
export function defineVersionedRecordRegistry(
  registry: UncheckedVersionedRecordRegistry,
): VersionedRecordRegistry {
  validateVersionedRecordRegistry(registry);
  return registry as VersionedRecordRegistry;
}

/**
 * Promotes a raw registry to the validated brand after checking every
 * invariant the framework cares about in a single pass. Mirrors
 * `validateVersionedRpcRegistry()`:
 *
 * 1. Structural: `latestMinor` points at the highest installed minor; contracts
 *    match their slots; non-initial versions define an upgrade from the
 *    previous installed version; direct downgrades originate at a latest and
 *    target an older latest.
 * 2. Zod-schema: minors within a major line are purely additive; major bumps
 *    must carry at least one breaking change on the latest minor of each side.
 */
export function validateVersionedRecordRegistry<
  Registry extends UncheckedVersionedRecordRegistry,
>(
  registry: Registry,
): asserts registry is Registry & VersionedRecordRegistry<Registry> {
  for (const name in registry) {
    const recordRegistry = registry[name];
    const majorKeys = getSortedNumberKeys(recordRegistry);
    let previousInstalledVersion: SchemaVersion | null = null;

    for (const major of majorKeys) {
      const line = recordRegistry[major];

      if (!hasOwnNumberKey(line.versions, line.latestMinor)) {
        throw new Error(
          `Latest minor ${line.latestMinor} is not defined for record '${name}' major ${major}`,
        );
      }

      const highestInstalledMinor = getHighestInstalledNumber(line.versions);

      if (highestInstalledMinor !== line.latestMinor) {
        throw new Error(
          `Latest minor ${line.latestMinor} for record '${name}' major ${major} must be the highest installed minor ${highestInstalledMinor}`,
        );
      }

      const minorKeys = getSortedNumberKeys(line.versions);

      for (const minor of minorKeys) {
        const entry = line.versions[minor];
        const contract = entry.contract;

        if (contract.name !== name) {
          throw new Error(
            `Contract name '${contract.name}' does not match registry name '${name}'`,
          );
        }

        if (contract.schemaVersion.major !== major) {
          throw new Error(
            `Contract for record '${name}' minor ${minor} must declare major ${major}`,
          );
        }

        if (contract.schemaVersion.minor !== minor) {
          throw new Error(
            `Contract for record '${name}' major ${major} must declare minor ${minor}`,
          );
        }

        if (previousInstalledVersion === null) {
          if (entry.upgradeFromPreviousVersion !== null) {
            throw new Error(
              `Version ${major}.${minor} for record '${name}' cannot define an upgrade path without a previous installed version`,
            );
          }
        } else {
          if (entry.upgradeFromPreviousVersion === null) {
            throw new Error(
              `Version ${major}.${minor} for record '${name}' must define an upgrade path from version ${previousInstalledVersion.major}.${previousInstalledVersion.minor}`,
            );
          }

          if (
            entry.upgradeFromPreviousVersion.from.major !==
              previousInstalledVersion.major ||
            entry.upgradeFromPreviousVersion.from.minor !==
              previousInstalledVersion.minor
          ) {
            throw new Error(
              `Upgrade path for record '${name}' version ${major}.${minor} must start at previous installed version ${previousInstalledVersion.major}.${previousInstalledVersion.minor}`,
            );
          }

          if (
            entry.upgradeFromPreviousVersion.to.major !== major ||
            entry.upgradeFromPreviousVersion.to.minor !== minor
          ) {
            throw new Error(
              `Upgrade path for record '${name}' version ${major}.${minor} must end at version ${major}.${minor}`,
            );
          }
        }

        previousInstalledVersion = {
          major,
          minor,
        };
      }

      for (const targetMajorKey in line.downgradePathsFromLatest) {
        const targetMajor = Number(targetMajorKey);
        const downgradePath = line.downgradePathsFromLatest[targetMajor];
        const targetLine = recordRegistry[targetMajor];

        if (!targetLine) {
          throw new Error(
            `Downgrade path for record '${name}' major ${major} targets undefined major ${targetMajor}`,
          );
        }

        if (targetMajor >= major) {
          throw new Error(
            `Downgrade path for record '${name}' major ${major} must target an older major than ${major}`,
          );
        }

        if (
          downgradePath.from.major !== major ||
          downgradePath.from.minor !== line.latestMinor
        ) {
          throw new Error(
            `Downgrade path for record '${name}' major ${major} to major ${targetMajor} must start at latest minor ${line.latestMinor} of major ${major}`,
          );
        }

        if (
          downgradePath.to.major !== targetMajor ||
          downgradePath.to.minor !== targetLine.latestMinor
        ) {
          throw new Error(
            `Downgrade path for record '${name}' major ${major} to major ${targetMajor} must end at latest minor ${targetLine.latestMinor} of major ${targetMajor}`,
          );
        }
      }
    }
  }

  assertSchemaCompatibility(registry);
}

function assertSchemaCompatibility(
  registry: UncheckedVersionedRecordRegistry,
): void {
  const schemas = toRecordJsonSchemas(registry);

  for (const name in registry) {
    const recordRegistry = registry[name];
    const majors = getSortedNumberKeys(recordRegistry);

    for (const major of majors) {
      const line = recordRegistry[major];
      const minors = getSortedNumberKeys(line.versions);

      for (let index = 1; index < minors.length; index += 1) {
        const previousMinor = minors[index - 1];
        const currentMinor = minors[index];
        const previous = schemas[name][major][previousMinor];
        const current = schemas[name][major][currentMinor];

        const violation = findAdditivityViolation(previous, current);
        if (violation !== null) {
          throw new Error(
            `Minor ${major}.${currentMinor} for record '${name}' ${describeAdditivityViolation(violation)} from ${major}.${previousMinor}`,
          );
        }
      }
    }

    for (let index = 1; index < majors.length; index += 1) {
      const previousMajor = majors[index - 1];
      const currentMajor = majors[index];
      const previousLine = recordRegistry[previousMajor];
      const currentLine = recordRegistry[currentMajor];
      const previousLatest =
        schemas[name][previousMajor][previousLine.latestMinor];
      const currentLatest =
        schemas[name][currentMajor][currentLine.latestMinor];

      if (findBreakingChange(previousLatest, currentLatest) === null) {
        throw new Error(
          `Major bump ${previousMajor} -> ${currentMajor} for record '${name}' is not a breaking change (could have shipped as a minor)`,
        );
      }
    }
  }
}

// ---- Zod-aware registry helpers ---------------------------------------- //
//
// Fingerprint types and structural-diff helpers live in the shared
// `json-schema-fingerprint` module so the versioned-record and
// versioned-rpc frameworks can't drift on what counts as a breaking
// change.

export type {
  AnyOfJsonSchema,
  ArrayJsonSchema,
  EnumJsonSchema,
  JsonSchemaFingerprint as RecordJsonSchema,
  ObjectJsonSchema,
} from "./json-schema-fingerprint";
import {
  describeAdditivityViolation,
  findAdditivityViolation,
  findBreakingChange,
  toJsonSchemaFingerprint,
  type JsonSchemaFingerprint,
} from "./json-schema-fingerprint";

export type RegistryJsonSchemas = Readonly<
  Record<
    string,
    Readonly<Record<number, Readonly<Record<number, JsonSchemaFingerprint>>>>
  >
>;

/**
 * Converts every installed contract's schema to a normalized fingerprint.
 * Throws when a schema is neither an object, an enum/literal-union, an
 * array, nor a generic `anyOf`.
 */
export function toRecordJsonSchemas(
  registry: UncheckedVersionedRecordRegistry,
): RegistryJsonSchemas {
  const view: Record<
    string,
    Record<number, Record<number, JsonSchemaFingerprint>>
  > = {};

  for (const name in registry) {
    const nameView: Record<number, Record<number, JsonSchemaFingerprint>> = {};

    for (const major of getSortedNumberKeys(registry[name])) {
      const line = registry[name][major];
      const lineView: Record<number, JsonSchemaFingerprint> = {};

      for (const minor of getSortedNumberKeys(line.versions)) {
        const contract = line.versions[minor].contract;
        lineView[minor] = toJsonSchemaFingerprint(
          contract.schema,
          `${name} ${major}.${minor}`,
        );
      }

      nameView[major] = lineView;
    }

    view[name] = nameView;
  }

  return view;
}

type LatestMajorContract<
  Registry extends RecordVersionRegistry,
  Major extends keyof Registry & number,
> = Registry[Major] extends {
  versions: infer Versions extends Readonly<
    Record<number, { contract: AnyRecordContract }>
  >;
  latestMinor: infer LatestMinor;
}
  ? LatestMinor extends keyof Versions & number
    ? Versions[LatestMinor]["contract"]
    : never
  : never;

/**
 * Returns the latest installed contract for the entire record registry
 * when `major` is `undefined`, or for a specific major line when a
 * literal major key is supplied. The `major` argument is required at
 * every call site so "give me the latest installed major" is always an
 * explicit choice rather than a forgotten default.
 */
export function getLatestRecordContract<Registry extends RecordVersionRegistry>(
  registry: Registry,
  major: undefined,
): LatestRecordContract<Registry>;
export function getLatestRecordContract<
  Registry extends RecordVersionRegistry,
  Major extends keyof Registry & number,
>(registry: Registry, major: Major): LatestMajorContract<Registry, Major>;
export function getLatestRecordContract<
  Registry extends RecordVersionRegistry,
  Major extends keyof Registry & number,
>(registry: Registry, major: Major | undefined): object {
  if (major === undefined) {
    const latestMajor = getHighestInstalledNumber(registry);
    const latestLine = getMajorLine(registry, latestMajor);
    return latestLine.versions[latestLine.latestMinor].contract;
  }

  const line = getMajorLine(registry, major);
  return line.versions[line.latestMinor].contract;
}

/**
 * Type-level alias for the runtime value of a record at the latest
 * installed version. Use this at consumer call sites instead of
 * defining plain TS shapes that could drift from the schema:
 *
 *     type Epic = RecordValue<typeof persistenceRecordRegistry, "epic">;
 */
export type RecordValue<
  Registry extends VersionedRecordRegistry,
  Name extends keyof Registry & string,
> = ValueOf<LatestRecordContract<Registry[Name]>>;

/**
 * Sentinel for "I don't pin to a historical version - give me the
 * record's latest installed shape". Required at every
 * `getRecordSchema(...)` call site so picking the latest is always an
 * explicit choice rather than a forgotten default.
 */
export type LatestVersion = "latest";

/**
 * Version selector accepted by `getRecordSchema(...)` and
 * `loadRecord(...)`: either the literal `"latest"` or an explicit
 * `SchemaVersion`.
 */
export type VersionSelector = LatestVersion | SchemaVersion;

/**
 * Returns the schema for `name` at the requested version.
 *
 * The approved entry point for code outside the owning registry that
 * needs a record schema at runtime - the privacy boundary forbids
 * importing raw schema modules directly.
 *
 * `version` is required: pass `"latest"` to bind to the record's
 * latest installed shape, or a `SchemaVersion` to pin to a specific
 * installed version. The required argument is intentional - it makes
 * "I want the latest" an explicit choice rather than a forgotten
 * default that silently breaks when a new minor lands.
 *
 * When a specific `version` is supplied and that version is not
 * installed, this throws; consumers carrying data of an older version
 * should use `loadRecord(...)` (parse + migrate to latest) or compose
 * `getRecordSchema(...)` with `upgradeRecordToVersion` /
 * `downgradeRecordAcrossMajors` themselves.
 */
export function getRecordSchema<
  Registry extends VersionedRecordRegistry,
  Name extends keyof Registry & string,
>(
  registry: Registry,
  name: Name,
  version: LatestVersion,
): LatestRecordContract<Registry[Name]>["schema"];
export function getRecordSchema<
  Registry extends VersionedRecordRegistry,
  Name extends keyof Registry & string,
>(registry: Registry, name: Name, version: SchemaVersion): z.ZodType;
export function getRecordSchema<
  Registry extends VersionedRecordRegistry,
  Name extends keyof Registry & string,
>(
  registry: Registry,
  name: Name,
  version: VersionSelector,
): z.ZodType {
  const recordRegistry = registry[name];

  if (!recordRegistry) {
    throw new Error(
      `Record '${String(name)}' is not defined in the registry`,
    );
  }

  if (version === "latest") {
    return getLatestRecordContract(recordRegistry, undefined).schema;
  }

  return getVersionEntry(recordRegistry, version.major, version.minor).contract
    .schema;
}

/**
 * Parses `data` against the latest installed schema for `name`. One-step
 * convenience over `getRecordSchema(registry, name, "latest").parse(...)`.
 *
 * For data persisted at an older known version, use `loadRecord(...)`
 * which parses against the historical schema and then runs the
 * registry's upgrade chain forward to the latest version.
 */
export function parseRecord<
  Registry extends VersionedRecordRegistry,
  Name extends keyof Registry & string,
>(
  registry: Registry,
  name: Name,
  data: unknown,
): RecordValue<Registry, Name> {
  const schema = getRecordSchema(registry, name, "latest");
  return schema.parse(data) as RecordValue<Registry, Name>;
}

/**
 * Parses `data` (assumed to be at `fromVersion`) against the
 * historical schema, then migrates the parsed value forward to the
 * latest installed version through the registry's upgrade chain.
 *
 * Throws when:
 * - `fromVersion` is not an installed version of `name`
 * - any required upgrade step is missing - see
 *   `upgradeRecordToVersion`'s preconditions
 *
 * For backward migration (when `fromVersion` is on a newer major than
 * the caller can handle), use
 * `downgradeRecordAcrossMajors(registry, fromMajor, toMajor, ...)`
 * directly: this helper only walks the installed-minor chain forward.
 */
export function loadRecord<
  Registry extends VersionedRecordRegistry,
  Name extends keyof Registry & string,
>(
  registry: Registry,
  name: Name,
  data: unknown,
  fromVersion: SchemaVersion,
): RecordValue<Registry, Name> {
  const recordRegistry = registry[name];

  if (!recordRegistry) {
    throw new Error(
      `Record '${String(name)}' is not defined in the registry`,
    );
  }

  const fromSchema = getRecordSchema(registry, name, fromVersion);
  const parsed = fromSchema.parse(data) as Parameters<
    RuntimeRecordUpgradePath<Registry[Name]>["upgradeRecord"]
  >[0];

  const installedVersions = listInstalledVersions(recordRegistry);
  const latestVersion = installedVersions[installedVersions.length - 1];

  if (latestVersion === undefined) {
    throw new Error(
      `Record '${String(name)}' has no installed versions`,
    );
  }

  return upgradeRecordToVersion(
    recordRegistry,
    fromVersion as InstalledSchemaVersion<Registry[Name]>,
    latestVersion,
    parsed,
  ) as RecordValue<Registry, Name>;
}

/**
 * Walks the installed version chain from `fromVersion` to `toVersion`.
 */
export function upgradeRecordToVersion<
  Registry extends RecordVersionRegistry,
  const FromVersion extends InstalledSchemaVersion<Registry>,
  const ToVersion extends InstalledSchemaVersion<Registry>,
>(
  registry: Registry,
  fromVersion: FromVersion,
  toVersion: ToVersion,
  record: ValueOf<ContractForInstalledVersion<Registry, FromVersion>>,
): ValueOf<ContractForInstalledVersion<Registry, ToVersion>> {
  assertUpgradeOrder(fromVersion, toVersion);

  if (isSameSchemaVersion(fromVersion, toVersion)) {
    return record as ValueOf<ContractForInstalledVersion<Registry, ToVersion>>;
  }

  const installedVersions = listInstalledVersions(registry);
  const fromIndex = findVersionIndex(installedVersions, fromVersion);
  const toIndex = findVersionIndex(installedVersions, toVersion);
  let current: Parameters<RuntimeRecordUpgradePath<Registry>["upgradeRecord"]>[0] =
    record;

  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    const nextVersion = installedVersions[index];
    const versionEntry = getVersionEntry(
      registry,
      nextVersion.major,
      nextVersion.minor,
    );

    if (versionEntry.upgradeFromPreviousVersion === null) {
      throw new Error(
        `No upgrade path exists to version ${nextVersion.major}.${nextVersion.minor}`,
      );
    }

    const runtimeUpgradePath =
      versionEntry.upgradeFromPreviousVersion as RuntimeRecordUpgradePath<Registry>;
    current = runtimeUpgradePath.upgradeRecord(current);
  }

  return current as ValueOf<ContractForInstalledVersion<Registry, ToVersion>>;
}

/**
 * Uses a direct downgrade bridge from the latest installed version of
 * `fromMajor` to the latest installed version of `toMajor`.
 */
export function downgradeRecordAcrossMajors<
  Registry extends RecordVersionRegistry,
  FromMajor extends keyof Registry & number,
  ToMajor extends keyof Registry & number,
>(
  registry: Registry,
  fromMajor: FromMajor,
  toMajor: ToMajor,
  record: ValueOf<LatestMajorContract<Registry, FromMajor>>,
): DowngradeResult<ValueOf<LatestMajorContract<Registry, ToMajor>>> {
  if (Number(fromMajor) === Number(toMajor)) {
    // Re-parse against the target major's record schema so the
    // narrowing happens at runtime instead of through a chained type
    // assertion. With `fromMajor === toMajor` the schemas resolve to
    // the same instance, so parse is an effective identity check.
    const targetLine = getMajorLine(registry, toMajor);
    const targetContract =
      targetLine.versions[targetLine.latestMinor].contract;
    type ToValue = ValueOf<LatestMajorContract<Registry, ToMajor>>;
    const parsed: ToValue = targetContract.schema.parse(record) as ToValue;
    return { ok: true, value: parsed };
  }

  assertBackwardMajorOrder(fromMajor, toMajor);
  const line = getMajorLine(registry, fromMajor);
  const downgradePath = line.downgradePathsFromLatest[toMajor];

  if (!downgradePath) {
    return {
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message: `No direct downgrade path exists from major ${fromMajor} to major ${toMajor}`,
      },
    };
  }

  type RuntimePath = RuntimeRecordDowngradePath<Registry>;
  const runtimeDowngradePath = downgradePath as RuntimePath;
  type ToResult = DowngradeResult<
    ValueOf<LatestMajorContract<Registry, ToMajor>>
  >;
  const downgraded = runtimeDowngradePath.downgradeRecord(record) as ToResult;
  return downgraded;
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
    throw new Error("Registry line must define at least one installed version");
  }

  return latest;
}

function getMajorLine<
  Registry extends RecordVersionRegistry,
  Major extends keyof Registry & number,
>(registry: Registry, major: Major): Registry[Major] {
  const line = registry[major];

  if (!line) {
    throw new Error(`Major ${major} is not defined in the record registry`);
  }

  return line;
}

function getVersionEntry<
  Registry extends RecordVersionRegistry,
  Major extends keyof Registry & number,
  Minor extends keyof Registry[Major]["versions"] & number,
>(
  registry: Registry,
  major: Major,
  minor: Minor,
): Registry[Major]["versions"][Minor] {
  const line = getMajorLine(registry, major);
  const entry = line.versions[minor];

  if (!entry) {
    throw new Error(
      `Version ${major}.${minor} is not defined in the record registry`,
    );
  }

  return entry;
}

function listInstalledVersions<Registry extends RecordVersionRegistry>(
  registry: Registry,
): Array<InstalledSchemaVersion<Registry>> {
  const installedVersions: Array<InstalledSchemaVersion<Registry>> = [];

  for (const major of getSortedNumberKeys(registry)) {
    const line = registry[major];

    for (const minor of getSortedNumberKeys(line.versions)) {
      installedVersions.push({
        major,
        minor,
      } as InstalledSchemaVersion<Registry>);
    }
  }

  return installedVersions;
}

function findVersionIndex<Registry extends RecordVersionRegistry>(
  versions: Array<InstalledSchemaVersion<Registry>>,
  version: SchemaVersion,
): number {
  const index = versions.findIndex((installedVersion) =>
    isSameSchemaVersion(installedVersion, version),
  );

  if (index === -1) {
    throw new Error(
      `Version ${version.major}.${version.minor} is not defined in the record registry`,
    );
  }

  return index;
}

function compareSchemaVersion(
  left: SchemaVersion,
  right: SchemaVersion,
): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }

  return left.minor - right.minor;
}

function isSameSchemaVersion(
  left: SchemaVersion,
  right: SchemaVersion,
): boolean {
  return left.major === right.major && left.minor === right.minor;
}

function assertUpgradeOrder(
  fromVersion: SchemaVersion,
  toVersion: SchemaVersion,
): void {
  if (compareSchemaVersion(fromVersion, toVersion) > 0) {
    throw new Error(
      `Cannot upgrade backwards from version ${fromVersion.major}.${fromVersion.minor} to version ${toVersion.major}.${toVersion.minor}`,
    );
  }
}

function assertBackwardMajorOrder(fromMajor: number, toMajor: number): void {
  if (fromMajor < toMajor) {
    throw new Error(
      `Cannot downgrade forwards from major ${fromMajor} to major ${toMajor}`,
    );
  }
}
