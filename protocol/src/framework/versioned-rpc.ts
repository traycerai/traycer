// Versioning note: the per-method `{ major, minor }` schema versions defined
// through this registry are the *handshake contract* the client<->host
// negotiation runs against at runtime. They are distinct from the npm semver in
// `package.json`, which only governs distribution (which built copy of the
// contract a consumer depends on). Do not conflate the two. See README.md.
import { z } from "zod";
import {
  describeAdditivityViolation,
  findAdditivityViolation,
  findBreakingChange,
  toJsonSchemaFingerprint,
  type JsonSchemaFingerprint,
} from "./json-schema-fingerprint";
import type {
  AnyRpcContract,
  ContractForInstalledVersion,
  DowngradePath,
  DowngradeResult,
  FallbackMethodDegrade,
  InstalledSchemaVersion,
  LatestContract,
  MethodVersionRegistry,
  MethodDegradeDeclaration,
  RequestOf,
  ResponseOf,
  RuntimeDowngradePath,
  RuntimeUpgradePath,
  SchemaVersion,
  UncheckedVersionedRpcRegistry,
  UpgradePath,
  ValidateVersionedRpcRegistryDegrades,
  ValidateVersionedRpcRegistry,
  VersionedRpcRegistry,
} from "./versioned-rpc-types";

export type {
  AnyDowngradePath,
  AnyRpcContract,
  AnyUpgradePath,
  AnyVersionEntry,
  ContractForInstalledVersion,
  DowngradePath,
  DowngradeResult,
  InstalledSchemaVersion,
  LatestContract,
  MajorVersionLine,
  MethodDegradeDeclaration,
  MethodVersionRegistry,
  RequestOf,
  ResponseOf,
  RpcContract,
  RpcErrorCode,
  RpcErrorDetails,
  RpcErrorFor,
  RpcRequestFor,
  RpcResultFor,
  RpcSuccessFor,
  SchemaVersion,
  UncheckedMethodVersionRegistry,
  UncheckedVersionedRpcRegistry,
  UpgradePath,
  UnsupportedMethodDegrade,
  FallbackMethodDegrade,
  VersionEntry,
  VersionedRpcRegistry,
} from "./versioned-rpc-types";

/**
 * Public authoring and traversal helpers for versioned RPC registries.
 *
 * Typical flow:
 * 1. Define contracts with `defineRpcContract()`.
 * 2. Define transforms with `defineUpgradePath()` and `defineDowngradePath()`.
 * 3. Build static registries with `defineVersionedRpcRegistry()`, or validate
 *    dynamic registries with `validateVersionedRpcRegistry()`.
 * 4. Use traversal helpers only with validated registries.
 */

/**
 * Preserves literal method and version information for downstream registry typing.
 */
export function defineRpcContract<
  const Method extends string,
  const Version extends SchemaVersion,
  ReqSchema extends z.ZodType,
  ResSchema extends z.ZodType,
>(contract: {
  method: Method;
  schemaVersion: Version;
  requestSchema: ReqSchema;
  responseSchema: ResSchema;
}): {
  method: Method;
  schemaVersion: Version;
  requestSchema: ReqSchema;
  responseSchema: ResSchema;
} {
  return contract;
}

export function defineUpgradePath<
  From extends AnyRpcContract,
  To extends AnyRpcContract,
>(path: UpgradePath<From, To>): UpgradePath<From, To> {
  return path;
}

export function defineDowngradePath<
  From extends AnyRpcContract,
  To extends AnyRpcContract,
>(path: DowngradePath<From, To>): DowngradePath<From, To> {
  return path;
}

export function defineFallbackMethodDegrade<
  Canonical extends AnyRpcContract,
  Fallback extends AnyRpcContract,
  const FloorMethod extends string,
>(
  degrade: FallbackMethodDegrade<Canonical, Fallback, FloorMethod>,
): FallbackMethodDegrade<Canonical, Fallback, FloorMethod> {
  return degrade;
}

/**
 * Preferred authoring path for registries declared in source code.
 *
 * It applies compile-time validation to object literals, then runs the runtime
 * validator so widened or indirectly assembled values still fail with readable errors.
 */
export function defineVersionedRpcRegistry<
  const Registry extends UncheckedVersionedRpcRegistry,
>(
  registry: Registry & ValidateVersionedRpcRegistry<Registry>,
): VersionedRpcRegistry<Registry>;
export function defineVersionedRpcRegistry(
  registry: UncheckedVersionedRpcRegistry,
): VersionedRpcRegistry {
  validateVersionedRpcRegistry(registry);
  return registry as VersionedRpcRegistry;
}

export function defineFloorAwareVersionedRpcRegistry<
  const FloorMethod extends string,
  const Registry extends UncheckedVersionedRpcRegistry,
>(
  floorMethodNames: readonly FloorMethod[],
  registry: Registry &
    ValidateVersionedRpcRegistry<Registry> &
    ValidateVersionedRpcRegistryDegrades<Registry, FloorMethod>,
): VersionedRpcRegistry<Registry>;
export function defineFloorAwareVersionedRpcRegistry(
  floorMethodNames: readonly string[],
  registry: UncheckedVersionedRpcRegistry,
): VersionedRpcRegistry {
  validateVersionedRpcRegistry(registry);
  validateVersionedRpcRegistryDegrades(registry, floorMethodNames);
  return registry as VersionedRpcRegistry;
}

/**
 * Promotes a raw registry to the validated brand after checking every invariant
 * the framework cares about in a single pass:
 *
 * 1. Structural:
 *    - `latestMinor` points at an installed and highest minor within each line
 *    - contracts match their method and major/minor slots
 *    - each non-initial installed version defines an upgrade from the previous
 *      installed version
 *    - direct downgrades originate at the latest installed version of the source
 *      major and target the latest installed version of an older major
 * 2. Zod-schema-level:
 *    - minors within a major line only add request/response fields; no minor
 *      may drop a field that an earlier minor in the same line had (changing
 *      a field's own schema within a line is allowed)
 *    - major bumps carry at least one breaking change on the latest minor of
 *      each side (a removed field or a changed field schema); purely additive
 *      bumps should ship as a minor
 *
 * Use this when the registry comes from a dynamic boundary such as parsed JSON,
 * tests that intentionally exercise invalid states, or code paths outside the
 * compiler's view.
 */
export function validateVersionedRpcRegistry<
  Registry extends UncheckedVersionedRpcRegistry,
>(
  registry: Registry,
): asserts registry is Registry & VersionedRpcRegistry<Registry> {
  for (const method in registry) {
    const methodRegistry = registry[method];
    const majorKeys = getSortedNumberKeys(methodRegistry);
    let previousInstalledVersion: SchemaVersion | null = null;

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
        const entry = line.versions[minor];
        const contract = entry.contract;

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

        if (previousInstalledVersion === null) {
          if (entry.upgradeFromPreviousVersion !== null) {
            throw new Error(
              `Version ${major}.${minor} for method '${method}' cannot define an upgrade path without a previous installed version`,
            );
          }
        } else {
          if (entry.upgradeFromPreviousVersion === null) {
            throw new Error(
              `Version ${major}.${minor} for method '${method}' must define an upgrade path from version ${previousInstalledVersion.major}.${previousInstalledVersion.minor}`,
            );
          }

          if (
            entry.upgradeFromPreviousVersion.from.major !==
              previousInstalledVersion.major ||
            entry.upgradeFromPreviousVersion.from.minor !==
              previousInstalledVersion.minor
          ) {
            throw new Error(
              `Upgrade path for method '${method}' version ${major}.${minor} must start at previous installed version ${previousInstalledVersion.major}.${previousInstalledVersion.minor}`,
            );
          }

          if (
            entry.upgradeFromPreviousVersion.to.major !== major ||
            entry.upgradeFromPreviousVersion.to.minor !== minor
          ) {
            throw new Error(
              `Upgrade path for method '${method}' version ${major}.${minor} must end at version ${major}.${minor}`,
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
        const targetLine = methodRegistry[targetMajor];

        if (!targetLine) {
          throw new Error(
            `Downgrade path for method '${method}' major ${major} targets undefined major ${targetMajor}`,
          );
        }

        if (targetMajor >= major) {
          throw new Error(
            `Downgrade path for method '${method}' major ${major} must target an older major than ${major}`,
          );
        }

        if (
          downgradePath.from.major !== major ||
          downgradePath.from.minor !== line.latestMinor
        ) {
          throw new Error(
            `Downgrade path for method '${method}' major ${major} to major ${targetMajor} must start at latest minor ${line.latestMinor} of major ${major}`,
          );
        }

        if (
          downgradePath.to.major !== targetMajor ||
          downgradePath.to.minor !== targetLine.latestMinor
        ) {
          throw new Error(
            `Downgrade path for method '${method}' major ${major} to major ${targetMajor} must end at latest minor ${targetLine.latestMinor} of major ${targetMajor}`,
          );
        }
      }
    }
  }

  // Second pass: Zod-schema-level compatibility. Kept separate so the error
  // surface of the first pass stays strictly structural - callers can rely on
  // structural messages landing before any JSON Schema complaint.
  assertSchemaCompatibility(registry);
}

export function validateVersionedRpcRegistryDegrades<
  Registry extends UncheckedVersionedRpcRegistry,
>(registry: Registry, floorMethodNames: readonly string[]): void {
  const floorMethods = new Set(floorMethodNames);

  for (const method of Object.keys(registry)) {
    if (floorMethods.has(method)) {
      continue;
    }

    const degrade = registry[method].degrade;
    if (degrade === undefined) {
      throw new Error(
        `Non-floor method '${method}' must declare a degrade strategy`,
      );
    }

    if (degrade.kind === "unsupported") {
      continue;
    }

    if (degrade.kind !== "fallback") {
      throw new Error(
        `Non-floor method '${method}' has an unknown degrade strategy`,
      );
    }

    validateFallbackDegrade(method, registry, floorMethods, degrade);
  }
}

function validateFallbackDegrade(
  method: string,
  registry: UncheckedVersionedRpcRegistry,
  floorMethods: ReadonlySet<string>,
  degrade: MethodDegradeDeclaration,
): void {
  if (degrade.kind !== "fallback") {
    return;
  }

  if (!floorMethods.has(degrade.to.method)) {
    throw new Error(
      `Fallback degrade for method '${method}' must target a floor method, got '${degrade.to.method}'`,
    );
  }

  const targetRegistry = registry[degrade.to.method];
  if (targetRegistry === undefined) {
    throw new Error(
      `Fallback degrade for method '${method}' targets unknown floor method '${degrade.to.method}'`,
    );
  }

  if (!hasOwnNumberKey(targetRegistry, degrade.to.major)) {
    throw new Error(
      `Fallback degrade for method '${method}' targets missing major ${degrade.to.major} on floor method '${degrade.to.method}'`,
    );
  }

  const targetLine = targetRegistry[degrade.to.major];
  if (!hasOwnNumberKey(targetLine.versions, degrade.to.minor)) {
    throw new Error(
      `Fallback degrade for method '${method}' targets missing version ${degrade.to.major}.${degrade.to.minor} on floor method '${degrade.to.method}'`,
    );
  }

  if (typeof degrade.adaptRequest !== "function") {
    throw new Error(
      `Fallback degrade for method '${method}' must declare adaptRequest`,
    );
  }

  if (typeof degrade.adaptResponse !== "function") {
    throw new Error(
      `Fallback degrade for method '${method}' must declare adaptResponse`,
    );
  }
}

function assertSchemaCompatibility(
  registry: UncheckedVersionedRpcRegistry,
): void {
  const schemas = toJsonSchemas(registry);

  for (const method in registry) {
    const methodRegistry = registry[method];
    const majors = getSortedNumberKeys(methodRegistry);

    for (const major of majors) {
      const line = methodRegistry[major];
      const minors = getSortedNumberKeys(line.versions);

      for (let index = 1; index < minors.length; index += 1) {
        const previousMinor = minors[index - 1];
        const currentMinor = minors[index];
        const previous = schemas[method][major][previousMinor];
        const current = schemas[method][major][currentMinor];

        const requestViolation = findAdditivityViolation(
          previous.request,
          current.request,
        );
        if (requestViolation !== null) {
          throw new Error(
            `Minor ${major}.${currentMinor} for method '${method}' request ${describeAdditivityViolation(requestViolation)} from ${major}.${previousMinor}`,
          );
        }

        const responseViolation = findAdditivityViolation(
          previous.response,
          current.response,
        );
        if (responseViolation !== null) {
          throw new Error(
            `Minor ${major}.${currentMinor} for method '${method}' response ${describeAdditivityViolation(responseViolation)} from ${major}.${previousMinor}`,
          );
        }
      }
    }

    for (let index = 1; index < majors.length; index += 1) {
      const previousMajor = majors[index - 1];
      const currentMajor = majors[index];
      const previousLine = methodRegistry[previousMajor];
      const currentLine = methodRegistry[currentMajor];
      const previousLatest =
        schemas[method][previousMajor][previousLine.latestMinor];
      const currentLatest =
        schemas[method][currentMajor][currentLine.latestMinor];

      const requestBreak = findBreakingChange(
        previousLatest.request,
        currentLatest.request,
      );
      const responseBreak = findBreakingChange(
        previousLatest.response,
        currentLatest.response,
      );

      if (requestBreak === null && responseBreak === null) {
        throw new Error(
          `Major bump ${previousMajor} -> ${currentMajor} for method '${method}' is not a breaking change (could have shipped as a minor)`,
        );
      }
    }
  }
}

// ---- Zod-aware registry helpers ---------------------------------------- //

// Fingerprint types and structural-diff helpers come from the shared
// `json-schema-fingerprint` module so RPC and record frameworks stay
// in lock-step on what counts as a breaking change.

export type {
  AnyOfJsonSchema,
  ArrayJsonSchema,
  EnumJsonSchema,
  JsonSchemaFingerprint,
  ObjectJsonSchema,
} from "./json-schema-fingerprint";

export type ContractJsonSchemas = {
  readonly request: JsonSchemaFingerprint;
  readonly response: JsonSchemaFingerprint;
};

export type RegistryJsonSchemas = Readonly<
  Record<
    string,
    Readonly<Record<number, Readonly<Record<number, ContractJsonSchemas>>>>
  >
>;

/**
 * Converts every installed contract's request and response Zod schemas
 * to normalized fingerprints. Throws when a schema is none of the
 * shapes the framework supports (object / enum / anyOf / array).
 *
 * Accepts the unchecked registry shape so callers can introspect
 * schemas before (or without) running `validateVersionedRpcRegistry()`.
 */
export function toJsonSchemas(
  registry: UncheckedVersionedRpcRegistry,
): RegistryJsonSchemas {
  const view: Record<
    string,
    Record<number, Record<number, ContractJsonSchemas>>
  > = {};

  for (const method in registry) {
    const methodView: Record<number, Record<number, ContractJsonSchemas>> = {};

    for (const major of getSortedNumberKeys(registry[method])) {
      const line = registry[method][major];
      const lineView: Record<number, ContractJsonSchemas> = {};

      for (const minor of getSortedNumberKeys(line.versions)) {
        const contract = line.versions[minor].contract;
        lineView[minor] = {
          request: toJsonSchemaFingerprint(
            contract.requestSchema,
            `${method} ${major}.${minor} request`,
          ),
          response: toJsonSchemaFingerprint(
            contract.responseSchema,
            `${method} ${major}.${minor} response`,
          ),
        };
      }

      methodView[major] = lineView;
    }

    view[method] = methodView;
  }

  return view;
}

type LatestMajorContract<
  Registry extends MethodVersionRegistry,
  Major extends keyof Registry & number,
> = Registry[Major] extends {
  versions: infer Versions extends Readonly<
    Record<number, { contract: AnyRpcContract }>
  >;
  latestMinor: infer LatestMinor;
}
  ? LatestMinor extends keyof Versions & number
    ? Versions[LatestMinor]["contract"]
    : never
  : never;

/**
 * Returns the latest installed contract for the entire method registry or for a
 * specific major line.
 */
export function getLatestContract<Registry extends MethodVersionRegistry>(
  registry: Registry,
  major: undefined,
): LatestContract<Registry>;
export function getLatestContract<
  Registry extends MethodVersionRegistry,
  Major extends keyof Registry & number,
>(registry: Registry, major: Major): LatestMajorContract<Registry, Major>;
export function getLatestContract<
  Registry extends MethodVersionRegistry,
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
 * Walks the installed version chain from `fromVersion` to `toVersion`.
 *
 * Every non-initial installed version carries its upgrade path from the previous
 * installed version, so cross-major and same-major upgrades share one traversal.
 */
export function upgradeRequestToVersion<
  Registry extends MethodVersionRegistry,
  const FromVersion extends InstalledSchemaVersion<Registry>,
  const ToVersion extends InstalledSchemaVersion<Registry>,
>(
  registry: Registry,
  fromVersion: FromVersion,
  toVersion: ToVersion,
  request: RequestOf<ContractForInstalledVersion<Registry, FromVersion>>,
): RequestOf<ContractForInstalledVersion<Registry, ToVersion>> {
  assertUpgradeOrder(fromVersion, toVersion);

  if (isSameSchemaVersion(fromVersion, toVersion)) {
    return request as RequestOf<
      ContractForInstalledVersion<Registry, ToVersion>
    >;
  }

  const installedVersions = listInstalledVersions(registry);
  const fromIndex = findVersionIndex(installedVersions, fromVersion);
  const toIndex = findVersionIndex(installedVersions, toVersion);
  let currentRequest: Parameters<
    RuntimeUpgradePath<Registry>["upgradeRequest"]
  >[0] = request;

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
      versionEntry.upgradeFromPreviousVersion as RuntimeUpgradePath<Registry>;
    currentRequest = runtimeUpgradePath.upgradeRequest(currentRequest);
  }

  return currentRequest as RequestOf<
    ContractForInstalledVersion<Registry, ToVersion>
  >;
}

/**
 * Response counterpart to `upgradeRequestToVersion()`.
 */
export function upgradeResponseToVersion<
  Registry extends MethodVersionRegistry,
  const FromVersion extends InstalledSchemaVersion<Registry>,
  const ToVersion extends InstalledSchemaVersion<Registry>,
>(
  registry: Registry,
  fromVersion: FromVersion,
  toVersion: ToVersion,
  response: ResponseOf<ContractForInstalledVersion<Registry, FromVersion>>,
): ResponseOf<ContractForInstalledVersion<Registry, ToVersion>> {
  assertUpgradeOrder(fromVersion, toVersion);

  if (isSameSchemaVersion(fromVersion, toVersion)) {
    return response as ResponseOf<
      ContractForInstalledVersion<Registry, ToVersion>
    >;
  }

  const installedVersions = listInstalledVersions(registry);
  const fromIndex = findVersionIndex(installedVersions, fromVersion);
  const toIndex = findVersionIndex(installedVersions, toVersion);
  let currentResponse: Parameters<
    RuntimeUpgradePath<Registry>["upgradeResponse"]
  >[0] = response;

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
      versionEntry.upgradeFromPreviousVersion as RuntimeUpgradePath<Registry>;
    currentResponse = runtimeUpgradePath.upgradeResponse(currentResponse);
  }

  return currentResponse as ResponseOf<
    ContractForInstalledVersion<Registry, ToVersion>
  >;
}

/**
 * Uses a direct downgrade bridge from the latest installed version of `fromMajor`
 * to the latest installed version of `toMajor`.
 *
 * Downgrades are intentionally not chained through intermediate majors. Callers
 * must author any direct compatibility bridge they want to support.
 */
export function downgradeRequestAcrossMajors<
  Registry extends MethodVersionRegistry,
  FromMajor extends keyof Registry & number,
  ToMajor extends keyof Registry & number,
>(
  registry: Registry,
  fromMajor: FromMajor,
  toMajor: ToMajor,
  request: RequestOf<LatestMajorContract<Registry, FromMajor>>,
): DowngradeResult<RequestOf<LatestMajorContract<Registry, ToMajor>>> {
  if (Number(fromMajor) === Number(toMajor)) {
    // Re-parse the request against the target major's request schema
    // so the narrowing happens at runtime via zod rather than through
    // a chained type assertion. With `fromMajor === toMajor` the source
    // and target schemas resolve to the same instance, so the parse is
    // an identity check that produces the type the caller expects.
    const targetLine = getMajorLine(registry, toMajor);
    const targetContract = targetLine.versions[targetLine.latestMinor].contract;
    type ToRequest = RequestOf<LatestMajorContract<Registry, ToMajor>>;
    const parsed: ToRequest = targetContract.requestSchema.parse(
      request,
    ) as ToRequest;
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

  type RuntimePath = RuntimeDowngradePath<Registry>;
  const runtimeDowngradePath = downgradePath as RuntimePath;
  type ToResult = DowngradeResult<
    RequestOf<LatestMajorContract<Registry, ToMajor>>
  >;
  const downgraded = runtimeDowngradePath.downgradeRequest(request) as ToResult;
  return downgraded;
}

/**
 * Response counterpart to `downgradeRequestAcrossMajors()`.
 */
export function downgradeResponseAcrossMajors<
  Registry extends MethodVersionRegistry,
  FromMajor extends keyof Registry & number,
  ToMajor extends keyof Registry & number,
>(
  registry: Registry,
  fromMajor: FromMajor,
  toMajor: ToMajor,
  response: ResponseOf<LatestMajorContract<Registry, FromMajor>>,
): DowngradeResult<ResponseOf<LatestMajorContract<Registry, ToMajor>>> {
  if (Number(fromMajor) === Number(toMajor)) {
    // Re-parse against the target major's response schema for runtime
    // narrowing in the same-major fast path (see request counterpart).
    const targetLine = getMajorLine(registry, toMajor);
    const targetContract = targetLine.versions[targetLine.latestMinor].contract;
    type ToResponse = ResponseOf<LatestMajorContract<Registry, ToMajor>>;
    const parsed: ToResponse = targetContract.responseSchema.parse(
      response,
    ) as ToResponse;
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

  type RuntimePath = RuntimeDowngradePath<Registry>;
  const runtimeDowngradePath = downgradePath as RuntimePath;
  type ToResult = DowngradeResult<
    ResponseOf<LatestMajorContract<Registry, ToMajor>>
  >;
  const downgraded = runtimeDowngradePath.downgradeResponse(
    response,
  ) as ToResult;
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
    .filter((key) => Number.isInteger(key))
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
  Registry extends MethodVersionRegistry,
  Major extends keyof Registry & number,
>(registry: Registry, major: Major): Registry[Major] {
  const line = registry[major];

  if (!line) {
    throw new Error(`Major ${major} is not defined in the method registry`);
  }

  return line;
}

function getVersionEntry<
  Registry extends MethodVersionRegistry,
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
      `Version ${major}.${minor} is not defined in the method registry`,
    );
  }

  return entry;
}

function listInstalledVersions<Registry extends MethodVersionRegistry>(
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

function findVersionIndex<Registry extends MethodVersionRegistry>(
  versions: Array<InstalledSchemaVersion<Registry>>,
  version: SchemaVersion,
): number {
  const index = versions.findIndex((installedVersion) =>
    isSameSchemaVersion(installedVersion, version),
  );

  if (index === -1) {
    throw new Error(
      `Version ${version.major}.${version.minor} is not defined in the method registry`,
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
