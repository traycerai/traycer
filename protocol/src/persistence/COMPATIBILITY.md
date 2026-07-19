# Persistence compatibility policy

The persistence registry is the authority for Traycer's versioned on-disk and
Yjs record contracts. Its schema versions are independent of both npm package
versions and RPC method versions.

## Epic contract

The registered `epic` schema is one persistence contract. Its compatibility
surface includes:

- every top-level epic field;
- chats and every nested chat/message shape;
- artifacts and deleted-artifact records; and
- TUI agents and their provider-specific state.

Production code can read and write those Yjs subtrees independently, but that
runtime access pattern does not make them separate versioned contracts. A
change anywhere under the registered epic schema is a persistence change.

## Same-major changes

Readers treat newer records in the same persistence major as compatible. A
same-major change must therefore preserve both directions needed during a
rolling upgrade: the new reader accepts existing records, and shipped readers
accept records written by the new writer.

A new object key can generally remain in the same major only when its input
schema accepts absence, normally through `.default(...)` or `.optional()`. An
old Zod object reader strips the unknown key, while the new reader can still
open records that predate it. Review the writer and downgrade behavior as well;
schema additivity alone does not prove the feature is operationally compatible.
`nullable()` by itself is not sufficient because it accepts `null`, not a
missing key.

The following changes are breaking unless an explicit compatibility mechanism
proves otherwise:

- removing or renaming a field;
- changing a field's type or narrowing its accepted values;
- adding a field whose input schema does not accept absence;
- adding or removing an enum value or discriminated-union variant;
- changing defaults, transforms, or codecs so old and new readers disagree on
  the persisted meaning; or
- moving data between subtrees in a way that makes either representation
  unreadable.

A breaking change requires a new registered persistence major and an explicit
migration/downgrade strategy. Regenerating a fixture is not a substitute for
versioning the contract.

## Frozen epic-schema guard

`epic-schema-surface-compat.test.ts` resolves the latest epic schema through the
public persistence registry and compares both of its JSON-Schema IO surfaces:

- `storage` (`io: "input"`) describes accepted persisted input; and
- `domain` (default/output mode) describes the parsed value exposed to
  consumers.

The guard intentionally fails on **all** drift, including a compatible additive
change. This forces the schema diff and compatibility reasoning into review.
After classifying an approved same-major change—or after completing the
required version and migration work for a breaking change—regenerate the
fixture from the repository root:

```sh
bun run protocol/scripts/snapshot-epic-schema-surface.ts > \
  protocol/src/persistence/epic/__tests__/__fixtures__/epic-schema-surface.ts
```

Never edit the generated fixture by hand. Commit its diff with the schema
change so reviewers can see the complete persistence-contract change.
