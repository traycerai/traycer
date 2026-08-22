# Codex Multi-Agent Subagent UI Integration Plan

## Status

- **Feature branch:** feat/codex-subagents-ui
- **Delivery:** one feature branch and one continuous implementation sequence
- **Supported native runtimes:** Codex multi-agent V1 and Codex multi-agent V2
- **Target UI:** the existing Claude-style subagent cards and Background panel
- **Protocol posture:** reuse the existing provider-neutral lifecycle; do not
  introduce a new RPC minor unless implementation evidence proves it necessary
- **Current estimate:** 5–7 engineer-days after the signed-Host baseline trace

This document is the implementation authority for the feature. All code,
fixtures, tests, compatibility work, observability, documentation, and release
evidence land on feat/codex-subagents-ui. The numbered steps below express
dependency order only; they are not separate delivery branches.

## 1. Objective

Support both Codex multi-agent V1 and V2, detect which runtime a root Codex
execution is using, route native events through the matching adapter, and
project both runtimes into exactly the same Traycer presentation:

- one collapsible transcript card per child execution;
- a non-empty task and placeholder identity from the first observable
  activation;
- late nickname and role enrichment;
- bounded progress summaries;
- completed, failed, and explicitly stopped outcomes;
- arbitrary-depth nested subagents;
- Background-panel rows and navigation;
- individual stop and Stop all;
- child approvals and user-input requests through the existing global surfaces;
- detached updates after the root turn has ended; and
- crash/reconnect recovery without duplicate or permanently running cards.

The V1 and V2 adapters differ only at the native Codex boundary. Everything
after native normalization is shared.

## 2. Non-goals

This feature does not add:

- a native Codex Active/Done child browser;
- the ability to open a native child thread;
- follow-up, resume, steer, or message controls on the card;
- child narration or reasoning in the root transcript;
- every child tool row inside the expanded card;
- subagent attribution in the global approval queue;
- resolved approval cards inside subagent cards;
- same-card continuation when a native thread is resumed;
- durable Traycer agent records for provider-native children;
- Epic sidebar nodes for provider-native children;
- a Codex-specific React card;
- a new public content-block type; or
- a new public multi-agent management API.

A resumed native child thread that begins another execution receives a fresh
Traycer run ID and a fresh card.

## 3. Existing behavior being extended

The public contract and GUI already expect a partial Codex subagent projection.
The existing behavior must be captured from the currently signed Host and
preserved wherever the new V1 or V2 implementation is not enabled.

Public evidence already expects the current Codex adapter to:

- emit subagent.started without a separate Claude-style spawn tool row;
- omit spawnToolCallId for Codex;
- open a placeholder card before asynchronous nickname lookup finishes;
- re-emit subagent.started when nickname metadata arrives;
- accept late metadata after completion without changing terminal duration;
- emit some form of subagent completion;
- use the generic SubAgentBlock and SubagentSegment; and
- support detached Codex background-command terminals.

Relevant shared files:

- [agent-runtime.ts](../protocol/src/host/agent/gui/agent-runtime.ts)
- [agent-runtime-accumulator.ts](../protocol/src/host/agent/gui/agent-runtime-accumulator.ts)
- [content-blocks.ts](../protocol/src/persistence/epic/content-blocks.ts)
- [rendered-messages.ts](../clients/gui-app/src/stores/chats/rendered-messages.ts)
- [subagent-segment.tsx](../clients/gui-app/src/components/chat/segments/subagent-segment.tsx)

Before implementation, capture a sanitized trace from the currently signed Host
for both a normal Codex subagent run and its current terminal behavior. That
trace is the feature-disabled compatibility baseline.

The implementation must distinguish:

### Existing shared infrastructure

- runtime event schemas;
- persisted subagent blocks;
- the accumulator;
- generic rendering;
- nested-card folding;
- detached-owner routing;
- Background actions; and
- the existing session-stop escalation.

### Existing Codex projection to preserve

- placeholder card;
- late nickname refresh;
- no duplicate spawn tool row;
- current V1-shaped event behavior; and
- current completion behavior.

### New or extended behavior

- first-class V1 and V2 adapters;
- effective runtime detection;
- execution-scoped identity;
- root-terminal descendant cancellation;
- child lifecycle suppression fixes;
- terminal monotonicity;
- recursive detached-start routing;
- exact interview ordering;
- pending-only child approval projection;
- named recovery persistence;
- Codex Host publication, lifecycle ownership, and recovery of the
  already-supported subagent Background rows;
- exact child stop and reconciliation; and
- full reconnect recovery.

## 4. Existing Traycer contract

### 4.1 Runtime lifecycle

[agent-runtime.ts](../protocol/src/host/agent/gui/agent-runtime.ts) already
defines the public lifecycle:

```ts
type SubagentProjection =
  | {
      type: "subagent.started";
      blockId: string;
      timestamp: number;
      parentBlockId?: string | null;
      name: string;
      task?: string;
      agentType?: string | null;
      spawnToolCallId?: string;
    }
  | {
      type: "subagent.progress";
      blockId: string;
      timestamp: number;
      parentBlockId?: string | null;
      update: string;
    }
  | {
      type: "subagent.completed";
      blockId: string;
      timestamp: number;
      parentBlockId?: string | null;
      outcome: "completed" | "failed" | "stopped";
      result?: string;
    };
```

Both Codex runtimes omit spawnToolCallId. That field represents Claude’s
separate Task/Agent tool-call row; Codex native collaboration activity is
already the activation signal.

### 4.2 Persisted card

[content-blocks.ts](../protocol/src/persistence/epic/content-blocks.ts) already
persists:

- block identity and parent;
- streaming/completed/errored state;
- name and agent type;
- task;
- progress history;
- result;
- immutable start time;
- terminal timestamp;
- stopped state; and
- optional workflow enrichment.

No new public persisted card type is needed.

### 4.3 Shared child-event policy

[subagent-nesting.ts](../protocol/src/host/agent/gui/subagent-nesting.ts) is the
shared containment boundary. It suppresses child narration and converts
ordinary child activity into events nested under the owning card.

This helper requires a correctness fix described in Section 13 before either
new adapter relies on it.

### 4.4 Existing GUI

The GUI is provider-neutral:

- [rendered-messages.ts](../clients/gui-app/src/stores/chats/rendered-messages.ts)
  projects generic subagent blocks;
- nested cards are folded by parentBlockId;
- [subagent-segment.tsx](../clients/gui-app/src/components/chat/segments/subagent-segment.tsx)
  renders the shared card; and
- [chat-session-store.ts](../clients/gui-app/src/stores/chats/chat-session-store.ts)
  routes later events to settled owner messages.

A small detached-routing fix is required for the first nested child event after
the root turn has settled; see Section 16.

## 5. Codex source authority

The current
[Codex App Server documentation](https://developers.openai.com/codex/app-server)
establishes:

- thread, turn, and item event streaming;
- authoritative item/completed state;
- terminal turn statuses;
- exact turn/interrupt addressing; and
- version-specific schema generation.

The current
[Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
establishes default availability, sandbox inheritance, approval inheritance,
and non-interactive approval failure behavior.

Codex multi-agent V2 is not fully described in the current public manual.
For V2, the implementation authority is:

1. the exact generated schema for each supported Codex binary;
2. the effective feature/model capability reported at runtime;
3. pinned native implementation behavior for that version; and
4. sanitized version-matched runtime fixtures.

## 6. Runtime terminology and naming

Use concrete version names only:

```ts
type CodexMultiAgentVersion = "v1" | "v2";
```

Native configuration keeps Codex spelling:

```text
multi_agent
multi_agent_v2
```

Traycer TypeScript uses camelCase:

```text
codexMultiAgentVersion
codexMultiAgentV1Adapter
codexMultiAgentV2Adapter
detectCodexMultiAgentVersion
```

Metrics and persisted JSON use the repository’s normal snake_case conventions:

```text
codex_multi_agent_version=v1|v2
```

Do not introduce legacy/enhanced terminology.

## 7. Runtime detection

### 7.1 Detection result

```ts
type CodexMultiAgentDetection =
  | {
      enabled: false;
      version: null;
      reason: "agentsDisabled" | "modelDisabled" | "featureUnavailable";
    }
  | {
      enabled: true;
      version: "v1" | "v2";
      source: "multiAgentV2Feature" | "modelCapability" | "multiAgentV1Feature";
    };
```

### 7.2 Current resolution precedence

For the current Codex runtime:

```text
enabled multi_agent_v2
→ V2

otherwise agents.enabled == false
→ disabled

otherwise model-advertised multiAgentVersion
→ advertised disabled / V1 / V2

otherwise enabled multi_agent
→ V1

otherwise
→ disabled
```

Implement:

```ts
function detectCodexMultiAgentVersion(input: {
  multiAgentV2Enabled: boolean;
  agentsEnabled: boolean | null;
  modelMultiAgentVersion: "disabled" | "v1" | "v2" | null;
  multiAgentV1Enabled: boolean;
}): CodexMultiAgentDetection {
  if (input.multiAgentV2Enabled) {
    return {
      enabled: true,
      version: "v2",
      source: "multiAgentV2Feature",
    };
  }

  if (input.agentsEnabled === false) {
    return {
      enabled: false,
      version: null,
      reason: "agentsDisabled",
    };
  }

  if (
    input.modelMultiAgentVersion === "v1" ||
    input.modelMultiAgentVersion === "v2"
  ) {
    return {
      enabled: true,
      version: input.modelMultiAgentVersion,
      source: "modelCapability",
    };
  }

  if (input.modelMultiAgentVersion === "disabled") {
    return {
      enabled: false,
      version: null,
      reason: "modelDisabled",
    };
  }

  if (input.multiAgentV1Enabled) {
    return {
      enabled: true,
      version: "v1",
      source: "multiAgentV1Feature",
    };
  }

  return {
    enabled: false,
    version: null,
    reason: "featureUnavailable",
  };
}
```

Prefer Codex’s already-resolved Model.multiAgentVersion when the running
app-server supplies it. Keep feature/config fallback for older binaries.

### 7.3 Detection scope

Latch the detected version per root turn, not globally per Host process.

```ts
interface CodexRootExecution {
  rootThreadId: string;
  rootTurnId: string;
  codexMultiAgentVersion: CodexMultiAgentVersion;
}
```

Every descendant inherits the version of the root execution that created it.
Do not switch an existing child tree from V1 to V2 mid-run.

A later root turn may legitimately select another version after a model or
configuration change.

### 7.4 Event family is validation, not detection

The generated ThreadItem union contains both collabAgentToolCall and
subAgentActivity independent of the active runtime. V2 wait also emits a
legacy-shaped collabAgentToolCall.

Therefore this is forbidden:

```ts
const version = item.type === "collabAgentToolCall" ? "v1" : "v2";
```

Dispatch from the latched version:

```ts
const adapter = codexMultiAgentAdapters[rootExecution.codexMultiAgentVersion];

await adapter.handleItemStarted(envelope, item);
```

Observed event families are consistency checks. A contradiction emits telemetry
and triggers reconciliation; it does not flip the version mid-execution.

## 8. Native adapter interface

Both native adapters implement:

```ts
interface CodexMultiAgentAdapter {
  readonly version: CodexMultiAgentVersion;

  handleItemStarted(
    envelope: CodexItemEnvelope,
    item: ThreadItem,
  ): Promise<void>;

  handleItemCompleted(
    envelope: CodexItemEnvelope,
    item: ThreadItem,
  ): Promise<void>;

  handleTurnStarted(event: CodexTurnStarted): Promise<void>;

  handleTurnCompleted(event: CodexTurnCompleted): Promise<void>;

  handleServerRequest(request: CodexServerRequest): Promise<void>;

  stopRun(
    run: CodexSubagentRun,
    cause: CodexStopCause,
  ): Promise<CodexStopDispatchResult>;

  reconcileRun(run: PersistedCodexSubagentRun): Promise<CodexNativeRunSnapshot>;

  rebuildDescendants(
    root: CodexRootExecution,
  ): Promise<ReadonlyArray<CodexNativeRunSnapshot>>;
}

const codexMultiAgentAdapters: Readonly<
  Record<CodexMultiAgentVersion, CodexMultiAgentAdapter>
> = {
  v1: codexMultiAgentV1Adapter,
  v2: codexMultiAgentV2Adapter,
};
```

Each adapter emits provider-neutral internal signals. The shared tracker never
parses collabAgentToolCall, subAgentActivity, sendInput, or followup_task.

```ts
type NormalizedCodexSubagentSignal =
  | {
      type: "activation";
      activationId: string;
      parentNativeIdentity: string | null;
      childNativeIdentity: string | null;
      task: string | null;
      name: string | null;
      role: string | null;
      observedAtMs: number;
    }
  | {
      type: "childActivity";
      nativeRunIdentity: string;
      event: RuntimeEvent;
      observedAtMs: number;
    }
  | {
      type: "metadata";
      nativeRunIdentity: string;
      name: string | null;
      role: string | null;
      task: string | null;
      observedAtMs: number;
    }
  | {
      type: "terminalHint";
      nativeRunIdentity: string;
      status: "completed" | "failed" | "interrupted" | "shutdown" | "notFound";
      result: string | null;
      authority: "exactTurn" | "history" | "activity" | "aggregateWait";
      observedAtMs: number;
    }
  | {
      type: "approvalRequest";
      nativeRunIdentity: string;
      request: CodexServerRequest;
    }
  | {
      type: "interviewRequest";
      nativeRunIdentity: string;
      request: CodexServerRequest;
    };
```

## 9. Codex multi-agent V1 adapter

### 9.1 Native tools

```text
spawn_agent
send_input
resume_agent
wait_agent
close_agent
```

### 9.2 App-server item

```ts
interface CodexMultiAgentV1Item {
  type: "collabAgentToolCall";
  id: string;
  tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
  status: "inProgress" | "completed" | "failed";
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  agentsStates: Record<string, CollabAgentState>;
}
```

ReasoningEffort is an open app-server string type, not a closed enum.

### 9.3 V1 spawn timing

V1 spawn emits:

```text
item/started collabAgentToolCall(spawnAgent)
receiverThreadIds = []

later:

item/completed collabAgentToolCall(spawnAgent)
receiverThreadIds = [childThreadId]
```

The V1 adapter must:

1. create and persist the placeholder card from item/started;
2. derive public identity from the activation item, not the unavailable receiver;
3. attach the receiver child thread at item/completed;
4. correlate later child turn/item activity through that receiver;
5. use agentsStates as reconciliation hints; and
6. prefer exact child turn completion/history over aggregate wait state.

### 9.4 V1 resume

Capture the version-matched sequence that starts another execution on an
existing V1 child thread. Whether resumeAgent, sendInput, or their combination
causes the new turn, the new execution receives a fresh public run ID.

### 9.5 V1 wait

V1 wait is aggregate status. It triggers exact reconciliation and cannot
overwrite an already selected terminal result.

## 10. Codex multi-agent V2 adapter

### 10.1 Native tools

```text
spawn_agent
send_message
followup_task
wait_agent
interrupt_agent
list_agents
```

### 10.2 App-server activity

```ts
interface CodexMultiAgentV2Activity {
  type: "subAgentActivity";
  id: string;
  kind: "started" | "interacted" | "interrupted";
  agentThreadId: string;
  agentPath: string;
}
```

V2 is not exclusively subAgentActivity:

- spawn, send-message, follow-up, and interrupt activity use subAgentActivity;
- wait_agent still emits collabAgentToolCall with tool wait; and
- list_agents emits neither lifecycle item.

The V2 adapter must accept both item families.

### 10.3 V2 spawn timing

V2 does not emit V1’s provisional spawn item with an empty receiver array.

Current V2 behavior:

1. native spawn succeeds;
2. app-server emits subAgentActivity.started;
3. agentThreadId is already present;
4. activity appears as an immediate item started/completed pair; and
5. no spawned-child thread/started notification is expected.

The V2 adapter creates the placeholder from subAgentActivity.started:

```text
runId =
  codex-subagent-v2:<rootTurnId>:<activityItemId>
```

Attach the native child turn when later turn/item traffic supplies it.

### 10.4 V2 interactions

Interpret:

```text
subAgentActivity.started
→ new activation

subAgentActivity.interacted
→ message/follow-up activity

subAgentActivity.interrupted
→ interruption hint, not automatically the authoritative terminal
```

An interacted activity may mean:

- a message sent into the currently running child; or
- a follow-up starting another execution after the child was idle/completed.

Use exact active state and child turn history to distinguish them. Never guess
from timing alone.

### 10.5 V2 wait exception

Continue parsing collabAgentToolCall with tool wait while V2 is active. Use it
as an aggregate reconciliation hint, not as V1 detection.

### 10.6 V2 parent ownership

V2 children reject direct turn/start and turn/steer. Follow-up and steering must
flow through the parent’s V2 collaboration tools.

This does not inherently prohibit exact child interruption.

### 10.7 V2 stop

Attempt:

```ts
turn /
  interrupt({
    threadId: childThreadId,
    turnId: childTurnId,
  });
```

On JSON-RPC -32600:

1. do not claim success immediately;
2. read exact child status/history;
3. determine stale turn, already terminal, or no active turn;
4. reconcile card and Background state; and
5. use a supported parent/session fallback only if the child remains live.

The runtime smoke suite must prove exact child interruption for every supported
V2 binary before individual Stop is advertised.

## 11. Shared execution identity

For both versions:

```text
one Codex child execution
        =
one globally unique Host runId
        =
subagent blockId
        =
BackgroundItem taskId
        =
BackgroundItem blockId
```

Never use the bare native child thread ID as public identity. A native thread
can run more than one execution.

Suggested V1 identity:

```text
codex-subagent-v1:<rootTurnId>:<activationItemId>
```

Suggested V2 identity:

```text
codex-subagent-v2:<rootTurnId>:<activityItemId>
```

If one activation creates multiple children, append a stable receiver index or
native child identity.

Namespace native child block IDs when global uniqueness is not guaranteed:

```text
codex-subagent-item:<runId>:<nativeItemId>
```

## 12. Parent identity is tri-state

Do not use string | null for unresolved parentage.

```ts
type ParentResolution =
  | { kind: "unresolved" }
  | { kind: "root" }
  | { kind: "subagent"; runId: string };
```

Projection:

```ts
function parentBlockIdForEvent(parent: ParentResolution): {
  parentBlockId?: string | null;
} {
  switch (parent.kind) {
    case "unresolved":
      return {};
    case "root":
      return { parentBlockId: null };
    case "subagent":
      return { parentBlockId: parent.runId };
  }
}
```

Semantics:

```text
undefined → unresolved/preserve
null      → confirmed root child
string    → confirmed nested child
```

Never emit late null unless root-level ownership is positively known.

## 13. Child lifecycle suppression fix

Native child turn lifecycle must never enter the root accumulator as root
turn.* events. The only public child terminal is subagent.completed.

Extend the suppression set in
[subagent-nesting.ts](../protocol/src/host/agent/gui/subagent-nesting.ts):

```ts
"turn.stopped",
"turn.interrupted",
"steer.submitted",
"compaction.errored",
```

Why:

- child turn.stopped currently finalizes every streaming block in the owning
  root assistant row except approval/interview;
- child turn.interrupted does the same;
- child steer.submitted injects a top-level steer/user boundary; and
- child compaction.errored creates a top-level errored compaction card.

This is a public production behavior fix, not a wire-schema change. It requires
no new chat.subscribe minor.

Both native adapters must also intercept child terminal lifecycle directly and
translate it into a normalized terminal hint/subagent.completed rather than
depending solely on helper suppression.

## 14. Root-terminal descendant policy

Only a clean root completion preserves children.

| Root terminal                       | Active descendants                   |
| ----------------------------------- | ------------------------------------ |
| clean turn.completed with no reason | continue detached                    |
| turn.stopped                        | interrupt and terminalize as stopped |
| STEER_RESTART interruption          | interrupt and terminalize as stopped |
| other turn.interrupted              | interrupt and terminalize as stopped |
| turn.completed with reason          | interrupt and terminalize as stopped |

Use explicit causes:

```ts
type CodexStopCause =
  | "singleItemStop"
  | "stopAll"
  | "rootTurnStop"
  | "rootTurnSteerRestart"
  | "rootTurnInterrupted"
  | "rootTurnDegraded"
  | "parentClose"
  | "providerCancellation";
```

On every non-clean root terminal:

1. snapshot every active descendant recursively;
2. persist each root-derived stop cause;
3. dispatch V1- or V2-appropriate exact child interruption;
4. emit subagent.completed(stopped) before applying the generic root terminal;
5. remove affected Background rows in the same serialized logical update;
6. drain pending child approvals/interviews;
7. apply the generic root terminal after children are terminal; and
8. suppress or reconcile later native terminals rather than re-emitting them.

This child-first ordering is load-bearing in both persisted Host accumulation
and live GUI frame delivery. The explicit subagent.completed(stopped) event
produces the selected root-cascade representation: status errored with
stopped: true, which renders as the neutral Stopped state. The generic root
terminal would produce a different result: interrupted for root stop,
superseded for steer restart, or completed for a degraded completion. Section
15 makes terminal state monotonic, so whichever terminal is accumulated first
becomes sticky. The Host must therefore persist and broadcast every
root-cascade child terminal before the corresponding root turn terminal.

The system must not paint a child stopped while leaving it running. An interrupt
rejection triggers native reconciliation and a supported control/session
fallback.

## 15. Terminal monotonicity

The shared accumulator currently allows late subagent.completed to overwrite an
interrupted, superseded, completed, failed, or stopped card. It also allows late
progress to mutate terminal cards.

Add defense-in-depth behavior:

- ignore subagent.progress when the card is terminal;
- make terminal status, stopped state, and terminal timestamp sticky;
- ignore duplicate/conflicting subagent.completed transitions;
- optionally fill a previously missing result without changing terminal state;
- retain the explicit new-run discriminator; and
- add equivalent protection anywhere workflow completion shares this lifecycle.

Producer-side V1/V2 run guards remain primary. The accumulator guard protects
against replay, reconnect, duplicate events, and future producer mistakes.

## 16. Early card ownership and nested detached starts

Every top-level and nested execution inherits one ultimate owning assistant
message.

```ts
child.owningAssistantMessageId =
  parent === root ? rootAssistantMessageId : parent.owningAssistantMessageId;
```

The initial card must be persisted before the parent execution can settle.

A nested spawn after the root turn has already settled is a detached write to
the parent run’s owning message.

Harden
[chat-session-store.ts](../clients/gui-app/src/stores/chats/chat-session-store.ts):

1. first route subagent events by the child blockId;
2. if no message owns the child and parentBlockId is a non-empty string, route
   to the message owning the parent;
3. treat the parent-derived route as mandatory;
4. for an event with a non-empty string parentBlockId, if neither child nor
   parent exists, drop rather than minting into a newer unrelated turn; and
5. leave ownerless top-level subagent events with no string parentBlockId on the
   current non-mandatory path so a legitimate first start can still fall
   through to the active assistant row.

This prevents the first nested subagent.started from appearing top-level in a
newer turn or disappearing when no turn is active without changing the existing
behavior for a new top-level subagent in the live turn.

Every detached insertion or update must monotonically advance blocksVersion
while preserving the outer settled message timestamp.

## 17. Shared run tracker

All tracker mutations run through one serialized executor per Traycer chat.
Async metadata/history reads re-enter that executor with the initiating
connection epoch.

```ts
type CodexSubagentPhase = "starting" | "running" | "stopRequested" | "terminal";

interface CodexSubagentRun {
  runId: string;
  codexMultiAgentVersion: "v1" | "v2";

  rootThreadId: string;
  rootTurnId: string;
  owningAssistantMessageId: string;
  parent: ParentResolution;

  native:
    | {
        version: "v1";
        activationItemId: string;
        childThreadId: string | null;
        childTurnId: string | null;
      }
    | {
        version: "v2";
        activityItemId: string;
        agentThreadId: string;
        agentPath: string;
        childTurnId: string | null;
      };

  task: string;
  name: string;
  role: string | null;
  startedAtMs: number;

  phase: CodexSubagentPhase;
  stopCause: CodexStopCause | null;
  terminal: CodexSubagentTerminal | null;

  finalAgentMessages: Map<string, string>;
  lastAgentStateMessage: string | null;

  emittedNestedKeys: Set<string>;
  emittedProgressKeys: Set<string>;
  metadataHash: string | null;
}
```

Bound pending activation, buffered notification, and deduplication state.
Terminal runs leave active indexes. Active indexes must return to zero after all
children settle.

## 18. Shared projection invariants

Both adapters must satisfy:

1. one execution produces one runId;
2. runId equals blockId and taskId;
3. a resumed execution creates a new runId;
4. spawnToolCallId is omitted;
5. task is never blank;
6. the initial card is persisted before parent settlement;
7. parent identity is tri-state;
8. native child turn lifecycle never enters root turn lifecycle;
9. child errors never terminate the root;
10. progress is deduplicated;
11. terminal state is monotonic;
12. Background membership means native work remains active/stopping;
13. terminal persistence and Background removal are serialized;
14. child approval/interview routes are drained at terminal;
15. detached writes advance blocksVersion;
16. reconnect finishes before authoritative Background publication.

## 19. Child activity projection

For ordinary child activity:

1. locate the shared run through the active adapter’s native identity map;
2. buffer if exact correlation is not ready;
3. capture provider-private result data;
4. convert the native item using existing Codex conversion;
5. namespace native child block IDs if needed;
6. pass ordinary events through nestChildRuntimeEvent;
7. deduplicate returned events;
8. persist them into the owning assistant message; and
9. broadcast existing blockDelta frames.

Do not project child narration or reasoning. Retain authoritative completed
agent-message text only for the eventual result. Use item/completed rather than
reconstructed deltas as result authority.

## 20. Interview ordering

For interactive child interviews:

```text
persist interview.requested block
→ broadcast blockDelta(interview.requested)
→ broadcast interviewRequested pending frame
```

The runtime event is mandatory because the pending state contains only blockId
and requestedAt. The GUI flushes the earlier block delta before publishing the
pending ID.

Although nestChildRuntimeEvent attaches the owning subagent’s parentBlockId to
a child interview.requested event, interview segments are not members of
SubagentChildSegment and SubagentSegment does not render them as nested child
rows. The interview therefore remains a top-level streaming interview card in
the owning assistant message. The global pending-interview state finds that
card by blockId, so this feature does not require a nested interview renderer.

Snapshot recovery must carry the streaming interview block and pending entry
together.

Never publish a pending interview before its block is durable.

In non-interactive Codex flows, an approval/input-needing action can fail back
to the parent instead of emitting a request. Do not fabricate pending UI; fold
the native failure into child progress/result/outcome.

## 21. Child approvals

Child tool/file approvals use the existing global pending approval state only.
Do not emit child approval.requested or approval.resolved runtime blocks under
the current UI contract: the accumulator and renderer lose parent ownership,
and resolved history would render at root level.

Maintain an exact Host route:

```ts
interface CodexApprovalRoute {
  publicApprovalId: string;
  runId: string;
  childThreadId: string;
  childTurnId: string;
  nativeRequestId: string;
  kind: "tool" | "file-edit";
  state: "pending" | "resolving" | "resolved" | "cancelled";
}
```

Lifecycle:

1. allocate a chat-unique public ID;
2. persist the native child route;
3. publish existing pending approval state;
4. route the GUI decision by public ID;
5. answer the exact native request;
6. remove pending state after native resolution;
7. cancel outstanding requests when the child terminals; and
8. make decision-versus-stop races exactly-once.

## 22. Background rows and individual stop

Publish a Background row only when the exact native child execution is
addressable:

```ts
{
  kind: "subagent",
  taskId: run.runId,
  blockId: run.runId,
  parentTaskId:
    run.parent.kind === "subagent"
      ? run.parent.runId
      : null,
  title: deriveBackgroundTitle(run),
  scheduledFor: null,
}
```

The shared stop path delegates to the selected adapter:

```ts
await codexMultiAgentAdapters[run.codexMultiAgentVersion].stopRun(run, cause);
```

The row remains present and disabled after an accepted stop request until exact
native terminal confirmation or reconciliation.

Repeated stop is idempotent.

## 23. Stop all and session escalation

Ordinary Stop all, when every Background row is individually stoppable, leaves
the root foreground turn running.

When any command row carries individualStopUnavailable:

1. the GUI asks for destructive confirmation;
2. confirmation first stops an active root turn;
3. the root-terminal descendant policy stops every active child;
4. the GUI then sends stopBackgroundSession; and
5. the provider session ends every remaining Background item.

Do not retain the false invariant that Stop all always preserves the root turn.

## 24. Host-private recovery state

Use an explicitly named envelope:

```ts
hostPrivate.data.codexSubagentProjection = {
  schemaVersion: 1,
  rootsByTurnId: {},
  runsById: {},
  approvalRoutesByPublicId: {},
};
```

Persist:

```ts
interface PersistedCodexSubagentRun {
  runId: string;
  codexMultiAgentVersion: "v1" | "v2";

  rootThreadId: string;
  rootTurnId: string;
  owningAssistantMessageId: string;
  parent: ParentResolution;

  native:
    | {
        version: "v1";
        activationItemId: string;
        childThreadId: string | null;
        childTurnId: string | null;
      }
    | {
        version: "v2";
        activityItemId: string;
        agentThreadId: string;
        agentPath: string;
        childTurnId: string | null;
      };

  stopCause: CodexStopCause | null;
  terminal: CodexSubagentTerminal | null;
}
```

hostPrivate is a schema-evolution boundary, not a secrecy boundary. Once a chat
is task-visible, collaborators can fetch it.

Never store:

- credentials;
- tokens;
- prompts;
- results;
- reasoning;
- command arguments;
- approval payloads; or
- source contents.

If required recovery data is not collaborator-safe, store it in owner-only
Host-local durable storage.

hostPrivate.revision is the envelope schema revision, not the per-run event
sequence.

## 25. Detached write contract

Every detached mutation uses accumulateTurnContent with the current persisted
blocksVersion:

```ts
serializeChatWrite(() => {
  const current = loadOwningAssistantMessage(run.owningAssistantMessageId);

  const next = accumulateTurnContent(
    {
      blocks: current.blocks,
      blocksVersion: current.blocksVersion ?? 0,
    },
    event,
  );

  if (next.blocks === current.blocks) return;

  writeAssistantMessage({
    ...current,
    blocks: next.blocks,
    blocksVersion: next.blocksVersion,
    // Preserve outer timestamp and message identity.
  });
});
```

Rules:

- increment only for a real mutation;
- never reset the counter during detached execution;
- preserve the settled row’s outer timestamp;
- persist and broadcast the same resulting version;
- serialize concurrent detached writes; and
- make terminal card mutation, Background removal, and private-run update one
  logical transition.

## 26. Reconnect

Before publishing the first authoritative snapshot after app-server reconnect:

1. increment the connection epoch;
2. buffer current-epoch child notifications;
3. load the persisted chat;
4. load named private recovery state;
5. restore the V1 or V2 adapter for each root/run from persisted version;
6. read root and child native history through that adapter;
7. rebuild identity, parent, approval, and active-run maps;
8. reconcile every persisted streaming card;
9. reconstruct the authoritative Background set;
10. publish it once;
11. replay current-epoch buffered notifications; and
12. discard older-epoch responses.

Reconciliation:

| Native state               | Persisted card | Action                                |
| -------------------------- | -------------- | ------------------------------------- |
| active                     | missing        | recreate start and Background row     |
| active                     | streaming      | restore Background row only           |
| terminal                   | missing        | recreate start and terminal           |
| terminal                   | streaming      | emit missing terminal                 |
| terminal                   | terminal       | no-op                                 |
| missing after exact lookup | streaming      | fail or stop based on persisted cause |

Do not replay historical progress. Do not fail children solely because the
transport disconnected. If exact recovery ultimately fails, terminalize rather
than leaving a permanent spinner.

## 27. Ordered implementation sequence

All work remains on feat/codex-subagents-ui.

### Step 1 — Capture current baseline and version fixtures

- capture currently signed Host output;
- capture V1 app-server sequences;
- capture V2 app-server sequences;
- generate exact schemas;
- record binary hashes and capability fingerprints;
- record root stop, nested spawn, approval, and reconnect sequences.

#### Step 1 exit criteria

Steps 2–4 must not begin until every blocking native claim in Sections 7, 9,
and 10 is represented in a native evidence matrix. Every row must identify:

- the exact Codex version and binary hash;
- the evidence class: generated schema, pinned native source, captured runtime
  fixture, or signed-Host trace;
- the schema/source reference;
- the captured fixture identifier when runtime behavior is claimed;
- the expected normalized signal;
- the signed-Host compatibility consequence; and
- confirmed, contradicted, or unresolved status.

At minimum the matrix must cover:

| Claim                                | Required evidence                                          |
| ------------------------------------ | ---------------------------------------------------------- |
| V1 receiver-late spawn               | generated schema, pinned source, and captured V1 frames    |
| V1 agentsStates and wait behavior    | generated schema and captured V1 wait sequence             |
| V1 resume/new-execution sequence     | captured V1 resume/send-input sequence                     |
| V2 subAgentActivity start            | generated schema, pinned source, and captured V2 frames    |
| V2 immediate item lifecycle pair     | captured V2 frames                                         |
| V2 wait using collabAgentToolCall    | pinned source and captured V2 wait sequence                |
| V2 list_agents lifecycle behavior    | pinned source and captured V2 sequence                     |
| spawned-child thread/started absence | captured V1 and V2 streams                                 |
| V2 direct start/steer rejection      | captured request/response fixtures                         |
| exact child turn/interrupt           | success, already-terminal, stale-turn, and -32600 fixtures |
| runtime detection precedence         | pinned source/config evidence and startup trace            |
| signed-Host current projection       | sanitized signed-Host baseline trace                       |

Static field names and type shapes may be marked schema-confirmed, but emission
timing, ordering, error behavior, and signed-Host integration remain provisional
until their runtime fixtures exist. Step 9 replays and extends the fixtures
captured here; it does not create the blocking evidence for the first time.

### Step 2 — Add runtime detection

- implement CodexMultiAgentDetection;
- latch version per root turn;
- persist version per run;
- validate observed event family against the latched version;
- add mismatch telemetry.

### Step 3 — Implement V1 adapter

- normalize collabAgentToolCall;
- handle receiver-late spawn;
- correlate child thread/turn;
- handle V1 resume/send-input;
- handle agentsStates and wait reconciliation;
- implement exact stop and reconnect.

### Step 4 — Implement V2 adapter

- normalize subAgentActivity;
- handle no child thread/started;
- deduplicate immediate activity start/completion pairs;
- handle interacted same-run versus new-turn;
- accept legacy-shaped wait under V2;
- respect parent-owned direct-input restrictions;
- implement exact stop and -32600 reconciliation.

### Step 5 — Implement shared tracker/projector

- execution-scoped run IDs;
- tri-state parent ownership;
- early card ownership;
- nested ownership inheritance;
- result capture;
- progress deduplication;
- terminal monotonicity;
- Background projection;
- approval/interview routes.

### Step 6 — Correct public containment

- extend child suppression set;
- prevent late terminal/progress mutation;
- route first nested detached events through parent ownership;
- preserve blocksVersion monotonicity.

### Step 7 — Root-terminal cascade

- clean completion keeps children;
- every non-clean root terminal stops descendants;
- order explicit child terminals before root terminal accumulation;
- drain pending requests;
- reconcile native cancellation failures.

### Step 8 — Persistence and reconnect

- add named hostPrivate envelope;
- store V1/V2 native union;
- rebuild selected adapter after restart;
- repair missed starts/terminals;
- rebuild Background state.

### Step 9 — Complete focused tests

- shared conformance suite against V1 and V2;
- replay and extend the Step 1 version-specific native fixtures;
- suppression tests;
- root-terminal tests;
- nested detached routing;
- interview ordering;
- child approval pending-only behavior;
- reconnect and stop races.

### Step 10 — Observability and rollout

- version-dimensioned metrics;
- independent V1/V2 runtime enable controls if needed;
- signed Host smoke;
- canary by detected version;
- kill-switch drain and rollback verification.

## 28. Test strategy

### 28.1 Shared adapter conformance

Run the same behavioral suite against both adapters:

```ts
runCodexSubagentConformanceSuite({
  version: "v1",
  adapter: codexMultiAgentV1Adapter,
});

runCodexSubagentConformanceSuite({
  version: "v2",
  adapter: codexMultiAgentV2Adapter,
});
```

Both must pass:

- one activation produces one card;
- non-empty task fallback;
- late metadata updates one card;
- parallel children never cross-correlate;
- nested parent is correct;
- child activity never leaks to root;
- terminal is monotonic;
- root stop/steer/degraded end stops descendants;
- clean root completion preserves descendants;
- individual stop affects one child;
- approval/interview routing works;
- reconnect restores active children;
- missed terminal is repaired;
- active indexes return to zero.

### 28.2 V1-specific

- spawn start has no receiver;
- spawn completion supplies receiver;
- agentsStates plural;
- ReasoningEffort remains open string;
- V1 resume/send-input;
- V1 wait authority ordering;
- no child thread/started dependency.

### 28.3 V2-specific

- subAgentActivity.started;
- immediate item start/completion pair deduplication;
- no child thread/started dependency;
- interacted same-run/new-turn distinction;
- interrupted as hint;
- collabAgentToolCall wait under V2;
- list_agents produces no lifecycle item;
- direct child start/steer rejection;
- exact child interrupt;
- -32600 reconciliation.

### 28.4 New public tests

Create:

```text
protocol/src/host/agent/gui/__tests__/subagent-nesting.test.ts
```

Add:

- suppression of turn.stopped;
- suppression of turn.interrupted;
- suppression of steer.submitted;
- suppression of compaction.errored;
- normal nested command/tool progress behavior.

Extend chat-subscribe tests with:

- top-level kind: subagent row;
- nested parentTaskId row.

Extend chat-session-store tests with:

- full detached subagent.started/progress/completed sequence;
- first nested start routed through the settled parent;
- no active-turn fallback to unrelated rows.

Extend accumulator tests only for uncovered behavior:

- same-run agentType enrichment;
- terminal/progress monotonicity;
- root terminal followed by late child terminal.

Do not duplicate existing coverage for:

- basic start/progress/completion;
- late name refresh;
- terminal timestamp protection;
- no-spawn-ID refresh;
- omitted-parent preservation;
- explicit-null unnest;
- generic stop action parsing; or
- older stream-line parsing.

Resumed native thread/fresh-card behavior remains in V1/V2 adapter suites.

## 29. Verification commands

Vitest exits 0 and silently skips a path that does not exist, so every focused
run lists its files first and asserts the file count from the first summary
line. The file lists are arrays so they expand the same way under bash and zsh.

Focused protocol tests:

```bash
cd protocol
FILES=(
  src/host/agent/gui/__tests__/subagent-nesting.test.ts
  src/host/agent/gui/__tests__/subagent-parent-resolution.test.ts
  src/host/agent/gui/__tests__/agent-runtime.test.ts
  src/host/agent/gui/__tests__/agent-runtime-accumulator.test.ts
  src/host/agent/gui/__tests__/chat-subscribe.test.ts
)
ls "${FILES[@]}"
bunx vitest run "${FILES[@]}" 2>&1 | tee /tmp/protocol-focused.log
grep -q "Test Files  5 passed (5)" /tmp/protocol-focused.log
```

Focused GUI tests. `scripts/run-tests.ts` forwards the file list to
`vitest run --config vitest.config.ts` and then always runs two fixed
react-compiler suites, so three "Test Files" summaries print; the first one is
the focused run.

```bash
cd clients/gui-app
FILES=(
  src/stores/chats/__tests__/chat-session-store.test.ts
  src/stores/chats/__tests__/rendered-messages.test.tsx
  src/components/chat/__tests__/chat-background-items-panel.test.tsx
  src/components/chat/segments/__tests__/subagent-segment.test.tsx
)
ls "${FILES[@]}"
bun run test -- "${FILES[@]}" 2>&1 | tee /tmp/gui-focused.log
grep -q "Test Files  4 passed (4)" /tmp/gui-focused.log
```

Affected tests:

```bash
make test-affected
```

Normal static validation remains owned by pre-commit and CI under repository
policy.

## 30. Observability

Metrics must include version:

```text
codex_subagent_activation_total{
  codex_multi_agent_version="v1"
}

codex_subagent_activation_total{
  codex_multi_agent_version="v2"
}
```

Track:

```text
codex_subagent_started_total
codex_subagent_terminal_total{version,outcome,source}
codex_subagent_active_runs{version}
codex_subagent_orphan_notifications_total{version,item_type}
codex_subagent_duplicate_notifications_total{version,kind}
codex_subagent_reconciliation_total{version,result}
codex_subagent_stop_total{version,result}
codex_subagent_runtime_mismatch_total{detected_version,item_type}
codex_subagent_unknown_schema_total{codex_version,item_type}
codex_subagent_stale_runs{version}
codex_subagent_background_mismatch_total{version,kind}
```

Do not log prompts, results, reasoning, commands, approval payloads, credentials,
tokens, or source contents.

## 31. Runtime rollout controls

If runtime controls are required, use concrete names:

```ts
codexMultiAgentV1Enabled;
codexMultiAgentV2Enabled;
```

Or snake_case in external configuration:

```text
codex_multi_agent_v1
codex_multi_agent_v2
```

These flags choose whether Traycer’s V1 or V2 adapter is enabled. They do not
create another runtime mode.

Possible rollout:

|  V1 |  V2 | Result                       |
| --: | --: | ---------------------------- |
| off | off | current signed-Host baseline |
|  on | off | V1 adapter enabled           |
| off |  on | V2 adapter enabled           |
|  on |  on | detect and use V1 or V2      |

Latch enablement per execution. Existing runs drain through their selected
adapter when a flag changes.

## 32. Real UI smoke matrix

Run every applicable case against both V1 and V2:

1. one child;
2. two parallel children;
3. nested child;
4. child failure;
5. individual stop;
6. ordinary Stop all;
7. confirmed session-stop escalation;
8. root clean completion before child;
9. root stop before child;
10. root steer restart before child;
11. root degraded completion before child;
12. child approval;
13. child interview;
14. reconnect with active child;
15. missed terminal reconciliation;
16. resumed child thread producing a fresh card;
17. late metadata after terminal;
18. desktop close/reopen.

Verify identical Traycer presentation independent of native runtime.

## 33. Acceptance criteria

The implementation is complete only when:

- V1 and V2 are detected correctly;
- the detected version is latched per root execution;
- descendants inherit the root version;
- the V1 and V2 adapters both pass the shared conformance suite;
- V1 handles receiver-late spawn;
- V2 handles subAgentActivity and its legacy-shaped wait exception;
- neither adapter waits for child thread/started;
- V2 direct-input restrictions are respected;
- exact child stop succeeds or reconciles honestly;
- one native execution produces one card;
- runId equals blockId and taskId;
- blank tasks still render;
- late metadata does not duplicate or reopen cards;
- resumed executions receive fresh cards;
- parallel and nested children correlate correctly;
- child lifecycle never mutates root lifecycle;
- child narration/reasoning never leaks;
- terminal state is monotonic;
- every non-clean root terminal stops descendants;
- clean root completion preserves descendants;
- first nested detached starts route to the original owner message;
- Background removal and terminal persistence are serialized;
- interview blockDelta precedes pending state;
- child approvals remain actionable without root-level history leakage;
- detached writes advance blocksVersion;
- reconnect restores active runs and repairs missed terminals;
- hostPrivate contains no collaborator-sensitive data;
- telemetry distinguishes V1 and V2;
- feature-disabled behavior matches the signed-Host baseline;
- no new wire minor is introduced; and
- protocol compatibility remains green.

## 34. Revised estimate

The estimate is an incremental delta from the current partial Codex adapter,
not a ground-up build.

| Work                                                        |   Estimate |
| ----------------------------------------------------------- | ---------: |
| signed-Host baseline and V1/V2 fixtures                     |  0.5–1 day |
| runtime detection and V1 adapter completion                 | 0.75–1 day |
| V2 adapter and mixed item-family handling                   | 1–1.5 days |
| shared tracker, root cascade, terminal monotonicity         | 1–1.5 days |
| nested detached routing, approvals, interviews, persistence | 0.75–1 day |
| tests, observability, signed smoke                          | 1–1.5 days |

Provisional total: **5–7 engineer-days**. This range is not
implementation-authoritative until the Step 1 native evidence matrix is
complete. Tighten it only after the signed-Host baseline shows how much V1/V2
correlation, stop, and reconnect machinery already exists.
