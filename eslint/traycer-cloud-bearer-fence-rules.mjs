/**
 * The cloud-bearer fence.
 *
 * `CloudBearerSource` constrains what a consumer DECLARES AS ITS DEPENDENCY.
 * It cannot constrain what a body REACHES: `RequestContext.credentials` is
 * public, so any module holding a context can help itself to
 * `getBearerToken()` and issue a cloud call with a credential nothing has
 * confirmed — past the type, past the composition root, past every review that
 * read the dependency list. TypeScript is structural and has no way to express
 * "only these files may extract a raw bearer". This rule is that expression.
 *
 * So the division of labour is:
 *
 *   - `CloudBearerSource` (the `kind: "cloud"` discriminant) makes an
 *     accidental mis-wire a `tsc` error. It is a speed bump, not a boundary.
 *   - THIS RULE is the boundary. It is what makes the seam load-bearing.
 *
 * Precedent and shape are `selectByIdRestrictions` in
 * `traycer-host-selection-layer-rules.mjs`: one capability, restricted to the
 * named files that own it, with everything else a lint error rather than a
 * convention.
 *
 * ── WHAT THIS RULE ACTUALLY GUARANTEES, AND WHAT IT CANNOT ──
 *
 * Stated plainly because a fence whose advertised scope exceeds its real scope
 * is worse than a narrower one described accurately: it earns trust it has not
 * got, and the next reader stops looking.
 *
 * IT CATCHES, syntactically and reliably:
 *   - `ctx.credentials.getBearerToken()` — the direct two-hop reach;
 *   - `ctx["credentials"].getBearerToken()` and every dot/computed mix of those
 *     two hops (a computed key parses as `property.value`, not `property.name`,
 *     which is how the first version of this rule was escaped);
 *   - `const lease = ctx.credentials` — the single-hop alias, fenced at the
 *     BINDING, because that is the last point where the lease is still
 *     syntactically identifiable.
 *
 * IT CANNOT CATCH arbitrary aliasing, and no `no-restricted-syntax` rule can.
 * Pass the context through a function, destructure it two frames away, stash it
 * on an object, round-trip it through a generic helper — the reach stops being
 * recognisable without type information. That is a limitation of the rule
 * CLASS, not of these selectors, and tightening the patterns will not close it.
 *
 * So the honest guarantee is: **this makes the raw-bearer reach impossible to
 * write by accident and impossible to write casually.** Someone determined to
 * extract a bearer can still do it. The rule buys a loud failure on the shapes
 * people actually reach for, and a documented boundary for review to point at —
 * not an enforced invariant.
 *
 * The version that WOULD be an invariant is type-aware linting (a custom rule
 * with `parserOptions.project`, banning the method on a receiver typed
 * `CredentialLease`/`OpenFrameBearerSource` while allowing `CloudBearerSource`).
 * That is a different rule class with a real type-check cost on every shared
 * lint, and it is not this ticket.
 *
 * The section below is the measurement that settled the SHAPE of the rule. Read
 * it before widening this to the method name — that was the first design and it
 * does not work.
 */

/**
 * ── WHY THIS RULE IS NARROWER THAN "BAN `getBearerToken` OUTSIDE AN ALLOWLIST" ──
 *
 * That was the design, and it was MEASURED and rejected rather than reasoned
 * about. Banning `MemberExpression[property.name='getBearerToken']` outside a
 * two-file allowlist produces **43 errors across 14 files**, and — the part that
 * kills it — the production hits include `remote-fetcher.ts` doing
 * `deps.bearer.getBearerToken()`, which is the `CloudBearerSource` pattern the
 * seam exists to ENDORSE.
 *
 * The reason is structural, not a matter of tuning the allowlist.
 * `deps.bearer.getBearerToken()` (authorized) and `source.getBearerToken()`
 * (raw) are the SAME SYNTAX. Only their receiver's TYPE differs, and
 * `no-restricted-syntax` selectors are type-blind. To make the broad form green
 * the allowlist has to name every legitimate consumer — which is every file
 * that uses the method — so it would restrict nothing while reading as a
 * boundary. A fence whose allowlist is its own violator list is worse than no
 * fence: it reports clean and inspects nothing.
 *
 * (Expressing the real property needs type-aware linting — a custom rule with
 * `parserOptions.project`, banning the method on a receiver typed
 * `CredentialLease`/`OpenFrameBearerSource` while allowing `CloudBearerSource`.
 * That is a different rule class with a real type-check cost on every shared
 * lint, and it is not this ticket.)
 *
 * So this fences the ESCAPE HATCH by name instead — the one the branding
 * genuinely cannot close, stated precisely: `RequestContext.credentials` is
 * public, so any module holding a context can reach past its declared
 * dependency and help itself to a raw bearer. `ctx.credentials.getBearerToken()`
 * is that reach, it is syntactically distinctive, and no type information is
 * needed to recognise it.
 *
 * It is PROSPECTIVE, and that is stated rather than hidden: there are currently
 * **zero** production reaches of this shape anywhere in `clients/`. It stops the
 * next one, and it does not pretend to have found a live defect.
 *
 * Note what is DELIBERATELY still legal, because it looks similar and is not:
 * passing `ctx.credentials` along as an `OpenFrameBearerSource` (the five
 * `bearer: () => …getRequestContext()?.credentials ?? null` sites in gui-app).
 * Handing a transport its lease is the injection pattern; pulling the string out
 * of the lease is the reach. Both are member access on the same public field,
 * which is why this is a lint rule rather than a type.
 *
 * ── PROVING IT STILL FIRES ──
 *
 * A fence with zero hits is indistinguishable from a fence that has stopped
 * matching, and nothing in a green lint tells them apart. Re-run this after
 * touching the selector, the config wiring, or either package's block order -
 * and run it in BOTH packages, because a rule proven to fire in one is not
 * proven in the other (that assumption is what left gui-app unfenced for a
 * round):
 *
 *   cd clients/gui-app && printf '\nexport function __p(c: { credentials: { getBearerToken(): string } }): string {\n  return c.credentials.getBearerToken();\n}\n' >> src/lib/host/host-messenger.ts
 *   bunx eslint src/lib/host/host-messenger.ts --max-warnings 0   # expect exit 1, 1 error
 *   git checkout -- src/lib/host/host-messenger.ts
 *
 *   cd clients/shared && printf '\nexport function __p(c: { credentials: { getBearerToken(): string } }): string {\n  return c.credentials.getBearerToken();\n}\n' >> host-client/remote-fetcher.ts
 *   bunx eslint host-client/remote-fetcher.ts --max-warnings 0    # expect exit 1, 1 error
 *   git checkout -- host-client/remote-fetcher.ts
 *
 * Measure the exit code UNPIPED - `$?` after a pipe is the last command's.
 */

const FENCE_MESSAGE =
  "Do not reach a raw bearer out of a RequestContext. " +
  "`ctx.credentials.getBearerToken()` bypasses the declared dependency: it is " +
  "how a cloud call helps itself to a credential the composition never " +
  "authorized for cloud use. Take a `CloudBearerSource` as a parameter instead, " +
  "so the composition root decides. Host-local transport that puts a token in a " +
  "WS open frame receives its source injected and does not need this reach. " +
  "A new exemption is a scope question — raise it rather than widening the " +
  "allowlist.";

/**
 * `<anything>.credentials.getBearerToken` — the reach past a declared
 * dependency, and the exact hazard `CloudBearerSource` cannot express.
 *
 * Matches the member access itself rather than the call, so aliasing the method
 * out (`const read = ctx.credentials.getBearerToken`) is caught too.
 */
export const cloudBearerContextReachRestriction = {
  // Dot AND computed access on both hops. `ctx["credentials"].getBearerToken()`
  // fails `object.property.name` (a computed key parses as `property.value`),
  // and it was measured escaping the earlier one-form selector.
  selector: [
    "MemberExpression[object.property.name='credentials'][property.name='getBearerToken']",
    "MemberExpression[object.property.value='credentials'][property.name='getBearerToken']",
    "MemberExpression[object.property.name='credentials'][property.value='getBearerToken']",
    "MemberExpression[object.property.value='credentials'][property.value='getBearerToken']",
  ].join(", "),
  message: FENCE_MESSAGE,
};

/**
 * The single-hop alias: `const lease = ctx.credentials`. Binding the lease to a
 * name moves the object out of the two-hop pattern entirely, so the reach
 * becomes `lease.getBearerToken()` and no member expression names `credentials`
 * any more.
 *
 * Fenced at the BINDING rather than at the later call, because the binding is
 * the part that is still syntactically visible. This is a heuristic and it is
 * the reason the header's guarantee is worded the way it is.
 */
export const cloudBearerAliasBindingRestriction = {
  selector: [
    "VariableDeclarator > MemberExpression[property.name='credentials']",
    "VariableDeclarator > MemberExpression[property.value='credentials']",
  ].join(", "),
  message:
    "Do not bind `ctx.credentials` to a local name. Aliasing the lease moves it " +
    "out of the raw-bearer fence, so `lease.getBearerToken()` reads as ordinary " +
    "member access on a local. Pass the context, or take a `CloudBearerSource` " +
    "as a declared dependency. Host-local transport receives its source injected " +
    "and does not need to bind one.",
};

export const cloudBearerFenceRestrictions = [
  cloudBearerContextReachRestriction,
  cloudBearerAliasBindingRestriction,
];

/**
 * Exempt: the suites that test the credential lease's own contract.
 *
 * `request-context.test.ts` and `request-context-provider.test.ts` assert on
 * rotation, release and throw-on-released BY reading the bearer through a
 * context — that IS the behaviour under test, so fencing it would be fencing
 * the lease's own coverage. Scoped to those files by name rather than to
 * `__tests__/**`: a test in some unrelated suite reaching for a raw bearer is a
 * real violation of the rule's intent, and a blanket test exemption would erase
 * exactly what the boundary protects. (Same reasoning, and same wording, as the
 * `real-supervisor-*` exemption in the shared config.)
 */
export const cloudBearerFenceAllowlist = [
  "auth/__tests__/request-context.test.ts",
  "auth/__tests__/request-context-provider.test.ts",
  "host-client/__tests__/host-client.test.ts",
  "host-client/__tests__/host-runtime.test.ts",
];

/**
 * The gui-app half of the allowlist, kept separate because the two packages'
 * ESLint `files` patterns are resolved against different roots.
 *
 * `auth-service.test.ts` asserts what the service INSTALLS on the context - that
 * a sign-in publishes the bearer, that a same-user rotation replaces it in
 * place, that a sign-out releases the lease. Reading it back through the context
 * is how those are observable at all, so this is the same exemption class as the
 * shared suites above and not a fifth kind of thing.
 */
export const cloudBearerFenceGuiAllowlist = [
  "src/lib/auth/__tests__/auth-service.test.ts",
];
