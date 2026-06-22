import { z } from "zod";

declare const validatedRecordVersionRegistryBrand: unique symbol;
declare const validatedVersionedRecordRegistryBrand: unique symbol;

/**
 * Versioned **record** framework - the persistence counterpart to the
 * versioned **RPC** framework.
 *
 * An RPC contract pairs a request schema with a response schema because both
 * sides of the wire call have to evolve together. A stored record only has
 * one shape, so this module mirrors every structural invariant of
 * `versioned-rpc-types.ts` with a single `schema` instead.
 *
 * Invariants enforced (see `validateVersionedRecordRegistry()`):
 *
 * - `latestMinor` is installed and is the highest installed minor in its line
 * - each contract matches its major/minor slot and `name` key
 * - each non-initial installed version defines an upgrade from the previous
 *   installed version
 * - downgrades originate at the latest installed version of the source major
 *   and target the latest installed version of an older major
 * - minors within a major line are purely additive; a minor may not drop a
 *   field that an earlier minor had
 * - major bumps must carry at least one breaking change (a removed field or
 *   a changed field schema) on the latest minor of each side
 *
 * The framework does not chain downgrades: persistence migration bridges are
 * authored as direct hops from a latest to a latest.
 */

export type SchemaVersion = {
  major: number;
  minor: number;
};

export type RecordErrorCode = "RECORD_ERROR" | "DOWNGRADE_UNSUPPORTED";

export type RecordErrorDetails = {
  code: RecordErrorCode;
  message: string;
};

export type RecordContract<Schema extends z.ZodType> = {
  name: string;
  schemaVersion: SchemaVersion;
  schema: Schema;
};

export type AnyRecordContract = RecordContract<z.ZodType>;

export type ValueOf<Contract> =
  Contract extends RecordContract<infer Schema> ? z.infer<Schema> : never;

type SameNamePair<
  From extends AnyRecordContract,
  To extends AnyRecordContract,
> = From["name"] extends To["name"]
  ? To["name"] extends From["name"]
    ? true
    : false
  : false;

export type RecordUpgradePath<
  From extends AnyRecordContract,
  To extends AnyRecordContract,
> =
  SameNamePair<From, To> extends true
    ? {
        from: From["schemaVersion"];
        to: To["schemaVersion"];
        upgradeRecord: (record: ValueOf<From>) => ValueOf<To>;
      }
    : never;

export type DowngradeResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: RecordErrorDetails };

export type RecordDowngradePath<
  From extends AnyRecordContract,
  To extends AnyRecordContract,
> =
  SameNamePair<From, To> extends true
    ? {
        from: From["schemaVersion"];
        to: To["schemaVersion"];
        downgradeRecord: (record: ValueOf<From>) => DowngradeResult<ValueOf<To>>;
      }
    : never;

/**
 * Erased upgrade bridge used by registry storage and traversal internals.
 *
 * Author bridges with `defineRecordUpgradePath()` instead of constructing
 * this type directly. The `never` parameter keeps narrower adapters
 * assignable after erasure; `unknown` (rather than `object`) on the
 * return side accommodates non-object records (enums, unions of
 * literals).
 */
export type AnyRecordUpgradePath = {
  from: SchemaVersion;
  to: SchemaVersion;
  upgradeRecord: (record: never) => unknown;
};

/**
 * Erased downgrade bridge shape used by registry storage and traversal internals.
 */
export type AnyRecordDowngradePath = {
  from: SchemaVersion;
  to: SchemaVersion;
  downgradeRecord: (record: never) => DowngradeResult<unknown>;
};

export type RecordVersionEntry<
  Contract extends AnyRecordContract,
  Upgrade extends AnyRecordUpgradePath | null,
> = {
  readonly contract: Contract;
  readonly upgradeFromPreviousVersion: Upgrade;
};

export type AnyRecordVersionEntry = RecordVersionEntry<
  AnyRecordContract,
  AnyRecordUpgradePath | null
>;

type NumberKeys<RecordType> = keyof RecordType & number;

export type MajorRecordVersionLine<
  Versions extends Readonly<Record<number, AnyRecordVersionEntry>>,
  LatestMinor extends NumberKeys<Versions>,
  Downgrades extends Readonly<Record<number, AnyRecordDowngradePath>>,
> = {
  readonly latestMinor: LatestMinor;
  readonly versions: Versions;
  readonly downgradePathsFromLatest: Downgrades;
};

type AnyMajorRecordVersionLine = MajorRecordVersionLine<
  Readonly<Record<number, AnyRecordVersionEntry>>,
  number,
  Readonly<Record<number, AnyRecordDowngradePath>>
>;

/**
 * Raw record-name registry shape before validation.
 *
 * Promote it to `RecordVersionRegistry` with
 * `defineVersionedRecordRegistry()` or `validateVersionedRecordRegistry()`
 * before calling traversal helpers.
 */
export type UncheckedRecordVersionRegistry = Readonly<
  Record<number, AnyMajorRecordVersionLine>
>;

/**
 * Validated record-name registry required by the traversal helpers.
 */
export type RecordVersionRegistry<
  Registry extends UncheckedRecordVersionRegistry =
    UncheckedRecordVersionRegistry,
  Latest = unknown,
> = Registry & {
  readonly [validatedRecordVersionRegistryBrand]: Latest;
};

/**
 * Raw multi-name registry shape before validation.
 */
export type UncheckedVersionedRecordRegistry = Readonly<
  Record<string, UncheckedRecordVersionRegistry>
>;

type ValidatedVersionedRecordRegistryNames<
  Registry extends UncheckedVersionedRecordRegistry,
> = {
  readonly [Name in keyof Registry & string]: RecordVersionRegistry<
    Registry[Name],
    LatestContractFromUncheckedRegistry<Registry[Name]>
  >;
};

type ValidatedVersionedRecordRegistryBrand = {
  readonly [validatedVersionedRecordRegistryBrand]: true;
};

/**
 * Validated multi-name registry.
 */
export type VersionedRecordRegistry<
  Registry extends UncheckedVersionedRecordRegistry =
    UncheckedVersionedRecordRegistry,
> = ValidatedVersionedRecordRegistryNames<Registry> &
  ValidatedVersionedRecordRegistryBrand;

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

type DigitLessThan<Left extends string, Right extends string> =
  Left extends keyof DigitsLessThan
    ? Right extends keyof DigitsLessThan
      ? Left extends DigitsLessThan[Right]
        ? true
        : false
      : false
    : false;

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

type SameLengthLessThan<Left extends string, Right extends string> =
  Left extends `${infer LeftHead}${infer LeftTail}`
    ? Right extends `${infer RightHead}${infer RightTail}`
      ? LeftHead extends RightHead
        ? SameLengthLessThan<LeftTail, RightTail>
        : DigitLessThan<LeftHead, RightHead>
      : false
    : false;

type IsLessThan<Left extends number, Right extends number> =
  Left extends Right
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

type HighestNumber<
  Values extends number,
  AllValues extends number = Values,
> = [Values] extends [never]
  ? never
  : Values extends infer Candidate extends number
    ? AllOtherNumbersAreLessThan<Candidate, AllValues> extends true
      ? Candidate
      : never
    : never;

type ContractForRegistrySlot<
  Name extends string,
  Major extends number,
  Minor extends number,
  Contract extends AnyRecordContract,
> = Contract extends {
  name: Name;
  schemaVersion: {
    major: Major;
    minor: Minor;
  };
}
  ? Contract
  : never;

type ContractAtVersion<
  Registry extends UncheckedRecordVersionRegistry,
  Major extends NumberKeys<Registry>,
  Minor extends NumberKeys<Registry[Major]["versions"]>,
> = Registry[Major]["versions"][Minor]["contract"];

type LatestContractForLine<Line extends AnyMajorRecordVersionLine> =
  Line["versions"][Line["latestMinor"]]["contract"];

type PreviousInstalledMinor<
  Versions extends Readonly<Record<number, AnyRecordVersionEntry>>,
  Minor extends number,
> = HighestNumber<LowerNumbers<NumberKeys<Versions>, Minor>>;

type PreviousInstalledMajor<
  Registry extends UncheckedRecordVersionRegistry,
  Major extends number,
> = HighestNumber<LowerNumbers<NumberKeys<Registry>, Major>>;

type PreviousInstalledContract<
  Registry extends UncheckedRecordVersionRegistry,
  Major extends NumberKeys<Registry>,
  Minor extends NumberKeys<Registry[Major]["versions"]>,
> = PreviousInstalledMinor<
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
  Name extends string,
  Registry extends UncheckedRecordVersionRegistry,
  Major extends NumberKeys<Registry>,
  Minor extends NumberKeys<Registry[Major]["versions"]>,
> = Registry[Major]["versions"][Minor] extends infer Entry extends
  AnyRecordVersionEntry
  ? Entry["contract"] extends infer Contract extends AnyRecordContract
    ? {
        readonly contract: ContractForRegistrySlot<
          Name,
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
            : PreviousContract extends AnyRecordContract
              ? RecordUpgradePath<
                  PreviousContract,
                  ContractForRegistrySlot<Name, Major, Minor, Contract>
                >
              : never
          : never;
      }
    : never
  : never;

type ValidateLineVersions<
  Name extends string,
  Registry extends UncheckedRecordVersionRegistry,
  Major extends NumberKeys<Registry>,
> = {
  readonly [Minor in NumberKeys<
    Registry[Major]["versions"]
  >]: ValidateVersionEntry<Name, Registry, Major, Minor>;
};

type ValidateLineDowngrades<
  Registry extends UncheckedRecordVersionRegistry,
  Major extends NumberKeys<Registry>,
  Downgrades extends Readonly<Record<number, AnyRecordDowngradePath>>,
> = {
  readonly [TargetMajor in keyof Downgrades &
    number]: TargetMajor extends NumberKeys<Registry>
    ? IsLessThan<TargetMajor, Major> extends true
      ? RecordDowngradePath<
          LatestContractForLine<Registry[Major]>,
          LatestContractForLine<Registry[TargetMajor]>
        >
      : never
    : never;
};

type ValidateMajorRecordVersionLine<
  Name extends string,
  Registry extends UncheckedRecordVersionRegistry,
  Major extends NumberKeys<Registry>,
> = Registry[Major] extends MajorRecordVersionLine<
  infer Versions,
  infer _LatestMinor,
  infer Downgrades
>
  ? {
      readonly latestMinor: HighestNumber<NumberKeys<Versions>>;
      readonly versions: ValidateLineVersions<Name, Registry, Major>;
      readonly downgradePathsFromLatest: ValidateLineDowngrades<
        Registry,
        Major,
        Downgrades
      >;
    }
  : never;

type ValidateRecordVersionRegistry<
  Name extends string,
  Registry extends UncheckedRecordVersionRegistry,
> = {
  readonly [Major in NumberKeys<Registry>]: ValidateMajorRecordVersionLine<
    Name,
    Registry,
    Major
  >;
};

/**
 * Compile-time mirror of the runtime registry validator.
 */
export type ValidateVersionedRecordRegistry<
  Registry extends UncheckedVersionedRecordRegistry,
> = {
  readonly [Name in keyof Registry & string]: ValidateRecordVersionRegistry<
    Name,
    Registry[Name]
  >;
};

type RegistryContractValue<Registry extends RecordVersionRegistry> = {
  [Major in NumberKeys<Registry>]: {
    [Minor in NumberKeys<Registry[Major]["versions"]>]: ContractAtVersion<
      Registry,
      Major,
      Minor
    >;
  }[NumberKeys<Registry[Major]["versions"]>];
}[NumberKeys<Registry>];

type RegistryRecordValue<Registry extends RecordVersionRegistry> = ValueOf<
  RegistryContractValue<Registry>
>;

type LatestContractFromUncheckedRegistry<
  Registry extends UncheckedRecordVersionRegistry,
> = [NumberKeys<Registry>] extends [never]
  ? AnyRecordContract
  : LatestContractForLine<Registry[HighestNumber<NumberKeys<Registry>>]>;

/**
 * The latest installed contract on the highest installed major line.
 */
export type LatestRecordContract<Registry extends RecordVersionRegistry> =
  Registry[typeof validatedRecordVersionRegistryBrand];

export type InstalledSchemaVersion<Registry extends RecordVersionRegistry> = {
  [Major in NumberKeys<Registry>]: {
    [Minor in NumberKeys<Registry[Major]["versions"]>]: {
      major: Major;
      minor: Minor;
    };
  }[NumberKeys<Registry[Major]["versions"]>];
}[NumberKeys<Registry>];

export type ContractForInstalledVersion<
  Registry extends RecordVersionRegistry,
  Version extends InstalledSchemaVersion<Registry>,
> = ContractAtVersion<Registry, Version["major"], Version["minor"]>;

/**
 * Erased upgrade-bridge view used while iterating across installed versions.
 */
export type RuntimeRecordUpgradePath<Registry extends RecordVersionRegistry> = {
  from: SchemaVersion;
  to: SchemaVersion;
  upgradeRecord: (
    record: RegistryRecordValue<Registry>,
  ) => RegistryRecordValue<Registry>;
};

/**
 * Erased direct-downgrade view used while executing a validated latest-line bridge.
 */
export type RuntimeRecordDowngradePath<Registry extends RecordVersionRegistry> =
  {
    from: SchemaVersion;
    to: SchemaVersion;
    downgradeRecord: (
      record: RegistryRecordValue<Registry>,
    ) => DowngradeResult<RegistryRecordValue<Registry>>;
  };
