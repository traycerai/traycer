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

## Chat-sync contract

A published chat is two registered records: `chat-head`, the small mutable
pointer stored as opaque JSON on the chat's cloud row, and `chat-shard`, one
immutable, content-addressed part of the transcript that the head names by
`(sha256, byteLength)`. Neither is a Yjs shape: the owning host serializes them
and readers on other release cadences — cloud renderers, clone targets, the
backfill job — fetch and assemble them.

That reader population is the difference from the epic record. An epic reader is
the host that wrote the doc; a chat-sync reader is shipped code that cannot be
redeployed alongside the writer, and a clone target does not just read a chat —
it re-publishes one. Anything a reader drops on the way through is destroyed,
not merely ignored. Worse than in a single-object layout: shards are addressed
by the hash of their canonical bytes, so a reader that loses one key does not
just publish a lossy chat, it mints a new address for a cohort that never
changed and re-uploads it.

Six mechanisms follow from that, and one ritual keeps them coupled.

### 1. Presentation core vs opaque host-private

The head is partitioned:

- `core` is what readers interpret (identity, metadata, run settings,
  lifecycle). It evolves at reader speed under the same-major rules above.
- `hostPrivate` is opaque to the protocol — a `revision` plus a validated-JSON
  bag. Session-chain and pending-wake state live here. Every reader preserves it
  verbatim and none interprets it, so the host evolves it freely with no record
  minor, no fixture regeneration, and no reader-compatibility argument.

The transcript is in neither: messages ride `chat-shard` parts, and events ride
the head's own section until they graduate (§6).

**Promotion is a one-way door.** A field may move `hostPrivate` → `core` with a
record minor bump. It may never move back: once shipped readers interpret a
field, removing it from `core` is a breaking change no matter where the bytes
end up. Adding a field straight to `core` is the same commitment — prefer
`hostPrivate` until a reader actually needs the field.

### 2. Semantic unknown-variant passthrough

Message `role`, content-block `type` and chat-event `type` are carried through a
passthrough codec (`chat-sync/passthrough.ts`) rather than a bare discriminated
union or enum. A reader that meets an unlisted variant surfaces it as
`value: null` and keeps the complete subtree in `raw`; the canonical encoder
re-emits `raw`, so the subtree survives a read/write cycle with its meaning
intact.

That is what reclassifies **adding** a content-block type, message role or
chat-event type from breaking to a **minor** for these records — the exception
to the "adding a discriminated-union variant / enum value is breaking" rule
above. Removing or renaming one is still breaking. So is a change anywhere else:
a new variant inside a nested union (a `userMessagePayload.kind`, a
`toolInputDetail.kind`) is not covered by the passthrough and follows the
ordinary rules. So is a new `chat-shard` `section` — that enum is closed.

Passthrough is for vocabulary a reader lacks, not a blanket swallow of
corruption: a **known** variant that fails to parse still rejects the record.

Losslessness here is **semantic**, not byte-for-byte. `canonicalizeJsonValue`
normalizes object key order so the same state always encodes to the same bytes
(the content address depends on it), and it rebuilds onto a null-prototype
object with `Object.defineProperty`, so an own `__proto__` — a legal JSON key
that `JSON.parse` really does produce — survives instead of being swallowed by
the prototype setter. For the same reason the JSON schemas in `chat-sync/json.ts`
are predicate checks over `z.any()` rather than `z.record(...)`/`z.json()`:
those rebuild an object from its entries and drop the key before a reader ever
sees it. Values are otherwise preserved exactly.

Canonical form is the schema-**normalized** encoding, not a byte echo of the
input: a field carrying `.default(...)` materializes on the way through, so
`encode(decode(x))` can differ from `canonical(x)` for an input that omitted one
(`minReaderVersion` and the run settings are the live examples). What holds is
**idempotence** — `encode(decode(·))` is a fixed point after one pass — which is
what keeps every part's `sha256`, and the head digest the lineage chain is built
from, stable across read/write cycles. Passthrough subtrees and residual bags
are exempt from normalization entirely and re-emit verbatim.

### 3. Residual capture: unmodeled FIELDS survive too

The passthrough covers new _variants_. Residual capture (`chat-sync/residual.ts`)
covers new _fields_: every modeled object in both records — the head, the shard,
`core`, `lifecycle`, the run settings, the `hostPrivate` envelope — splits its
unmodeled own keys into one typed `residual` bag, and the encoders merge them
back.

The consequence is the one that matters: **a v1.0 reader re-publishing a v1.1
chat is mechanically lossless**, so an unchanged cohort keeps its content
address. Preservation is not a discipline a future author has to remember.

`residual` is a named field, not an index signature, so consumers keep precise
types and nobody confuses the bag with modeled state. The name is **reserved**
at every captured level: a future modeled field must not be called `residual`.

The captured levels are enumerated by `CAPTURED_RESIDUAL_LEVELS`
(`chat-sync/captured-levels.ts`), each with a stable id and a path.
`withResidualCapture` registers every level it builds, and
`chat-sync-captured-levels.test.ts` fails if the registry and the manifest
disagree — or if a level's declared keys change without the frozen table moving.
**Adding a captured level therefore requires a manifest entry**, and the guard,
not a reviewer, is what enforces it. An id may **never** be reused with changed
semantics: consumers key behaviour off it (a clone importer blanks
`hostPrivate` and carries the rest), so a restructure gets a NEW id.

Capture runs as a `z.preprocess` ahead of each object schema, on the untouched
input, because Zod's object parser rebuilds its output and would drop an own
`__proto__` before capture could see it — a `.catchall` would have been subtly
lossy. (A codec cannot be used here either: re-validating the domain side would
feed already-decoded messages back through the message codec's persisted schema.
A `.transform` is unrepresentable in output mode.)

**A capturing schema cannot describe its own wire form.** `z.toJSONSchema`
reports a preprocess's INNER schema in both IO modes, and that inner schema is
the post-capture _domain_ shape: it requires `residual`, a key no writer ever
emits, and — because a preprocess accepts `unknown` — marks every captured child
field optional. Freezing it as the storage surface would assert the opposite of
the truth in both directions. So the wire form is projected explicitly by
`storageProjection`, from the same shape maps with nested captured levels
substituted, and that is what the frozen `storage` surfaces are generated from.
The guard backs it with semantic assertions — a real wire record must satisfy the
projection, a truncated one must not, and `residual` must never appear — because
a frozen surface can be frozen and wrong.

### 4. Version gating: the major is the boundary

`gateChatHeadVersion` runs on the HEAD, which a reader already holds after one
row read, before any part is fetched. Its rule:

- **reject on a major mismatch**, in either direction;
- **admit every same-major publication, whatever its minor** — unless the head
  carries a `minReaderVersion` the reader is below.

Admitting newer same-major minors is the whole point of the passthrough. A
strict-minor gate would have made it dead code: the minor bump that introduces a
new content-block type is exactly the one an older renderer would bounce at the
row, never reaching the tolerant codec, so the chat would fail in the one case it
was designed to survive.

Gating on the head rather than per part is what makes "no egress on a refused
chat" structural — the fetch port is a callback the assembler invokes, so on a
refusal there is no call to forget to skip. It is worth more here than it was for
a single-object layout: a refused chat would otherwise have cost every shard's
egress.

`minReaderVersion` (nullable, defaulted) is the escape hatch, and `null` is the
normal case — including for every ordinary field and variant addition, which §2
and §3 make lossless without it. Preservation is never a reason to set it.

Set it only when an older reader cannot safely **interpret** the state: when
correct behavior depends on understanding the change, not merely on carrying it.
A field whose absence in an old reader's rendering is just a gap needs nothing; a
change that would make an old reader act on a chat _wrongly_ — a redefined
meaning for an existing field, a new field that invalidates one it does
understand — is what the minimum is for. Setting it is a deliberate act and the
ritual below asks for the justification in the change description.

A non-null minimum is schema-checked for coherence: it must share the head's
major and must not exceed the head's own version. A minimum on another major
would name a chat no build could ever open, and a minimum ahead of the payload
contradicts the rule that the incompatible change is itself what cuts the
record's minor.

**Two payload schemas per record, deliberately.** The registered schemas pin
`schemaVersion` to this contract's exact literal — that is the writer contract
and the self-identification a detached repair candidate is trusted on. Reading
with them would have made the gate's own policy unreachable: a genuine 1.1
payload clears the gate, downloads, and is then rejected at parse, so the
passthrough never fires in the field. So `chatHeadReaderSchema` /
`chatShardReaderSchema` widen ACCEPTANCE to "same major, any minor" and nothing
else. Consumers that download and materialize a chat parse with those; writers,
and anything proving a payload is exactly this contract's version, keep the
registered ones. The encoders still stamp the MAJOR from the constant — no
payload can claim a different contract line — but carry the minor they read.

A fetched shard is cross-checked against the head that named it (`chatId`,
`section` and `schemaVersion` must agree) after hash verification and before
assembly. Content addressing proves the bytes are the ones the head named; the
cross-check proves they MEAN what the head assumed.

### 5. Harness ids are open strings

Every closed harness-id enum reachable from the presentation core is reopened to
a plain non-empty string in `chat-sync/open-harness.ts`. **Readers must render an
unrecognized harness id as a generic label** — never assume a known provider, and
never treat it as a failure.

The enum is right in the epic tree, whose reader is the host that wrote the doc.
It is wrong here. The harness roster grows most releases, and a closed enum turns
"this chat runs on a harness you have not heard of" into a hard reject of the
whole shard: the message's `role` IS known, so the passthrough carrier hands the
message to the known schema, which then fails on the enum and takes the entire
part with it. Reopening the leaves means a new harness needs no record bump.

The reopened leaves are `core.settings.harnessId`, the agent sender on messages
and on `events[].actor`, `blocks[].text.providerNotice.harnessId`,
`blocks[].plan.harnessId` / `.source.harnessId`, and `blocks[].steer.sender`.
`chat-sync-open-harness.test.ts` sweeps both records' parsed surfaces and fails
if any other closed harness-id leaf appears.

**Session anchors are not in the core at all.** A per-message `chatSessionAnchor`
discriminates on `harnessId` with a per-variant literal, so it cannot be reopened
without forking every anchor variant — and a **non-null** anchor from a newly
added harness would reject the whole shard. Anchors are session-chain state,
which §1 puts in the opaque `hostPrivate` section. An anchor a writer leaves on
the message anyway is just an unmodeled key: it rides the message's preserved
`raw` and never reaches a schema that could reject it.

**Logged decision — remaining nested unions stay closed.**
`userMessagePayload.kind`, `toolInputDetail.kind` and the provider-notice
metadata union are deliberately NOT reopened and are not covered by the
passthrough either. Ordinary breaking-change rules apply.

Every widened copy is **derived from the base schema's live shape**, so each
field it does not deliberately replace keeps its upstream schema — its type, not
just its name. Two bases (`providerNoticeMetadataSchema`, `userMessageSchema`)
carry `superRefine` checks, which closes Zod's own derivation helpers for a
widening replacement: `.extend()` and `.omit()` refuse outright on a refined
schema, and `.safeExtend()` only accepts a narrowing replacement. Those two
spread `base.shape` into a fresh `z.object(...)` and re-apply the check; the
parity tests assert each unreplaced field is the same schema object as the
base's.

### 6. Parts, graduation and lineage

**The stored head is a DOCUMENT: tenant envelope + opaque payload.** What lands
on the chat row is not the record's own bytes. It is
`serializeChatHeadDocument(record)` — the record's canonical encoding wrapped
with one derived top-level `parts` array of `{sha256, byteLength}`. That array
is the entire obligation a tenant owes the sync layer, and the minimum a
*deletion* mechanism can be built on: when a head is swapped, the parts the old
head named and the new one does not are owed a deletion, and nothing but the
head knows which those are. The server reads `parts` and interprets nothing
else — cohorts, sections, ordering, versions and lineage are all in the bytes it
stores and none of them is ever looked at.

`parts` is a **reserved top-level key**: no modeled head field may be called it,
and `decodeChatHeadDocument` strips it before parsing so it can never land in a
residual bag, where a re-publication would re-emit a stale index. The envelope is
always derived, never authored, and decode re-derives and compares rather than
trusting — a mismatch is corrupt and fails closed, because an envelope short one
entry describes a swap that strands an object and one entry long describes a swap
that deletes a live one.

**One digest identity.** `sha256` of the document bytes is simultaneously the CAS
witness, the digest the row holds, and the next head's `parentHeadSha256`. Over
the document, never the payload: the document is what is stored, and a chain
anchored on anything else names bytes nobody has.

There is deliberately **no payload serializer** in the public surface. Two
functions returning canonical bytes of a head — one stored, one not — is a trap
that a doc comment does not close: the first version of this module had one,
warned against hashing it, and this package's own fixture chained on it anyway.
A publisher following that example would chain on a digest naming bytes the
server never stored, and report a fork on its own next sync. So there is exactly
one way to turn a head into bytes. Payload-level assertions compose
`canonicalJsonStringify(encodeChatHead(record))` explicitly.

A head may not name the same part twice, anywhere across its lists — the server
refuses one, because "displaced = previous minus current" stops being
well-defined exactly where that set drives deletion.

**A part is named by content and nothing else in the tenant envelope.** The
envelope carries `(sha256, byteLength)` per part — no key, no storage
generation, no per-part seq. The payload's message / event cohort entries
additionally carry `firstSeq` / `lastSeq` (last-write extrema) and the
exact membership key `recordCount` / `firstRecordId` / `lastRecordId` (1.1)
so a publisher can plan the next cut from the predecessor head. Those
fields are chat-domain data and must not leak into the envelope. `cdc`
(algorithm, mask, target, min, max) lives on the head payload for the
same reason.
The key layout is derived from the hash under a `(task, tenant kind)` prefix and
is a versioned spec readers never parse. That is what makes a publish a hash-diff
against the previous head, and what makes upload retries converge on the same
object with no session state.

**A shard IS a cohort.** The selected section's payload must be non-empty:
`messages` for a `"messages"` shard, `events` for an `"events"` shard, the
envelope for a `"host-private"` one. An empty chat is an **empty shard list on
the head**, never an empty shard. Without that rule an empty `"events"` shard
paired with a head whose `events` are `null` states an impossible graduation — a
section that outgrew the head yet holds nothing — and it assembles to
`status: "ok"` with an empty log, which no reader can tell from a chat that
never had events. It also mints content addresses and fetches for nothing.

**Publisher-derived levels carry no durable chat data.** The head's part entries,
`cdc` and `hostPrivateShard` are always RE-DERIVABLE from the owner's op log,
which is the source of truth: a chat is single-owner, so the owner can re-cut its
cohorts and re-plan its cut at will, and a full recut does exactly that. They are
not re-derived on every publish — the extend road re-emits unchanged cohort
entries verbatim and reads `cdc` back to confirm the plan has not moved — and
that is the point: **the only round-trip any of them makes is through the owner's
own predecessor head.** They are therefore the three head locations residual
capture deliberately does **not** cover (§3, and the manifest note in
`chat-sync/captured-levels.ts`), and the rule that follows binds every same-major
minor:

> A minor may add a publisher-derived field for the next publish to plan with. It
> must NOT put durable CHAT data there — anything the chat is not still true
> without. Durable additions go at a captured level, or inside a message / event
> body.

So the only loss scenario is a same-host downgrade: the newer part fields strip
on the older host's next publish, and the following newer publish does a full
recut instead of an incremental one. That is an accepted efficiency cost, never
data loss. Runtime capture for these levels was investigated and rejected:
it would cost a manifest id, a store op field and an encoder change per level,
and a part-level key perturbs the head bytes the lineage digest is taken over.

**Sections graduate.** Events and `hostPrivate` start inline in the head, because
they are small and a head is rewritten every publish anyway. Each moves to its
own content-addressed part when it alone outgrows the shard target (64 KiB —
one knob, shared with the message-cohort rule): events cohort-style, since they
are id-keyed like messages, and `hostPrivate` whole. The head represents that as
a `null` inline section paired with a non-empty part list, and
`refineChatHeadSections` enforces exclusivity in both directions — a section
stated twice would let two readers assemble two different chats from the same
bytes, and a section stated nowhere would present as a chat that lost its event
log. Nothing downstream of assembly can tell the two layouts apart.

**Heads carry `parentHeadSha256`.** Continuity and ancestry are proven by
IDENTITY, never by sequence ordering: two forked histories both number their
turns, so a seq comparison permits exactly the dangerous "local is ahead,
overwrite the cloud" case. `throughRecordSeq` is a watermark, not an ordering
authority. `null` means a chat's first head.

**Assembly is ordered by the head, not by the fetch.** Parts are immutable and
independently verifiable, so they are fetched concurrently — a p99 chat is ~165
parts. Completion order is a network accident; the head's list is the only thing
that says what the transcript is. A part whose bytes do not hash to the address
the head named **ends the read**: it is not skipped, not rendered as a gap, and
not retried there, because a chat assembled from a substituted part is not a
degraded chat, it is a different one.

**Retired, not merely unimplemented.** The v1 design reserved a `chunk-manifest`
publication layout — a manifest over per-block chunks — and shipped a
base-plus-segments `manifest` layout with a fold. Both are gone: v2 has exactly
one layout, so there is no tagged ref union, no `partMode` / `fromSeq` /
`expectedBaseSha256`, no chain validation, no `foldedSha256`, and no compaction.
Chunking was measured and rejected (O(blocks) rows per publish); the segment fold
was abandoned because its increment basis did not survive a restart and its
set-shaped delta could not express a reorder. Domain-level sharding is what makes
"dumb whole-file sync" applicable where byte-level chunking of a canonical JSON
document could not be.

### 7. The coupled bump ritual

A change to any schema reachable from either record is not done until every
coupled surface moves with it. Work the list top to bottom:

| Change | What else has to move |
| --- | --- |
| Add a field to `core` (or to any captured level) | record minor bump; regenerate the chat-sync fixture; confirm the input schema accepts absence (`.default(...)` / `.optional()`). Older readers preserve it mechanically (§3) — there is nothing to justify and no loss to document |
| Add a field older readers cannot safely INTERPRET | the row above, **plus** `minReaderVersion` on every head that carries it, with the justification recorded. Reserve this for changes that would make an old reader act on a chat wrongly — never merely for preservation |
| Add a field to `hostPrivate.data` | nothing in protocol — that is the point of the opaque section |
| Promote `hostPrivate` → `core` | this IS a core-field addition: take the first row (and the second only if interpretation is required for correctness). Plus: regenerate the fixture, and note the field is now permanent (one-way door). If the value stays authoritative for old readers, keep dual-writing the `hostPrivate` copy until they are out of support |
| Add a content-block type / message role / chat-event type | add it to `KNOWN_CONTENT_BLOCK_TYPES` / `KNOWN_CHAT_MESSAGE_ROLES` / the event enum, or every entry of that variant silently degrades to unknown; record minor bump; regenerate **both** the chat-sync and epic fixtures (the leaves are shared); confirm the passthrough round-trip test still re-emits the new variant losslessly |
| Change a shared epic leaf (`contentBlockSchema`, `chatEventSchema`, senders, run settings) | both fixtures; both contracts' compatibility arguments — the change really is a change to both. The chat-sync copies derive from the live shape, so a field addition flows through; only a change to one of the two RE-APPLIED refinements in `open-harness.ts` needs mirroring by hand |
| Add a harness id | nothing here — chat-sync harness ids are open strings. Add it to the epic enums as usual |
| Add a field carrying a harness id to `core` | reopen it in `open-harness.ts`, or the sweep test fails |
| Add a `chat-shard` `section` | breaking: the enum is closed and shipped readers fail on an unlisted section, by design. New major, plus the assembly branch and the head's own part list for it |
| Change a `refineChatShardSection` / `refineChatHeadSections` rule | **the frozen surfaces will not notice** — a Zod refinement has no JSON-Schema form, so the fixtures stay byte-identical (a narrowing here regenerates to no diff at all). Tightening one is an input narrowing: free before a release pins the record, breaking after, because a writer already emitting the looser shape becomes unreadable. Loosening one is breaking in the other direction — a reader that stops enforcing an invariant admits publications shipped readers refuse. Either way the guard is the record's own tests, not the fixture |
| Change how a section graduates, or the head's part ordering | **breaking**, not additive: shipped readers would assemble a different chat from the same bytes. New major, and a publisher that keeps writing the old shape until old readers are out of support |
| Cut a new record minor | add its literal + `chatSyncSchemaVersionSchema` in `chat-sync/version.ts`, and pass that constant to BOTH new `defineRecordContract` calls — the payload version is pinned per contract, and the registry binds the same literal rather than repeating it |
| Name a new modeled field `residual` | don't — the name is reserved at every captured level (§3) |
| Name a new modeled head field `parts` | don't — reserved for the tenant envelope (§6). The decoder strips that key, so a modeled field of that name would be silently unreadable |
| Add a field to the `parts` envelope entry | this is the TENANT SEAM, not a record field: it changes what the sync server is handed. Coordinate with the server's `readDeclaredHeadParts` and keep chat-domain data out of it — the envelope is read by a layer that must interpret nothing |
| Add a field to a publisher-derived level (a head part entry, `cdc`, `hostPrivateShard`) | nothing beyond the record minor — but the field must be a planning HINT, never durable chat data (§6). It is re-derived every publish and is not residual-captured, so an older publisher strips it and the next newer publish recuts. Durable data belongs at a captured level instead |
| Add a residual-capture LEVEL (a new `withResidualCapture` site) | add a `CAPTURED_RESIDUAL_LEVELS` entry in `chat-sync/captured-levels.ts` and its frozen key set in `chat-sync-captured-levels.test.ts`. The guard fails until you do |
| Restructure an existing captured level | a level identifier may **never** be reused with changed semantics — consumers key behaviour off it. Give the changed level a NEW id so those exceptions break loudly instead of misfiring, and update the frozen id → declared-keys table |
| Add a `chat.subscribe` field that also lands in a publication | the subscribe stream's own minor, on top of the record minor |
| Bump either record's version | the other moves with it. Both contracts register from `CHAT_SYNC_SCHEMA_VERSION`; `chat-sync-record-shape.test.ts` fails if only one does |

Both records are frozen by `chat-sync-schema-surface-compat.test.ts`, which —
like the epic guard — fails on **all** drift, including compatible additive
changes. Regenerate the baseline from the repository root only after classifying
the change:

```sh
bun run protocol/scripts/snapshot-chat-sync-schema-surface.ts > \
  protocol/src/persistence/chat-sync/__tests__/__fixtures__/chat-sync-schema-surface.ts
```

The guard freezes both IO surfaces of both records. Preserved variants
deliberately show their open envelope on the `storage` (`io: "input"`) side —
that openness is the contract; the interpreted message/block/event shapes are
frozen on the `domain` side.
