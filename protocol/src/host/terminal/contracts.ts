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
  createTerminalRequestSchemaV21,
  createTerminalResponseSchema,
  createTerminalResponseSchemaV20,
  killTerminalRequestSchema,
  killTerminalResponseSchema,
  listTerminalsRequestSchema,
  listTerminalsRequestSchemaV20,
  listTerminalsResponseSchema,
  listTerminalsResponseSchemaV20,
  listTerminalsResponseSchemaV21,
  listTerminalsResponseSchemaV22,
  listTerminalsResponseSchemaV23,
  readTerminalOutputRequestSchema,
  readTerminalOutputResponseSchema,
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
  terminalSubscribeV15,
  terminalSubscribeV16,
} from "@traycer/protocol/host/terminal/subscribe";

// Terminal sessions live entirely in the host's memory; these contracts expose the unary lifecycle (create/kill/list).
export const terminalCreateV10 = defineRpcContract({
  method: "terminal.create",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: createTerminalRequestSchema,
  responseSchema: createTerminalResponseSchema,
});

// `providers.list@2.0` - `scope: { kind: "independent" }` requests a landing-scope (epic-less) session - the feature gate.
export const terminalCreateV20 = defineRpcContract({
  method: "terminal.create",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: createTerminalRequestSchemaV20,
  responseSchema: createTerminalResponseSchemaV20,
});

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

// `agent.tui.prepareLaunch@1.1` - Additive request-side `themeHint` (spawning client's resolved terminal appearance, for host-side OSC 10/11 replies); request otherwise unchanged, response identical to `@2.0`.
export const terminalCreateV21 = defineRpcContract({
  method: "terminal.create",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: createTerminalRequestSchemaV21,
  responseSchema: createTerminalResponseSchemaV20,
});

// A v2.0 request carries no spawner theme, so the upgrade fills the "no hint" default and the host answers OSC 10/11 with its fixed dark fallback.
export const terminalCreateUpgradeV20ToV21 = defineUpgradePath<
  typeof terminalCreateV20,
  typeof terminalCreateV21
>({
  from: terminalCreateV20.schemaVersion,
  to: terminalCreateV21.schemaVersion,
  upgradeRequest: (request) => ({ ...request, themeHint: null }),
  upgradeResponse: (response) => response,
});

// Major 2's latest bridge to v1.0.
// Strip `themeHint` - a v1.0 host predates host-side OSC replies entirely, so dropping the hint loses nothing - then apply the frozen scope-to-epic fold, keeping the independent-scope failure gate.
export const terminalCreateDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalCreateV21,
  typeof terminalCreateV10
>({
  from: terminalCreateV21.schemaVersion,
  to: terminalCreateV10.schemaVersion,
  downgradeRequest: (request) => {
    const { themeHint: _themeHint, ...rest } = request;
    return terminalCreateDowngradeV20ToV10.downgradeRequest(rest);
  },
  downgradeResponse: (response) =>
    terminalCreateDowngradeV20ToV10.downgradeResponse(response),
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

// `scope: { kind: "independent" }` lists landing-scope (epic-less) sessions instead of an epic's.
// Frozen released shape - do not edit in place.
export const terminalListV20 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: listTerminalsRequestSchemaV20,
  responseSchema: listTerminalsResponseSchemaV20,
});

// Additive `homeCwd` on the response; request is identical to `@2.0`.
// Canonical for major 2 after this minor lands.
export const terminalListV21 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 2, minor: 1 } as const,
  requestSchema: listTerminalsRequestSchemaV20,
  responseSchema: listTerminalsResponseSchemaV21,
});

// Additive live current-directory metadata on each response session; request
// is unchanged from `@2.0`/`@2.1`.
export const terminalListV22 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 2, minor: 2 } as const,
  requestSchema: listTerminalsRequestSchemaV20,
  responseSchema: listTerminalsResponseSchemaV22,
});

// Additive lifetime-owner discriminator on each response session; request
// is unchanged from `@2.0`/`@2.1`/`@2.2`.
export const terminalListV23 = defineRpcContract({
  method: "terminal.list",
  schemaVersion: { major: 2, minor: 3 } as const,
  requestSchema: listTerminalsRequestSchemaV20,
  responseSchema: listTerminalsResponseSchemaV23,
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

// A v2.0 peer has no authoritative host home path, so the upgrade fills
// `homeCwd: null`. Sessions pass through unchanged.
export const terminalListUpgradeV20ToV21 = defineUpgradePath<
  typeof terminalListV20,
  typeof terminalListV21
>({
  from: terminalListV20.schemaVersion,
  to: terminalListV21.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    sessions: response.sessions,
    homeCwd: null,
  }),
});

// A v2.1 host cannot observe live directory changes.
// The frozen v2.1 schema allowed an empty `cwd`, so v2.2 accepts that compatibility value and clients treat it as unavailable.
export const terminalListUpgradeV21ToV22 = defineUpgradePath<
  typeof terminalListV21,
  typeof terminalListV22
>({
  from: terminalListV21.schemaVersion,
  to: terminalListV22.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    sessions: response.sessions.map((session) => ({
      ...session,
      currentCwd: session.cwd,
    })),
    homeCwd: response.homeCwd,
  }),
});

// A v2.2 host cannot name lifetime ownership. Fill `registry` so a capable
// client fail-closes the row as a durable shadow instead of promoting it.
export const terminalListUpgradeV22ToV23 = defineUpgradePath<
  typeof terminalListV22,
  typeof terminalListV23
>({
  from: terminalListV22.schemaVersion,
  to: terminalListV23.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    sessions: response.sessions.map((session) => ({
      ...session,
      lifecycleOwner: "registry" as const,
    })),
    homeCwd: response.homeCwd,
  }),
});

// Bridges from v2.1 (major 2's latest) down to the frozen v1.0 - not from v2.0, since v2.1 supersedes it as major 2's latest.
export const terminalListDowngradeV21ToV10 = defineDowngradePath<
  typeof terminalListV21,
  typeof terminalListV10
>({
  from: terminalListV21.schemaVersion,
  to: terminalListV10.schemaVersion,
  downgradeRequest: (request) => {
    const epicId = downgradeTerminalScopeForV10(request.scope);
    if (!epicId.ok) return epicId;
    return { ok: true, value: { epicId: epicId.value } };
  },
  downgradeResponse: (response) => {
    const downgraded = response.sessions.map(
      downgradeTerminalSessionInfoForV10,
    );
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

// Major 2's latest bridge to v1.0. Project `currentCwd` away before applying
// the frozen scope-to-epic downgrade; old peers continue seeing launch `cwd`.
export const terminalListDowngradeV22ToV10 = defineDowngradePath<
  typeof terminalListV22,
  typeof terminalListV10
>({
  from: terminalListV22.schemaVersion,
  to: terminalListV10.schemaVersion,
  downgradeRequest: (request) => {
    const epicId = downgradeTerminalScopeForV10(request.scope);
    if (!epicId.ok) return epicId;
    return { ok: true, value: { epicId: epicId.value } };
  },
  downgradeResponse: (response) => {
    const downgraded = response.sessions.map((session) => {
      return downgradeTerminalSessionInfoForV10({
        sessionId: session.sessionId,
        scope: session.scope,
        sessionKind: session.sessionKind,
        cwd: session.cwd,
        shellCommand: session.shellCommand,
        shellArgs: session.shellArgs,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        exitCode: session.exitCode,
        exitReason: session.exitReason,
        createdAt: session.createdAt,
        title: session.title,
        activeProcessName: session.activeProcessName,
      });
    });
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

// Major 2's latest bridge to v1.0. Strip `lifecycleOwner` then reuse the
// v2.2 currentCwd projection so old peers still see launch `cwd`.
export const terminalListDowngradeV23ToV10 = defineDowngradePath<
  typeof terminalListV23,
  typeof terminalListV10
>({
  from: terminalListV23.schemaVersion,
  to: terminalListV10.schemaVersion,
  downgradeRequest: (request) => {
    const epicId = downgradeTerminalScopeForV10(request.scope);
    if (!epicId.ok) return epicId;
    return { ok: true, value: { epicId: epicId.value } };
  },
  downgradeResponse: (response) =>
    terminalListDowngradeV22ToV10.downgradeResponse({
      sessions: response.sessions.map((session) => {
        const { lifecycleOwner: _lifecycleOwner, ...rest } = session;
        return rest;
      }),
      homeCwd: response.homeCwd,
    }),
});

// Brand-new method - an older host simply lacks it, so the registry puts it on the `degrade: unsupported` channel rather than the released floor.
export const terminalReadOutputV10 = defineRpcContract({
  method: "terminal.readOutput",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: readTerminalOutputRequestSchema,
  responseSchema: readTerminalOutputResponseSchema,
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
  terminalSubscribeV15,
  terminalSubscribeV16,
};
