# Provider authentication evidence

This document describes the host-produced authentication verdict for client and
harness integrators. The host implementation lives outside this repository;
the [wire schemas](src/host/provider-schemas.ts) and the client consumers are
public. A verdict describes evidence about one credential scope. It is not a
guarantee of inference quota, model entitlement or future credential validity.

For product guidance, see [Provider Auth troubleshooting](../mintlify/reference/troubleshooting.mdx#provider-auth)
and [coding-agent setup](../mintlify/agents-and-models/coding-agents.mdx).

## Status and consumer effects

The v2.0 auth schema has five statuses:

| Status            | Evidence                                                                                                                       | Does this status alone block Send?      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `authenticated`   | The provider's probe established usable account or credential evidence according to that arm's contract.                       | No.                                     |
| `configured`      | A credential is configured, without the stronger validation that arm requires for `authenticated`.                             | No.                                     |
| `unauthenticated` | A covered credential source gave a definitive negative, or the harness observed a runtime authentication failure.              | Yes, for the selected credential scope. |
| `unknown`         | The available evidence cannot establish a definitive verdict, including a credential for an upstream the probe does not model. | No.                                     |
| `unavailable`     | An attempted probe or read could not answer, for example because of a timeout, unreadable store or unsupported response.       | No.                                     |

`unknown` does not mean that no credential exists. `configured`, `unknown` and
`unavailable` also do not override a definitive negative from another source
for the same selected scope; see [Runtime evidence](#runtime-evidence).

The host returns `badgeText`, `label` and `detail` for display alongside the
status. Those strings must not contain secrets. Clients use the status for
decisions rather than inferring authentication from a display label.

### Ambient and managed profiles

For the terminal/ambient account, either a provider-level `auth.status` or its
ambient profile row reporting `unauthenticated` blocks Send. The two fields
can briefly disagree. Both feed
[`isProviderAmbientSignedOut`](../clients/shared/providers/provider-ambient-auth.ts),
which the picker and composer share.

A selected managed profile is judged by its own row. Once profile resolution
settles, its `unauthenticated` status gives `profile_unauthenticated`; an
absent selected profile gives `profile_missing` only when the selection is
authoritative. A healthy selected managed profile is not blocked by the
ambient account being signed out. See
[`deriveReauthReason`](../clients/gui-app/src/components/chat/composer/use-provider-reauth-gate.ts).

### Wire versions

`PROVIDER_AUTH_STATUS_SCHEMA_V10` has three statuses: `authenticated`,
`unauthenticated` and `unknown`. `PROVIDER_AUTH_STATUS_SCHEMA_V20` adds
`configured` and `unavailable`.

`downgradeProviderAuthV20ToV10` maps `configured` and `unavailable` to
`unknown`; the other three values keep their status. These are auth-schema
versions. RPC methods negotiate their own versions independently, as described
in the [protocol README](README.md#three-version-systems--keep-them-separate).

## Passive credential evidence

A passive probe inspects the credentials the provider would actually use,
including the selected upstream, home/profile and environment precedence.
It does not launch the provider's CLI or mutate its credential store. Full
probes can additionally validate credentials over HTTP; that is a distinct
source of evidence.

- A clean absence or empty store across all covered arms can establish
  `unauthenticated`. Not finding a credential in an incomplete set of arms
  does not establish that no usable credential exists.
- A read or parse failure is not a definitive negative. A later positive
  can still win; an all-negative fold with an unreadable arm is
  `unavailable`. Keep provider-specific parsing and coverage boundaries
  explicit.
- A found but unmodelled credential can produce `unknown`. Presence must
  not be represented as validation.
- Where a store carries expiry, account for refresh capability: an expired
  access token with a usable refresh path is different from an expired token
  with no refresh path.
- Credential values must not be returned, retained or logged merely to
  report presence. Do not ask a reporter to paste `.env`, `auth.json`, tokens
  or other credential contents. For Hermes provider selection, ask at most
  for the non-secret `model.provider` value.

### Enablement and explicit login are separate decisions

A passive result does not authorize first-launch enablement. Neither
`configured` nor a passive `authenticated` is sufficient: the host uses
separate authoritative validators, and a saved enable/disable choice wins.

Explicit login completion also has its own provider-specific policy. A
provider can accept `configured` after a confirmed login command only when
that policy verifies the same attempt and credential scope. A successful
command exit is not a generic replacement for credential evidence. Ordinary
passive status keeps its original evidence ceiling.

## Runtime evidence

A harness can observe an authentication failure during catalog discovery or a
turn. The host records that observation as a definitive `unauthenticated`
override, called **auth poison**, independently of passive probe results.

For Hermes, the session-open path recognizes ACP error `-32603` containing
`No LLM provider configured` and wraps it as a signed-out error. Catalog
discovery catches that error and calls `markProviderUnauthenticated`. The
turn engine also calls the adapter's `onAuthFailure` when it classifies an
authentication failure. A generic discovery error or an ordinary assistant
message is not automatically this signal.

The marker is scoped by provider and profile. Hermes passes the ambient
scope, so it does not poison other providers or another provider's managed
profile. Harnesses with managed profiles can mark their selected profile.
An observation about a credential that has already been replaced is
discarded; another accepted failure refreshes the poison timestamp.

### Lifetime and recovery

The poison's priority lasts **30 seconds since the latest accepted failure**
(`AUTH_CACHE_TTL_MS`). Normal auth reads, including the non-blocking
`providers.list` path, honor it during that interval. The list projects the
current ambient result onto an enabled ambient profile row; it does not
persist an indefinite poison there. The cache-only harness-catalog reader
also ignores expired poison and expired cache entries.

During those 30 seconds, a non-definitive probe (`configured`, `unknown` or
`unavailable`) cannot overwrite the poison in the auth cache. It can clear
earlier through:

- Explicit scoped or all-scope cache eviction around login, key or
  environment changes.
- A current, authoritative `authenticated` probe. A presentation-only
  passive cache seed cannot clear it.

Force refresh bypasses the poison's read fast path to run a probe. A
non-definitive result does not retract the still-live poison. A completed
turn is not a clearing signal.

Expiry ends this runtime override's priority; it does not promise that an
already-rendered banner disappears at exactly 30 seconds. A client must
observe the next result, and a separate last-known or newly probed negative
can still block Send until refreshed.

ACP `initialize` success, an empty `authMethods` list and a historical
completed turn are not a provider-wide auth-status interface. They do not
establish that every selected upstream or model can authenticate. Traycer
does not consume a generic ACP auth-status extension or a generic CLI
auth-status command. Before integrating such a command, establish its output,
failure modes and whether it mutates credentials.

## Hermes evidence arms

**As of host-v1.5.1**, the native-store probe covers these arms:

- Hermes home and active-profile selection.
- `config.yaml model.provider`, which selects the upstream whose credential
  is checked. An explicitly selected provider takes precedence over fallback
  credentials for other providers.
- OAuth state in `auth.json` provider singletons and credential-pool entries.
  The pool and Anthropic OAuth coverage shipped in host 1.3.0.
- The Qwen CLI's OAuth store for `qwen-oauth`.
- Provider API keys resolved from Hermes's `.env` before the provider spawn
  environment. With no configured provider, the probe considers
  `auth.json active_provider`, environment-detected providers and the pool.

An explicitly named cloud/custom provider whose credential shape is not
modelled can read `unknown`. That is an incomplete-coverage verdict, not an
instruction to create a Hermes account.

### Bedrock coverage after host-v1.5.1

The Bedrock presence arm was merged at host commit `d6eb9741` and is
**unreleased as of 2026-10-24**. It adds AWS credential environment groups
(including a Bedrock bearer token) and shared-file evidence when no earlier
modelled positive wins. Found unmodelled credentials produce `unknown`;
unreadable or unplaceable evidence produces `unavailable`. File presence
does not validate the credential.

An instance-metadata-only credential chain requires a network request and
remains outside this passive arm. With no named provider and clean negatives
from every checked source, that shape can still read `unauthenticated`.
Do not claim that passive file/environment inspection covers the entire AWS
credential chain.

### Recovery surfaces

Hermes setup from a chat shipped in host and desktop 1.4.0. **Set up in
terminal** opens `hermes setup model` on the composer's host. The
[`setup guidance`](../clients/gui-app/src/lib/providers/provider-setup-guidance.ts)
asks the user to select the inference provider, finish its credential step
in that terminal and refresh the list. Opening setup alone does not prove
authentication succeeded.

The composer's
[`Check sign-in status`](../clients/gui-app/src/components/chat/composer/provider-reauth-banner.tsx)
control performs a fresh check on the tab's host after setup or a credential
change made outside Traycer. The
[coding-agents guide](../mintlify/agents-and-models/coding-agents.mdx) names
the same Hermes setup action; the
[Provider Auth table](../mintlify/reference/troubleshooting.mdx#provider-auth)
explains the user-visible statuses.

The reported false-negative and recovery paths are discussed in
[#1628](https://github.com/traycerai/traycer/issues/1628).
