# Thanos Local Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a loopback Traycer-compatible host in this fork that the existing GUI can handshake with, without Traycer JWKS or CloudData.

**Architecture:** New workspace package `clients/thanos-host` (`@thanos/host`). It speaks the **local** `/rpc` and `/stream` JSON-frame protocol (`protocol/src/framework/ws-protocol.ts`), not the remote Noise mux. Advertise the full `RELEASED_FLOOR_METHOD_NAMES` set via `splitConnectionManifest(hostRpcRegistry, RELEASED_FLOOR_METHOD_NAMES)`. Accept any non-empty bearer (no JWKS). Implement `host.status` and `epic.listTasks` for real; other floor methods return a valid empty/success payload or a structured RPC error that the GUI already degrades. Persist nothing in Task 1–2; in-memory catalog in Task 3.

**Tech Stack:** Bun, `Bun.serve` WebSocket, `@traycer/protocol` (workspace), Vitest, Zod.

## Global Constraints

- Do not fake a production JWT or call `authn.traycer.ai`.
- Do not wrap or spawn the signed `traycer-host` binary.
- Handshake floor is equal-set: `openAck.manifest` MUST contain every name in `RELEASED_FLOOR_METHOD_NAMES` at the registry canonical version. Missing a floor name fatals `INCOMPATIBLE`.
- Parse inbound frames with `clientFrameSchema` / stream control schemas from protocol. Emit `hostFrameSchema`-valid JSON text frames.
- Empty bearer → `fatalError` `{ code: "UNAUTHORIZED", reason: "missing bearer" }` then close.
- Non-empty bearer → accept; identity is `{ userId: "thanos-local", token }` (do not invent a full `AuthenticatedUser`).
- Bind `127.0.0.1` only. Never `0.0.0.0`.
- Package lives under `clients/thanos-host` so the existing `"clients/*"` workspace glob picks it up. Do not add a new root workspace glob.
- Do not modify `clients/gui-app` auth, desktop LaunchAgent, or `install-local-desktop.sh` in Tasks 1–4. Desktop wiring is Task 5.
- Type safety: no `as any`, no optional params with `?` in function signatures (use `| undefined`).
- Commits: DCO (`git commit -s`). Stage only thanos-host files until Task 5.
- Tests: TDD. Run `cd clients/thanos-host && bunx vitest run`.

## File map

| File | Responsibility |
|---|---|
| `clients/thanos-host/package.json` | `@thanos/host`, scripts compile/test/lint/format, bin `thanos-host` |
| `clients/thanos-host/tsconfig.json` | Mirror CLI: protocol + shared path aliases |
| `clients/thanos-host/vitest.config.ts` | Same aliases as `clients/traycer-cli/vitest.config.ts` |
| `clients/thanos-host/eslint.config.mjs` | Copy CLI eslint, node globals |
| `clients/thanos-host/src/identity.ts` | Accept non-empty bearer |
| `clients/thanos-host/src/manifest.ts` | Floor + optional split from `hostRpcRegistry` |
| `clients/thanos-host/src/rpc-server.ts` | `/rpc` WS: open / openAck / request / response |
| `clients/thanos-host/src/handlers.ts` | Per-method results (`host.status`, `epic.listTasks`, stubs) |
| `clients/thanos-host/src/catalog.ts` | In-memory epic list (Task 3) |
| `clients/thanos-host/src/stream-server.ts` | `/stream` WS handshake (Task 4) |
| `clients/thanos-host/src/main.ts` | `Bun.serve`, print `ws://127.0.0.1:<port>/rpc` |
| `clients/thanos-host/src/__tests__/*.test.ts` | Handshake + status + listTasks |

---

### Task 1: Package + `/rpc` handshake + `host.status`

**Files:**
- Create: all package config files listed above except `catalog.ts` and `stream-server.ts`
- Create: `src/identity.ts`, `src/manifest.ts`, `src/rpc-server.ts`, `src/handlers.ts`, `src/main.ts`
- Test: `src/__tests__/rpc-handshake.test.ts`

**Interfaces:**
- Consumes: `hostRpcRegistry` from `@traycer/protocol/host/registry`, `RELEASED_FLOOR_METHOD_NAMES`, `splitConnectionManifest`, `clientFrameSchema`, `checkCompatibility` (host may skip client-mirror; the **client** runs checkCompatibility on our openAck)
- Produces: listening `{ url: string, port: number, stop: () => void }`

- [ ] **Step 1: Scaffold** `clients/thanos-host` with package.json name `@thanos/host`, `"type": "module"`, scripts matching CLI (`compile` = `tsc --noEmit`, `test` = vitest). Dependencies: `zod` catalog, `@traycer/protocol` workspace. DevDeps: typescript, vitest, eslint, prettier, `@types/node` from catalog. Copy tsconfig/vitest/eslint patterns from `clients/traycer-cli`.

- [ ] **Step 2: Write a failing test** that:
  1. Starts the rpc server on `127.0.0.1` ephemeral port.
  2. Builds a `WsRpcClient` from `@traycer-clients/shared/host-transport/ws-rpc-client` with `registry: hostRpcRegistry`, a bearer source returning `"thanos-test-token"`, and the real WebSocket (or the shared factory used in production).
  3. Calls `requestWithResponseTimeout("host.status", {})`.
  4. Asserts `ready === true`, `hostVersion` is a non-empty string, `busy === false`.
  5. A second case: empty token → throws `HostRpcError` with code `UNAUTHORIZED` (or transport failure wrapping fatal UNAUTHORIZED).

  Look at `clients/shared/host-transport/__tests__/ws-rpc-client.test.ts` for `WsRpcClient` constructor (`endpoint`, `bearerSource`, `registry`, `webSocketFactory`). Use the default/global WebSocket if the test runs in Node/Bun — Bun has `WebSocket`. Prefer dialing `ws://127.0.0.1:${port}/rpc` with the production client, not a fake host.

- [ ] **Step 3: Implement** `startRpcServer({ hostname: "127.0.0.1", port: 0 })`:
  - `Bun.serve` with `websocket` handlers. Route only pathname `/rpc`.
  - First text frame: `clientFrameSchema.parse(JSON.parse(text))`.
  - `kind === "open"`: `acceptBearer(token)` — empty/whitespace → send `fatalError` then close. Else send `openAck` `{ kind: "openAck", manifest, optionalManifest }` from `splitConnectionManifest(hostRpcRegistry, RELEASED_FLOOR_METHOD_NAMES)`.
  - `kind === "request"`: dispatch. `host.status` returns `{ ready: true, hostVersion: "0.0.0-thanos", protocolVersion: { major: 1, minor: 1 }, busy: false, busySessionCount: 0, updateProgress: null }` at the requested schemaVersion (if client asks 1.0, omit busy fields).
  - Unknown / unimplemented floor method: `response.error = { code: "E_HOST_UNSUPPORTED", message: method }` with `result: null` — only after handshake works. Prefer implementing `host.status` for real in this task.
  - One RPC per connection (client closes after response). Still handle the sequence open → request → response.

- [ ] **Step 4: Run tests**

Run: `cd clients/thanos-host && bunx vitest run`

Expected: PASS. Handshake no longer `INCOMPATIBLE`. `host.status` succeeds with a non-empty token.

**Commit:** DCO. Message: `feat(thanos-host): accept local /rpc handshake and host.status`

---

### Task 2: Floor-safe stubs + `epic.listTasks` empty catalog

**Files:**
- Modify: `clients/thanos-host/src/handlers.ts`
- Test: `src/__tests__/epic-list-tasks.test.ts`

- [ ] **Step 1: Failing test** — after handshake, `epic.listTasks` with a minimal valid request returns `{ tasks: [], hasMore: false }`.

- [ ] **Step 2: Implement** `epic.listTasks` against `listTasksResponseSchema`. Other still-unimplemented floor methods may keep `E_HOST_UNSUPPORTED`.

- [ ] **Step 3: Run** `bunx vitest run` in the package.

**Commit:** `feat(thanos-host): return an empty epic.listTasks catalog`

---

### Task 3: In-memory `epic.create` + list round-trip

**Files:**
- Create: `src/catalog.ts`
- Modify: `handlers.ts`
- Test: `src/__tests__/epic-create.test.ts`

- [ ] **Step 1: Failing test** — `epic.create` with a valid create request returns an epic id; subsequent `epic.listTasks` includes that id.

- [ ] **Step 2: Implement** in-memory map. Parse request with the registry contract for the on-wire version. Persist `{ id, title }` enough to list. Do not talk to CloudData.

- [ ] **Step 3: Tests pass.**

**Commit:** `feat(thanos-host): persist epics in an in-memory catalog`

---

### Task 4: `/stream` open/openAck (no Yjs yet)

**Files:**
- Create: `src/stream-server.ts`
- Modify: `src/main.ts` to serve `/stream` on the same listener
- Test: `src/__tests__/stream-handshake.test.ts`

Stream handshake is **not** equal-set fatal. Client sends `open { token, manifest }`; host replies `openAck { manifest }` using `hostStreamRpcRegistry` (export from `@traycer/protocol/host/registry`). Empty token → UNAUTHORIZED. Do not implement `epic.subscribe` Yjs in this task — after openAck, if subscribe arrives, send a fatal or a minimal snapshot only if tests require it. Goal: stream socket is not immediately rejected.

**Commit:** `feat(thanos-host): accept /stream openAck`

---

### Task 5: `thanos-host start` prints pid.json-shaped metadata

**Files:**
- Modify: `src/main.ts`
- Test: `src/__tests__/start-cli.test.ts`

CLI: `bun run src/main.ts --host-data-dir <dir>` listens, writes `<dir>/pid.json` with `{ pid, hostId, version, websocketUrl, startedAt }` matching the fields desktop already reads (`clients/desktop/src/electron-main/host/host-readiness.ts`). `hostId` = `thanos-local`. `websocketUrl` = `ws://127.0.0.1:<port>/rpc`. Do not register LaunchAgents. Do not change desktop yet.

**Commit:** `feat(thanos-host): write pid.json for desktop discovery`

---

## Out of scope (later plans)

- Desktop LaunchAgent swap
- GUI skip Sign in / local identity in AuthService
- `epic.subscribe` Yjs rooms
- git / terminal / agents
- SQLite durability
- Replacing production CloudData

## Essential files (reference)

- `protocol/src/framework/ws-protocol.ts`
- `protocol/src/framework/stream-ws-protocol.ts`
- `protocol/src/framework/capability-manifest.ts` (`splitConnectionManifest`)
- `protocol/src/host/released-floor.ts`
- `protocol/src/host/registry.ts` (`hostRpcRegistry`, stream registry)
- `protocol/src/host/status/contracts.ts`
- `protocol/src/host/epic/unary-schemas.ts` (`listTasksResponseSchema`)
- `clients/shared/host-transport/ws-rpc-client.ts`
- `clients/traycer-cli/package.json` (scaffold template)
