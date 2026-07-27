# `@traycer-clients/shared/host-lifecycle` — World probe + conditional actuators

Read-only **evidence-bearing world probe** for the host lifecycle layer.

## Boundary

- **In scope:** evidence algebra, per-platform registration probes, durable-record
  decoders, reachability / login-item / CLI-slot evidence, positive Traycer
  identity attestation for eviction targets.
- **Also in scope:** pure planner output and conditional actuator primitives.
  A primitive takes a captured world precondition, obtains the caller's
  serialization section, probes again at the last safe point, and only then
  invokes its injected mutation. A changed observation returns the first-class
  `stale-precondition` outcome with zero mutation.
- **Out of scope:** transition journal choreography, consumer wiring, kernel
  lock queries, and direct process spawning. Actuators retain injected mutation
  ports, so this package never imports the legacy service controllers.

The probe remains **read-only by construction**. Do not import install,
uninstall, bootout, schtasks `/Create`/`/Delete`, `systemctl enable/disable`,
or any other legacy mutator. Actuators receive the mutation as an injected
function, and ESLint keeps this directory independent of those controllers
(see `clients/shared/eslint.config.mjs`).

## Layout

| Path          | Role                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| `evidence.ts` | `Evidence<T, Cause>`, `DurableRecord<T>`                                               |
| `identity.ts` | Positive Traycer identity attestation / eviction gate                                  |
| `durable/`    | Versioned decoders (`valid \| absent \| corrupt \| unreadable \| unsupported-version`) |
| `shared/`     | Reachability, pid.json, CLI-slot, injectable command runner                            |
| `macos/`      | `launchctl print` split, multi-signal ownership, run-state/LWCR, wedge, login-item     |
| `linux/`      | unit file / load / enablement / activity / bus / linger — **no** `externally-managed`  |
| `transition/` | Journaled substrate transitions: probe marker, journal, governor                       |
| `activation/` | Journaled install activation: phases, journal                                          |
| `actuators/`  | Only `MutationResult`, the shape `activation/` builds on — the rest is parked          |

There is no `windows/` directory. It was written before any consumer existed
and is archived with the rest of the decision layer (see the header note in
`index.ts`); Windows host lifecycle is handled outside this substrate.

## Contracts

Types and classifications follow the Stage-1b annexes (epic artifacts), not the
legacy CLI `ServiceState` enum. Cause unions stay **per-platform**.
