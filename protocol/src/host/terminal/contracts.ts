import {
  defineDowngradePath,
  defineRpcContract,
  defineUpgradePath,
  type DowngradeResult,
  type RpcErrorDetails,
} from "@traycer/protocol/framework/index";
import {
  type CanonicalTerminalSessionInfo,
  createTerminalRequestSchema,
  createTerminalRequestSchemaV20,
  createTerminalResponseSchema,
  createTerminalResponseSchemaV20,
  killTerminalRequestSchema,
  killTerminalResponseSchema,
  listTerminalsRequestSchema,
  listTerminalsRequestSchemaV20,
  listTerminalsResponseSchema,
  listTerminalsResponseSchemaV20,
  renameTerminalRequestSchema,
  renameTerminalResponseSchema,
  type TerminalScope,
  type TerminalSessionInfo,
} from "@traycer/protocol/host/terminal/unary-schemas";
import {
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
  terminalSubscribeV14,
} from "@traycer/protocol/host/terminal/subscribe";

// Terminal sessions live entirely in the host's memory; these contracts
// expose the unary lifecycle (create/kill/list). The actual byte stream is
// carried by `terminal.subscribe` co-located in `./subscribe.ts`.
export const terminalCreateV10 = defineRpcContract({
  method: "terminal.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createTerminalRequestSchema,
  responseSchema: createTerminalResponseSchema,
});

// `scope: { kind: "independent" }` requests a landing-scope (epic-less)
// session - the feature gate. `scope` replacing `epicId` is a breaking
// change to the request shape (the unary framework's minor-additivity
// checker rejects a field rename within a minor line - see
// `terminalScopeSchema`'s comment in `unary-schemas.ts`), so this rides a
// new major, mirroring the `providers.list@2.0` precedent (registry.ts
// ~585-690): `terminalCreateUpgradeV10ToV20` bridges an old peer up to
// canonical, `terminalCreateDowngradeV20ToV10` bridges canonical back down
// for an old peer.
export const terminalCreateV20 = defineRpcContract({
  method: "terminal.create",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: createTerminalRequestSchemaV20,
  responseSchema: createTerminalResponseSchemaV20,
});

// A v1.0 peer's plain `epicId` string is always epic-scoped, so it folds
// into `{ kind: "epic", epicId }` on both the request and the response's
// echoed session info. The newer side runs this when bridging a v1.0 peer
// up to canonical (host: inbound v1.0 request; client: inbound v1.0
// response).
export const terminalCreateUpgradeV10ToV20 = defineUpgradePath<
  typeof terminalCreateV10,
  typeof terminalCreateV20
>({
  from: terminalCreateV10.schemaVersion,
  to: terminalCreateV20.schemaVersion,
  upgradeRequest: (request) => {
    const { epicId, ...rest } = request;
    return { ...rest, scope: { kind: "epic", epicId } };
  },
  upgradeResponse: (response) => {
    const { epicId, ...session } = response.session;
    return { session: { ...session, scope: { kind: "epic", epicId } } };
  },
});

// `kind: "epic"` folds back to a plain `epicId` string for a v1.0 peer;
// `kind: "independent"` has no v1.0 representation - that absence, surfaced
// as a structured `DOWNGRADE_UNSUPPORTED` result, IS the feature gate
// (mirrors `unsupportedProviderStateDowngrade`/`downgradeProviderStateForV10`
// in `registry.ts`).
function downgradeTerminalScopeForV10(
  scope: TerminalScope,
): DowngradeResult<string> {
  if (scope.kind === "independent") {
    return {
      ok: false,
      error: {
        code: "DOWNGRADE_UNSUPPORTED",
        message:
          "Independent-scope terminal sessions have no representation in terminal.*@1.0",
      },
    };
  }
  return { ok: true, value: scope.epicId };
}

function downgradeTerminalSessionInfoForV10(
  session: CanonicalTerminalSessionInfo,
): DowngradeResult<TerminalSessionInfo> {
  const epicId = downgradeTerminalScopeForV10(session.scope);
  if (!epicId.ok) return epicId;
  const { scope, ...rest } = session;
  return { ok: true, value: { ...rest, epicId: epicId.value } };
}

export const terminalCreateDowngradeV20ToV10 = defineDowngradePath<
  typeof terminalCreateV20,
  typeof terminalCreateV10
>({
  from: terminalCreateV20.schemaVersion,
  to: terminalCreateV10.schemaVersion,
  downgradeRequest: (request) => {
    const epicId = downgradeTerminalScopeForV10(request.scope);
    if (!epicId.ok) return epicId;
    const { scope, ...rest } = request;
    return { ok: true, value: { ...rest, epicId: epicId.value } };
  },
  downgradeResponse: (response) => {
    const session = downgradeTerminalSessionInfoForV10(response.session);
    if (!session.ok) return session;
    return { ok: true, value: { session: session.value } };
  },
});

export const terminalKillV10 = defineRpcContract({
  method: "terminal.kill",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: killTerminalRequestSchema,
  responseSchema: killTerminalResponseSchema,
});

export const terminalListV10 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTerminalsRequestSchema,
  responseSchema: listTerminalsResponseSchema,
});

// `scope: { kind: "independent" }` lists landing-scope (epic-less) sessions
// instead of an epic's. See `terminalCreateV20`'s comment for the
// major-bump rationale.
export const terminalListV20 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listTerminalsRequestSchemaV20,
  responseSchema: listTerminalsResponseSchemaV20,
});

export const terminalListUpgradeV10ToV20 = defineUpgradePath<
  typeof terminalListV10,
  typeof terminalListV20
>({
  from: terminalListV10.schemaVersion,
  to: terminalListV20.schemaVersion,
  upgradeRequest: (request) => ({
    scope: { kind: "epic", epicId: request.epicId },
  }),
  upgradeResponse: (response) => ({
    sessions: response.sessions.map((session) => {
      const { epicId, ...rest } = session;
      return { ...rest, scope: { kind: "epic", epicId } };
    }),
  }),
});

export const terminalListDowngradeV20ToV10 = defineDowngradePath<
  typeof terminalListV20,
  typeof terminalListV10
>({
  from: terminalListV20.schemaVersion,
  to: terminalListV10.schemaVersion,
  downgradeRequest: (request) => {
    const epicId = downgradeTerminalScopeForV10(request.scope);
    if (!epicId.ok) return epicId;
    return { ok: true, value: { epicId: epicId.value } };
  },
  downgradeResponse: (response) => {
    const downgraded = response.sessions.map(downgradeTerminalSessionInfoForV10);
    // A single un-representable session fails the whole response: a v1.0 peer's
    // session shape has no field that can carry an independent-scope terminal,
    // so there is no partial list worth sending.
    const failure = downgraded.find(
      (result): result is { ok: false; error: RpcErrorDetails } => !result.ok,
    );
    if (failure !== undefined) return failure;
    return {
      ok: true,
      value: {
        sessions: downgraded.flatMap((result) =>
          result.ok ? [result.value] : [],
        ),
      },
    };
  },
});

export const terminalRenameV10 = defineRpcContract({
  method: "terminal.rename",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: renameTerminalRequestSchema,
  responseSchema: renameTerminalResponseSchema,
});

export {
  terminalSubscribeV10,
  terminalSubscribeV11,
  terminalSubscribeV12,
  terminalSubscribeV13,
  terminalSubscribeV14,
};
