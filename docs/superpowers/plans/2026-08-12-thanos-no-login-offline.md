# Thanos No-Login / Offline Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document and sequence what “remove login” actually means for this fork, and implement only the slices that keep daily dogfood working against production Traycer cloud.

**Architecture:** Cloud login is not chrome. A Traycer OAuth device-flow session (`~/.traycer/cli/credentials`) is the identity that (1) opens the host WebSocket, (2) pins host ownership, and (3) is the only path from this OSS client into Traycer CloudData (history, epics, chats). There is **no local epic/history backend in this repo**. The host binary is a signed download from Traycer Releases; CloudData lives in Traycer’s closed-source host. True offline is a second product, not a GUI flag.

**Tech Stack:** OAuth 2.0 Device Authorization Grant against `https://authn.traycer.ai`; host WS JWT; CloudData via host RPC (`epic.*`).

## Global Constraints

- Do not fake a JWT. Production host checks JWKS. A stub `setSignedIn` without a real bearer leaves history empty and WS closed.
- Do not start Phase D from `clients/*` + `protocol/` alone.
- Phase A (hide chrome) is a separate plan: `2026-08-12-thanos-hide-account-chrome.md`.
- Dogfood must keep working after every phase.

---

## What login actually does

| Step | Where |
|---|---|
| Device authorize + poll | `clients/desktop/src/electron-main/auth/device-flow-controller.ts` |
| Tokens + cached user | `~/.traycer/cli/credentials` via `protocol/src/config/credentials.ts` |
| Renderer session | `clients/gui-app/src/lib/auth/auth-service.ts` |
| Host WS open | `clients/shared/host-transport/ws-rpc-client.ts` `extractBearerForOpenFrame` — **refuses without bearer** |
| Host CloudData mint | `POST /api/v3/hosts/token` via `HostCredentialProvisionProvider` |
| History / epics | `epic.listTasks`, `epic.create` — host proxies to CloudData |

**Without login the app stops at `AuthLandingPage`.** Skipping the UI gate without a bearer still cannot open epics.

**Local host can do once a valid user JWT opened the WS:** BYOA agents, terminals, git, worktrees, files, fork orchestrations on disk, multi-profile persist.

**Must go through Traycer cloud:** epic create/list/open, durable chats, sharing, cloud notifications, credits, host registry, token refresh.

---

## Phases

### Phase A — Hide account chrome — **S** — separate plan

See `2026-08-12-thanos-hide-account-chrome.md`. Login screen stays.

### Phase B — Persist session / skip re-login flash — **S–M** — next real slice

**Already mostly built.** File persist + refresh exist. Remaining UX: `AuthService.start()` on `network-error` leaves the UI signed-out (`auth-service.ts` ~612–623) until recovery succeeds. Laptop-offline looks like “please log in again.”

**Intended change:** if `tokenStore.get()` returns a pair and `/api/v3/user` is a `network-error`, project signed-in from the **cached** `stored.user` **without** calling `applySignedIn` with a fake `AuthenticatedUser` (that type is the full `/api/v3/user` payload). Safer approach:

1. Add a narrow `applyCachedSession(stored: StoredCredentials)` that sets Zustand `status: "signed-in"` + profile from `stored.user` and installs the stored bearer on `RequestContext`, then still `scheduleSessionRecovery`.
2. Only do this when `stored.user.id` is non-empty.
3. If recovery later `rejected`, sign out for real.
4. Do **not** skip validation forever.

**Files:**
- `clients/gui-app/src/lib/auth/auth-service.ts` (`start()` network-error arm)
- Tests under `clients/gui-app/src/lib/auth/__tests__/` (create if missing for this path)

**Still needs cloud:** authn for refresh; CloudData for epics. Device-flow only when the file is missing or refresh is rejected.

**Risk:** Medium if you send a stale JWT to the host. Low if you only change the **offline-startup projection** and keep recovery.

**Do not implement a GUI-only stub identity (Phase C).**

### Phase C — Local stub auth that still talks to production cloud — **do not do**

A fake `userId` cannot open the host WS or CloudData. The only stub that still talks to prod is injecting a **real** production token without the device-flow UI — that is Phase B with a hidden button, or `traycer login --token -`.

### Phase D — True offline (no Traycer account) — **XL, missing backend**

There is no local epic/history store. Renderer Y.Docs are a live projection of host streams.

True offline requires one of:

1. A **new local backend** implementing `epic.*`, cloud-chat read/write, and a host that accepts a non-JWT (or local JWT) on WS open — plus dropping owner-gate / host-credential mint. Host source is **not in this workspace**.
2. **Fork/replace the host** in Traycer’s internal repo.

Also rewrite: `AuthService`, `requireSignedIn`, `extractBearerForOpenFrame`, CLI `resolveHostAuth`, host owner-gate, `HostCredentialProvisionProvider`. Invent a local user id for profile/orchestration keys.

**Not feasible from this OSS tree.** Treat as a future product decision, not a task in this session.

---

### Task 1: Phase B — optimistic session on authn outage

**Files:**
- Modify: `clients/gui-app/src/lib/auth/auth-service.ts`
- Test: existing auth-service tests if present; otherwise add `clients/gui-app/src/lib/auth/__tests__/auth-service-startup-network.test.ts`

**Interfaces:**
- Consumes: `StoredCredentials.user` `{ id, email, name }`
- Produces: UI signed-in + recovery loop still running

- [ ] **Step 1: Write a failing test** that stubs `tokenStore.get()` with a valid pair, stubs `validateToken` → `{ kind: "network-error" }`, asserts Zustand status is `"signed-in"` and recovery was scheduled.

- [ ] **Step 2: Implement the `start()` network-error arm** to project the cached profile + bearer, then `scheduleSessionRecovery("startup:validate-network")`.

- [ ] **Step 3: Run auth tests**

Run: `cd clients/gui-app && bunx vitest run src/lib/auth`

Expected: PASS. Rejected tokens still sign out.

**Stop here until a host-local persistence decision exists.**

---

### Task 2: Phase D research spike (not implementation)

Only if product explicitly wants no Traycer account:

1. Decide local SQLite vs wrapping the released host.
2. List every `epic.*` RPC the GUI calls on cold open of a draft.
3. Estimate a replacement host or a “local CloudData” sidecar.

Do not write production code for this spike in the GUI.

---

## Recommended sequence

1. Phase A (chrome) — this session.
2. Phase B (session persist UX) — after chrome, with tests.
3. Stop. Dogfood stays on production CloudData + BYOA.
4. Phase D only after an explicit backend decision.

## Essential files (reference)

- `clients/gui-app/src/lib/auth/auth-service.ts`
- `clients/gui-app/src/stores/auth/auth-store.ts`
- `clients/gui-app/src/lib/router-auth.ts`
- `clients/gui-app/src/routes/root-route-components.tsx`
- `clients/gui-app/src/providers/host-credential-provision-provider.tsx`
- `clients/shared/host-transport/ws-rpc-client.ts`
- `clients/desktop/src/electron-main/auth/file-token-store.ts`
- `protocol/src/config/paths.ts`
- `protocol/src/host/epic/cloud-chat.ts`
