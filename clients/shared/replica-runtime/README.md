# replica-runtime — the interface seam

The client's bounded local replica/projection runtime is the sole read model
the UI consumes, with class-specific sync adapters feeding it. Wire lanes are
adapters _behind_ the runtime, never the application state model.

This directory is the **seam**, not the runtime. It contains the types the
replica, its adapters, its leases, its session registry, its memory accountant
and its command overlay are written against, plus the handful of pure helpers
whose semantics would otherwise be re-invented once per plane. It moves no
existing code and changes no behaviour.

The seam exists because the code it is destined to absorb has none. Roughly
60–65% of the open-epic layer is already runtime-shaped — misplaced, not wrong
— but it lives as `let`s in one 3,600-line function body with the ordering
invariants recorded in comments. Designing the boundaries here, before anything
moves, is what makes the extraction mechanical.

## The seams

| Module                   | What it is                                                             | What it is destined to absorb                                                                                        |
| ------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `runtime-environment.ts` | Injected clock, scheduler, logger, monotonic sequence                  | Every `window.setTimeout` / `Date.now()` / `appLogger` call inside sync machinery                                     |
| `lane-cursor.ts`         | The one cursor model, `(authorityEpoch, lane, position)`               | The epic stream's resume offer and the chat plane's `(transcriptEpoch, ordinal)` — the same coordinate, named twice   |
| `projection-sink.ts`     | Where a replica publishes; transactions replace `suspend`/`resume`     | `EpicProjector.attach(doc, store)`'s direct `StoreApi.setState`                                                       |
| `replica.ts`             | Owns one plane's state; applies events; is replaced, never patched     | The record tables, replica-swap machinery, and dirty-watermark math in the open-epic closure                          |
| `replica-events.ts`      | The decode target: records, logs, docs, ephemera, control              | The `openStreamClient` callback block — the one part of the extraction that is a genuine redesign                     |
| `generation-guard.ts`    | One generation guard                                                   | Two hand-rolled 30-handler `makeCallbacks` blocks (chat store and its terminal twin)                                  |
| `adapter.ts`             | Decodes one wire lane; owns stream lifecycle and resume cursor         | `EpicStreamClient` consumption (as the legacy `@1` adapter) and every lane subscription that replaces it              |
| `lease.ts`               | Refcounted demand, async materialise, deterministic teardown           | The artifact-room hot/cold tier, its cooldown, and `acquireArtifactBodyLease`                                         |
| `session-registry.ts`    | One warm pool, policy-parameterised                                    | `stores/chats/session-registry.ts`, `stores/terminals/terminal-session-registry.ts`, the open-epic registry's core     |
| `memory-accountant.ts`   | Process-wide budgets, soft, with protected regions                     | The uncoordinated per-plane constants — per-chat window bytes, hot-room cap, live-epic cap                            |
| `command-overlay.ts`     | Client-generated ids, queue, `pending → committed \| rejected \| superseded` | The doc-write mutation path and `pending-metadata-overlay.ts`                                                   |
| `replica-runtime.ts`     | The composition root that orders the pieces                            | The closure itself                                                                                                     |

`lease.ts` and `session-registry.ts` are deliberately two things, not one
refcount with two configurations. A lease materialises a resource from a cheap
representation and demotes it back to one — the whole reason it is async, and
the reason it has a cooldown. A session is _constructed_, has no cheap form to
demote to, carries a scope key that discriminates rebuilds, and can be
atomically replaced under a live demand count. Merging them yields a union
where half the surface is inert for either caller.

## Rules that are not negotiable

**React-free, DOM-free, worker-portable.** The runtime is scheduled to move
into a dedicated Web Worker per renderer window, on desktop, web and mobile
alike. A module here may not import React, touch `window` or `document`, or
call a global timer. Everything ambient arrives through `RuntimeEnvironment`.
A `window.setTimeout` compiles today and throws the moment a worker entry
imports it — as a blank pane, not a build error.

**Yjs stays in the doc class, and only as bytes at this seam.** Doc payloads
are `Uint8Array`. Live CRDT objects never cross these interfaces, because they
cannot cross a thread boundary — bytes transfer, a `Y.Doc` does not. The
open-artifact constraint is the reason the lease exists: Tiptap/y-prosemirror
binds `Y.Doc` / `XmlFragment` / `Awareness` by reference, synchronously, so a
doc with a live editor stays on the main thread and the lease is that boundary.

**Budgets are soft and reclaiming nothing is a legal answer.** A hard ceiling
reproduces the hydrate/evict/refetch livelock: the authority always serves the
first requested row whatever it costs, so a single visible row can legally
exceed the whole budget. Evicting it leaves its gap on screen, the planner
re-requests it, and the client fetches one row forever while it never renders
once. `"over-protected"` is the honest terminal pressure state and must not be
retried.

**Per-class freshness, never one boolean.** Network affects freshness, never
usability. There is deliberately no function here that folds a
`FreshnessReport` into a single verdict — an aggregate `synced` hides per-class
staleness and, worse, hides rejected writes.

**Commits are host-committed, not epic-global.** Shared epics have several
participants whose hosts write the same epic, and the inter-host plane is CRDT
last-writer-wins until record replication exists. `"superseded"` is a
first-class terminal command state for exactly that, and the committed
resolution names the host that committed it so UX copy cannot imply otherwise.

**An epoch change is a replacement, not an advance.** `compareLaneCursors`
answers `"incomparable"` across epochs rather than ordering them, so a caller
cannot resume across an epoch bump by arithmetic. A manifest change on
reconnect — a host that upgraded under an open tab — is the same replacement,
and every long-lived tab hits it exactly once.

## What this directory deliberately does not do

- No implementations beyond the pure helpers above. The registry, the
  accountant, the lease registry, and the command queue are named here and
  built elsewhere.
- No protocol types. Adapters instantiate the generic envelopes with whatever
  their contract serves; the runtime knows about cursors, revisions,
  tombstones, barriers and trust, and nothing about rows.
- No compile-time serializability constraint on projections. Structured-clone
  safety is a real requirement for the worker move, but a recursive
  index-signature constraint is not assignable from a TypeScript `interface`,
  which every existing projection slice is. Assert it at runtime in the
  worker-boundary tests instead.
