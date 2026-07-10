import { z } from "zod";

declare const validatedMethodVersionRegistryBrand: unique symbol;
declare const validatedVersionedRpcRegistryBrand: unique symbol;

export type SchemaVersion = {
  major: number;
  minor: number;
};

// Single source of truth for the wire error codes. The type is derived from
// this array so adding a code here automatically widens `RpcErrorCode` and is
// recognized by `isRpcErrorCode` - no parallel list to keep in sync.
export const RPC_ERROR_CODES = [
  "RPC_ERROR",
  "DOWNGRADE_UNSUPPORTED",
  "INCOMPATIBLE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "E_HOST_UNSUPPORTED",
  "WORKTREE_BUSY",
  "WORKTREE_REBIND_BLOCKED",
  "WORKTREE_SETUP_FAILED",
  "WORKTREE_SETUP_CANCELLED",
  "WORKTREE_MISSING",
  "WORKSPACE_BINDING_REQUIRED",
  "WORKTREE_REMOVE_LAST_ENTRY",
  "PROVIDER_DISABLED",
  "SENDER_TUI_UNSUPPORTED",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export function isRpcErrorCode(value: string): value is RpcErrorCode {
  return (RPC_ERROR_CODES as readonly string[]).includes(value);
}

export type RpcErrorDetails = {
  code: RpcErrorCode;
  message: string;
};

export type RpcContract<
  ReqSchema extends z.ZodType,
  ResSchema extends z.ZodType,
> = {
  method: string;
  schemaVersion: SchemaVersion;
  requestSchema: ReqSchema;
  responseSchema: ResSchema;
};

export type AnyRpcContract = RpcContract<z.ZodType, z.ZodType>;

export type RequestOf<Contract> =
  Contract extends RpcContract<infer ReqSchema, infer _ResSchema>
    ? z.infer<ReqSchema>
    : never;

export type ResponseOf<Contract> =
  Contract extends RpcContract<infer _ReqSchema, infer ResSchema>
    ? z.infer<ResSchema>
    : never;

export type RpcRequestFor<Contract> = Contract extends AnyRpcContract
  ? {
      requestId: string;
      method: Contract["method"];
      schemaVersion: Contract["schemaVersion"];
      params: RequestOf<Contract>;
    }
  : never;

export type RpcSuccessFor<Contract> = Contract extends AnyRpcContract
  ? {
      requestId: string;
      method: Contract["method"];
      schemaVersion: Contract["schemaVersion"];
      result: ResponseOf<Contract>;
    }
  : never;

export type RpcErrorFor<Contract> = Contract extends AnyRpcContract
  ? {
      requestId: string;
      method: Contract["method"];
      schemaVersion: Contract["schemaVersion"];
      error: RpcErrorDetails;
    }
  : never;

export type RpcResultFor<Contract> =
  | RpcSuccessFor<Contract>
  | RpcErrorFor<Contract>;

type SameMethodPair<
  From extends AnyRpcContract,
  To extends AnyRpcContract,
> = From["method"] extends To["method"]
  ? To["method"] extends From["method"]
    ? true
    : false
  : false;

export type UpgradePath<
  From extends AnyRpcContract,
  To extends AnyRpcContract,
> =
  SameMethodPair<From, To> extends true
    ? {
        from: From["schemaVersion"];
        to: To["schemaVersion"];
        upgradeRequest: (request: RequestOf<From>) => RequestOf<To>;
        upgradeResponse: (response: ResponseOf<From>) => ResponseOf<To>;
      }
    : never;

export type DowngradeResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: RpcErrorDetails };

export type DowngradePath<
  From extends AnyRpcContract,
  To extends AnyRpcContract,
> =
  SameMethodPair<From, To> extends true
    ? {
        from: From["schemaVersion"];
        to: To["schemaVersion"];
        downgradeRequest: (
          request: RequestOf<From>,
        ) => DowngradeResult<RequestOf<To>>;
        downgradeResponse: (
          response: ResponseOf<From>,
        ) => DowngradeResult<ResponseOf<To>>;
      }
    : never;

export type UnsupportedMethodDegrade = {
  readonly kind: "unsupported";
};

export type FallbackMethodDegrade<
  Canonical extends AnyRpcContract,
  Fallback extends AnyRpcContract,
  FloorMethod extends string,
> = {
  readonly kind: "fallback";
  readonly to: {
    readonly method: FloorMethod;
    readonly major: Fallback["schemaVersion"]["major"];
    readonly minor: Fallback["schemaVersion"]["minor"];
  };
  readonly adaptRequest: (request: RequestOf<Canonical>) => RequestOf<Fallback>;
  readonly adaptResponse: (
    response: ResponseOf<Fallback>,
  ) => ResponseOf<Canonical>;
};

export type MethodDegradeDeclaration<
  Canonical extends AnyRpcContract = AnyRpcContract,
  Fallback extends AnyRpcContract = AnyRpcContract,
  FloorMethod extends string = string,
> =
  | UnsupportedMethodDegrade
  | FallbackMethodDegrade<Canonical, Fallback, FloorMethod>;

type ErasedFallbackMethodDegrade<
  Canonical extends AnyRpcContract,
  FloorMethod extends string,
> = {
  readonly kind: "fallback";
  readonly to: {
    readonly method: FloorMethod;
    readonly major: number;
    readonly minor: number;
  };
  readonly adaptRequest: (request: RequestOf<Canonical>) => unknown;
  readonly adaptResponse: (response: never) => ResponseOf<Canonical>;
};

type ErasedMethodDegradeDeclaration<
  Canonical extends AnyRpcContract,
  FloorMethod extends string,
> =
  | UnsupportedMethodDegrade
  | ErasedFallbackMethodDegrade<Canonical, FloorMethod>;

/**
 * Erased bridge shape used by registry storage and traversal internals.
 *
 * Author bridges with `defineUpgradePath()` instead of constructing this type
 * directly. The `never` parameter preserves assignability for narrower adapters
 * after erasure.
 */
export type AnyUpgradePath = {
  from: SchemaVersion;
  to: SchemaVersion;
  upgradeRequest: (request: never) => object;
  upgradeResponse: (response: never) => object;
};

/**
 * Erased downgrade bridge shape used by registry storage and traversal internals.
 *
 * Author bridges with `defineDowngradePath()` instead of constructing this type
 * directly. As with `AnyUpgradePath`, the `never` parameter keeps narrower
 * downgrade functions assignable after erasure.
 */
export type AnyDowngradePath = {
  from: SchemaVersion;
  to: SchemaVersion;
  downgradeRequest: (request: never) => DowngradeResult<object>;
  downgradeResponse: (response: never) => DowngradeResult<object>;
};

export type VersionEntry<
  Contract extends AnyRpcContract,
  Upgrade extends AnyUpgradePath | null,
> = {
  readonly contract: Contract;
  readonly upgradeFromPreviousVersion: Upgrade;
};

export type AnyVersionEntry = VersionEntry<
  AnyRpcContract,
  AnyUpgradePath | null
>;

type NumberKeys<RecordType> = keyof RecordType & number;

export type MajorVersionLine<
  Versions extends Readonly<Record<number, AnyVersionEntry>>,
  LatestMinor extends NumberKeys<Versions>,
  Downgrades extends Readonly<Record<number, AnyDowngradePath>>,
> = {
  readonly latestMinor: LatestMinor;
  readonly versions: Versions;
  readonly downgradePathsFromLatest: Downgrades;
};

type AnyMajorVersionLine = MajorVersionLine<
  Readonly<Record<number, AnyVersionEntry>>,
  number,
  Readonly<Record<number, AnyDowngradePath>>
>;

/**
 * Raw method registry shape before validation.
 *
 * Use this at boundaries where a registry can still be malformed. Promote it to
 * `MethodVersionRegistry` with `defineVersionedRpcRegistry()` or
 * `validateVersionedRpcRegistry()` before calling traversal helpers.
 */
export type UncheckedMethodVersionRegistry = Readonly<
  Record<number, AnyMajorVersionLine>
> & {
  readonly degrade?: MethodDegradeDeclaration;
};

/**
 * Validated method registry required by the traversal helpers.
 *
 * Guarantees:
 * - `latestMinor` is installed and is the highest installed minor in the line
 * - each contract matches its major/minor slot and method key
 * - each non-initial installed version defines an upgrade from the previous
 *   installed version in the overall chain
 * - each downgrade originates from the latest installed version of its line and
 *   targets the latest installed version of an older major
 */
export type MethodVersionRegistry<
  Registry extends UncheckedMethodVersionRegistry =
    UncheckedMethodVersionRegistry,
  Latest = unknown,
> = Registry & {
  readonly [validatedMethodVersionRegistryBrand]: Latest;
};

/**
 * Raw multi-method registry shape before validation.
 */
export type UncheckedVersionedRpcRegistry = Readonly<
  Record<string, UncheckedMethodVersionRegistry>
>;

type ValidatedVersionedRpcRegistryMethods<
  Registry extends UncheckedVersionedRpcRegistry,
> = {
  readonly [Method in keyof Registry & string]: MethodVersionRegistry<
    Registry[Method],
    LatestContractFromUncheckedRegistry<Registry[Method]>
  >;
};

type ValidatedVersionedRpcRegistryBrand = {
  readonly [validatedVersionedRpcRegistryBrand]: true;
};

/**
 * Validated multi-method registry.
 *
 * Usage pattern:
 * - static source literals: `defineVersionedRpcRegistry(...)`
 * - dynamic inputs: `validateVersionedRpcRegistry(registry)` then use the refined value
 */
export type VersionedRpcRegistry<
  Registry extends UncheckedVersionedRpcRegistry =
    UncheckedVersionedRpcRegistry,
> = ValidatedVersionedRpcRegistryMethods<Registry> &
  ValidatedVersionedRpcRegistryBrand;

type DigitsLessThan = {
  "0": never;
  "1": "0";
  "2": "0" | "1";
  "3": "0" | "1" | "2";
  "4": "0" | "1" | "2" | "3";
  "5": "0" | "1" | "2" | "3" | "4";
  "6": "0" | "1" | "2" | "3" | "4" | "5";
  "7": "0" | "1" | "2" | "3" | "4" | "5" | "6";
  "8": "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7";
  "9": "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";
};

type DigitLessThan<
  Left extends string,
  Right extends string,
> = Left extends keyof DigitsLessThan
  ? Right extends keyof DigitsLessThan
    ? Left extends DigitsLessThan[Right]
      ? true
      : false
    : false
  : false;

// Recursion depth is bounded by the number of decimal digits, not the value.
type LengthTuple<
  Value extends string,
  Accumulator extends unknown[] = [],
> = Value extends `${string}${infer Rest}`
  ? LengthTuple<Rest, [unknown, ...Accumulator]>
  : Accumulator;

type TupleShorterThan<
  Left extends unknown[],
  Right extends unknown[],
> = Left extends [unknown, ...infer LeftRest]
  ? Right extends [unknown, ...infer RightRest]
    ? TupleShorterThan<LeftRest, RightRest>
    : false
  : Right extends [unknown, ...unknown[]]
    ? true
    : false;

type SameLengthLessThan<
  Left extends string,
  Right extends string,
> = Left extends `${infer LeftHead}${infer LeftTail}`
  ? Right extends `${infer RightHead}${infer RightTail}`
    ? LeftHead extends RightHead
      ? SameLengthLessThan<LeftTail, RightTail>
      : DigitLessThan<LeftHead, RightHead>
    : false
  : false;

type IsLessThan<Left extends number, Right extends number> = Left extends Right
  ? false
  : `${Left}` extends infer LeftString extends string
    ? `${Right}` extends infer RightString extends string
      ? LengthTuple<LeftString> extends infer LeftLength extends unknown[]
        ? LengthTuple<RightString> extends infer RightLength extends unknown[]
          ? TupleShorterThan<LeftLength, RightLength> extends true
            ? true
            : TupleShorterThan<RightLength, LeftLength> extends true
              ? false
              : SameLengthLessThan<LeftString, RightString>
          : false
        : false
      : false
    : false;

type LowerNumbers<
  Values extends number,
  UpperBound extends number,
> = Values extends number
  ? IsLessThan<Values, UpperBound> extends true
    ? Values
    : never
  : never;

type AllOtherNumbersAreLessThan<
  Candidate extends number,
  Values extends number,
> = false extends (
  Exclude<Values, Candidate> extends infer Other extends number
    ? IsLessThan<Other, Candidate>
    : never
)
  ? false
  : true;

type HighestNumber<Values extends number, AllValues extends number = Values> = [
  Values,
] extends [never]
  ? never
  : Values extends infer Candidate extends number
    ? AllOtherNumbersAreLessThan<Candidate, AllValues> extends true
      ? Candidate
      : never
    : never;

type ContractForRegistrySlot<
  Method extends string,
  Major extends number,
  Minor extends number,
  Contract extends AnyRpcContract,
> = Contract extends {
  method: Method;
  schemaVersion: {
    major: Major;
    minor: Minor;
  };
}
  ? Contract
  : never;

type ContractAtVersion<
  Registry extends UncheckedMethodVersionRegistry,
  Major extends NumberKeys<Registry>,
  Minor extends NumberKeys<Registry[Major]["versions"]>,
> = Registry[Major]["versions"][Minor]["contract"];

type LatestContractForLine<Line extends AnyMajorVersionLine> =
  Line["versions"][Line["latestMinor"]]["contract"];

type PreviousInstalledMinor<
  Versions extends Readonly<Record<number, AnyVersionEntry>>,
  Minor extends number,
> = HighestNumber<LowerNumbers<NumberKeys<Versions>, Minor>>;

type PreviousInstalledMajor<
  Registry extends UncheckedMethodVersionRegistry,
  Major extends number,
> = HighestNumber<LowerNumbers<NumberKeys<Registry>, Major>>;

type PreviousInstalledContract<
  Registry extends UncheckedMethodVersionRegistry,
  Major extends NumberKeys<Registry>,
  Minor extends NumberKeys<Registry[Major]["versions"]>,
> =
  PreviousInstalledMinor<
    Registry[Major]["versions"],
    Minor
  > extends infer PreviousMinor
    ? [PreviousMinor] extends [never]
      ? PreviousInstalledMajor<Registry, Major> extends infer PreviousMajor
        ? [PreviousMajor] extends [never]
          ? never
          : PreviousMajor extends NumberKeys<Registry>
            ? LatestContractForLine<Registry[PreviousMajor]>
            : never
        : never
      : PreviousMinor extends NumberKeys<Registry[Major]["versions"]>
        ? ContractAtVersion<Registry, Major, PreviousMinor>
        : never
    : never;

type ValidateVersionEntry<
  Method extends string,
  Registry extends UncheckedMethodVersionRegistry,
  Major extends NumberKeys<Registry>,
  Minor extends NumberKeys<Registry[Major]["versions"]>,
> = Registry[Major]["versions"][Minor] extends infer Entry extends
  AnyVersionEntry
  ? Entry["contract"] extends infer Contract extends AnyRpcContract
    ? {
        readonly contract: ContractForRegistrySlot<
          Method,
          Major,
          Minor,
          Contract
        >;
        readonly upgradeFromPreviousVersion: PreviousInstalledContract<
          Registry,
          Major,
          Minor
        > extends infer PreviousContract
          ? [PreviousContract] extends [never]
            ? null
            : PreviousContract extends AnyRpcContract
              ? UpgradePath<
                  PreviousContract,
                  ContractForRegistrySlot<Method, Major, Minor, Contract>
                >
              : never
          : never;
      }
    : never
  : never;

type ValidateLineVersions<
  Method extends string,
  Registry extends UncheckedMethodVersionRegistry,
  Major extends NumberKeys<Registry>,
> = {
  readonly [Minor in NumberKeys<
    Registry[Major]["versions"]
  >]: ValidateVersionEntry<Method, Registry, Major, Minor>;
};

type ValidateLineDowngrades<
  Registry extends UncheckedMethodVersionRegistry,
  Major extends NumberKeys<Registry>,
  Downgrades extends Readonly<Record<number, AnyDowngradePath>>,
> = {
  readonly [TargetMajor in keyof Downgrades &
    number]: TargetMajor extends NumberKeys<Registry>
    ? IsLessThan<TargetMajor, Major> extends true
      ? DowngradePath<
          LatestContractForLine<Registry[Major]>,
          LatestContractForLine<Registry[TargetMajor]>
        >
      : never
    : never;
};

type ValidateMajorVersionLine<
  Method extends string,
  Registry extends UncheckedMethodVersionRegistry,
  Major extends NumberKeys<Registry>,
> =
  Registry[Major] extends MajorVersionLine<
    infer Versions,
    infer _LatestMinor,
    infer Downgrades
  >
    ? {
        readonly latestMinor: HighestNumber<NumberKeys<Versions>>;
        readonly versions: ValidateLineVersions<Method, Registry, Major>;
        readonly downgradePathsFromLatest: ValidateLineDowngrades<
          Registry,
          Major,
          Downgrades
        >;
      }
    : never;

type ValidateMethodVersionRegistry<
  Method extends string,
  Registry extends UncheckedMethodVersionRegistry,
> = {
  readonly [Major in NumberKeys<Registry>]: ValidateMajorVersionLine<
    Method,
    Registry,
    Major
  >;
};

/**
 * Compile-time mirror of the runtime registry validator.
 *
 * Enforced invariants:
 * - registry key matches `contract.method`
 * - major/minor slots match `contract.schemaVersion`
 * - `latestMinor` points at the highest installed minor in the line
 * - each non-initial version defines an upgrade from the previous installed version
 * - downgrades target latest contracts on older majors only
 */
export type ValidateVersionedRpcRegistry<
  Registry extends UncheckedVersionedRpcRegistry,
> = {
  readonly [Method in keyof Registry & string]: ValidateMethodVersionRegistry<
    Method,
    Registry[Method]
  >;
};

export type ValidateVersionedRpcRegistryDegrades<
  Registry extends UncheckedVersionedRpcRegistry,
  FloorMethod extends string,
> = {
  readonly [Method in keyof Registry & string]: Method extends FloorMethod
    ? unknown
    : {
        readonly degrade: ErasedMethodDegradeDeclaration<
          LatestContractFromUncheckedRegistry<Registry[Method]>,
          FloorMethod
        >;
      };
};

type RegistryContractValue<Registry extends MethodVersionRegistry> = {
  [Major in NumberKeys<Registry>]: {
    [Minor in NumberKeys<Registry[Major]["versions"]>]: ContractAtVersion<
      Registry,
      Major,
      Minor
    >;
  }[NumberKeys<Registry[Major]["versions"]>];
}[NumberKeys<Registry>];

type RegistryRequestValue<Registry extends MethodVersionRegistry> = RequestOf<
  RegistryContractValue<Registry>
>;

type RegistryResponseValue<Registry extends MethodVersionRegistry> = ResponseOf<
  RegistryContractValue<Registry>
>;

type LatestContractFromUncheckedRegistry<
  Registry extends UncheckedMethodVersionRegistry,
> = [NumberKeys<Registry>] extends [never]
  ? AnyRpcContract
  : LatestContractForLine<Registry[HighestNumber<NumberKeys<Registry>>]>;

/**
 * The latest installed contract on the highest installed major line.
 */
export type LatestContract<Registry extends MethodVersionRegistry> =
  Registry[typeof validatedMethodVersionRegistryBrand];

export type InstalledSchemaVersion<Registry extends MethodVersionRegistry> = {
  [Major in NumberKeys<Registry>]: {
    [Minor in NumberKeys<Registry[Major]["versions"]>]: {
      major: Major;
      minor: Minor;
    };
  }[NumberKeys<Registry[Major]["versions"]>];
}[NumberKeys<Registry>];

export type ContractForInstalledVersion<
  Registry extends MethodVersionRegistry,
  Version extends InstalledSchemaVersion<Registry>,
> = ContractAtVersion<Registry, Version["major"], Version["minor"]>;

/**
 * Erased bridge view used while iterating across installed versions.
 *
 * Validation guarantees each stored bridge lines up with the previous installed
 * version in the chain, so traversal can safely operate over registry-wide unions.
 */
export type RuntimeUpgradePath<Registry extends MethodVersionRegistry> = {
  from: SchemaVersion;
  to: SchemaVersion;
  upgradeRequest: (
    request: RegistryRequestValue<Registry>,
  ) => RegistryRequestValue<Registry>;
  upgradeResponse: (
    response: RegistryResponseValue<Registry>,
  ) => RegistryResponseValue<Registry>;
};

/**
 * Erased direct-downgrade view used while executing a validated latest-line bridge.
 */
export type RuntimeDowngradePath<Registry extends MethodVersionRegistry> = {
  from: SchemaVersion;
  to: SchemaVersion;
  downgradeRequest: (
    request: RegistryRequestValue<Registry>,
  ) => DowngradeResult<RegistryRequestValue<Registry>>;
  downgradeResponse: (
    response: RegistryResponseValue<Registry>,
  ) => DowngradeResult<RegistryResponseValue<Registry>>;
};
