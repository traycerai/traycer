import type {
  SandboxSetupPanel,
  SandboxSetupSubscribeServerFrame,
  SandboxSetupTaskCard,
  SandboxSetupToolSwitch,
  SandboxSetupStartRequest,
  SandboxSetupStartResponse,
  SandboxSetupVersionActionRequest,
} from "../../sandbox-setup";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";

/** Catalog slice copied from Desktop 1.5.4 at the immutable release commit. */
export const desktop154SandboxSetupCatalog = {
  release: "desktop-v1.5.4",
  commit: "b7a5f5ca2dae93bdb127482822651815e9136e87",
  unary: { "terminal.list": { major: 1, minor: 0 } },
  stream: { "chat.subscribe": { major: 1, minor: 41 } },
} as const satisfies {
  readonly release: string;
  readonly commit: string;
  readonly unary: ConnectionManifest;
  readonly stream: ConnectionManifest;
};

export const sandboxSetupChat = { epicId: "epic-1", chatId: "setup-chat-1" };
export const sandboxSetupRepository = { owner: "traycerai", repo: "traycer" };
export const sandboxSetupVersionId = "11111111-1111-4111-8111-111111111111";
export const sandboxSetupBaseVersionId = "22222222-2222-4222-8222-222222222222";
export const sandboxSetupId = "33333333-3333-4333-8333-333333333333";
export const sandboxSetupOperationIds = {
  offer: "44444444-4444-4444-8444-444444444444",
  settings: "55555555-5555-4555-8555-555555555555",
  fix: "66666666-6666-4666-8666-666666666666",
  update: "77777777-7777-4777-8777-777777777777",
  continue: "88888888-8888-4888-8888-888888888888",
  handoverTraycer: "99999999-9999-4999-8999-999999999999",
  handoverWebsite: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  handoverDocs: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
export const sandboxSetupPickerSettings = {
  harnessId: "claude",
  model: "claude-opus",
  permissionMode: "supervised",
  reasoningEffort: "high",
  serviceTier: "fast",
  agentMode: "regular",
  profileId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  profileBinding: {
    kind: "key",
    key: {
      providerId: "claude",
      accountId: "claude-account-1",
      organizationId: null,
    },
  },
  ultracode: true,
} satisfies NonNullable<SandboxSetupStartRequest["agent"]>;

const ordinaryQuestion = {
  blockId: "question-ordinary",
  question: {
    questionId: "question-1",
    question: "Which package should be installed?",
    header: "Package",
    options: [
      { label: "stable", description: null, preview: null },
      { label: "Other", description: "Enter a package", preview: null },
    ],
    multiSelect: false,
    allowsCustomAnswer: true,
  },
  action: { kind: "answer" as const },
};

export const sandboxSetupQuestions = {
  ordinary: ordinaryQuestion,
  secret: {
    ...ordinaryQuestion,
    blockId: "question-secret",
    action: { kind: "secret" as const, name: "NPM_TOKEN" },
  },
  toolVersion: {
    ...ordinaryQuestion,
    blockId: "question-tool-version",
    action: { kind: "tool-version" as const, tool: "node" },
  },
};

export const sandboxSetupRunningCard = {
  kind: "running",
  repository: sandboxSetupRepository,
  setupChat: sandboxSetupChat,
  progress: {
    phase: "install",
    tool: { tool: "node", version: "22.0.0" },
    question: sandboxSetupQuestions.ordinary,
  },
} satisfies SandboxSetupTaskCard;

export const sandboxSetupTaskCards: Record<string, SandboxSetupTaskCard> = {
  offer: { kind: "offer", repository: sandboxSetupRepository },
  running: sandboxSetupRunningCard,
  ready: {
    kind: "ready",
    repository: sandboxSetupRepository,
    setupChat: sandboxSetupChat,
    versionId: sandboxSetupVersionId,
  },
  waiting: {
    kind: "waiting",
    repository: sandboxSetupRepository,
    setupChat: sandboxSetupChat,
    versionId: sandboxSetupVersionId,
  },
  outOfDate: {
    kind: "out-of-date",
    repository: sandboxSetupRepository,
    setupChat: sandboxSetupChat,
    versionId: sandboxSetupVersionId,
  },
  approved: {
    kind: "approved",
    repository: sandboxSetupRepository,
    setupChat: sandboxSetupChat,
    versionId: sandboxSetupVersionId,
  },
};

export const sandboxSetupToolSwitch: SandboxSetupToolSwitch = {
  switchId: "switch-1",
  createdAt: 1_700_000_000_000,
  changes: [{ tool: "node", previous: "20.0.0", current: "22.0.0" }],
};

export const sandboxSetupTaskFrames = {
  offerWithoutSetupChat: {
    kind: "task",
    hasBinaryPayload: false,
    state: {
      setupChat: null,
      cards: [sandboxSetupTaskCards.offer],
      toolSwitches: [],
    },
  },
  offerWithSetupChat: {
    kind: "task",
    hasBinaryPayload: false,
    state: {
      setupChat: sandboxSetupChat,
      cards: [sandboxSetupTaskCards.offer],
      toolSwitches: [],
    },
  },
  runningWithQuestion: {
    kind: "task",
    hasBinaryPayload: false,
    state: {
      setupChat: sandboxSetupChat,
      cards: [sandboxSetupRunningCard],
      toolSwitches: [sandboxSetupToolSwitch],
    },
  },
  unavailable: {
    kind: "task",
    hasBinaryPayload: false,
    state: null,
  },
} satisfies Record<string, SandboxSetupSubscribeServerFrame>;

export const sandboxSetupReviewViews = {
  authorWaitingApproval: {
    kind: "task",
    hasBinaryPayload: false,
    state: {
      setupChat: sandboxSetupChat,
      cards: [sandboxSetupTaskCards.waiting],
      toolSwitches: [],
    },
  } satisfies SandboxSetupSubscribeServerFrame,
  editorReviewInput: {
    kind: "task",
    hasBinaryPayload: false,
    state: {
      setupChat: null,
      cards: [
        {
          kind: "review",
          repository: sandboxSetupRepository,
          versionId: sandboxSetupVersionId,
          authorId: "author-only-user-id",
          authorChatId: "author-only-chat-id",
          chatId: sandboxSetupChat.chatId,
          setupChat: sandboxSetupChat,
        },
      ],
      toolSwitches: [],
    },
  },
  editorReview: {
    kind: "task",
    hasBinaryPayload: false,
    state: {
      setupChat: null,
      cards: [
        {
          kind: "review",
          repository: sandboxSetupRepository,
          versionId: sandboxSetupVersionId,
        },
      ],
      toolSwitches: [],
    },
  } satisfies SandboxSetupSubscribeServerFrame,
};

export const sandboxSetupOutOfDateVersionFrames = [
  sandboxSetupTaskCards.ready,
  sandboxSetupTaskCards.waiting,
  sandboxSetupTaskCards.outOfDate,
].map((card) => ({
  kind: "task" as const,
  hasBinaryPayload: false as const,
  state: {
    setupChat: sandboxSetupChat,
    cards: [card],
    toolSwitches: [],
  },
})) satisfies SandboxSetupSubscribeServerFrame[];

export const sandboxSetupPanel: SandboxSetupPanel = {
  card: sandboxSetupRunningCard,
  tools: [
    {
      tool: "node",
      version: "22.0.0",
      source: { kind: "repository", repository: sandboxSetupRepository, file: ".nvmrc" },
    },
  ],
  repositoryVersions: [{ tool: "node", version: "22.0.0", repository: sandboxSetupRepository }],
  repositoryScript: "npm ci && npm test",
  secrets: [{ name: "NPM_TOKEN", set: false }, { name: "DEPLOY_TOKEN", set: true }],
  checks: [
    { command: "npm ci", result: "running" },
    { command: "npm test", result: "passed" },
    { command: "npm run lint", result: "failed" },
    { command: "npm run build", result: "skipped" },
  ],
  workingFile: "/work/traycer/.sandbox/setup.sh",
};

export const sandboxSetupHiddenPanel: SandboxSetupPanel = {
  ...sandboxSetupPanel,
  card: null,
};

const settingsStartRequest = (
  repo: string,
  operationId: string,
): SandboxSetupStartRequest => ({
  epicId: "epic-1",
  repository: { owner: "traycerai", repo },
  setupId: sandboxSetupId,
  operationId,
  turnOnCount: 3,
  agent: sandboxSetupPickerSettings,
  source: { kind: "settings" },
});

export const sandboxSetupContinuePersonRead = {
  versionId: sandboxSetupVersionId,
  baseVersionId: sandboxSetupBaseVersionId,
  script: "#!/bin/sh\nnode --version\n",
};

export const sandboxSetupStartRequests: Record<string, SandboxSetupStartRequest> = {
  offer: {
    ...settingsStartRequest("traycer", sandboxSetupOperationIds.offer),
    source: { kind: "offer" },
  },
  settings: settingsStartRequest("traycer", sandboxSetupOperationIds.settings),
  fix: {
    ...settingsStartRequest("traycer", sandboxSetupOperationIds.fix),
    source: {
      kind: "fix",
      versionId: sandboxSetupVersionId,
      script: "#!/bin/sh\nexit 1\n",
      buildLog: "check failed",
    },
  },
  update: {
    ...settingsStartRequest("traycer", sandboxSetupOperationIds.update),
    source: { kind: "update", versionId: sandboxSetupVersionId },
  },
  continue: {
    ...settingsStartRequest("traycer", sandboxSetupOperationIds.continue),
    source: { kind: "continue", ...sandboxSetupContinuePersonRead },
  },
};

export const sandboxSetupSettingsHandover = {
  setupId: sandboxSetupId,
  requests: [
    settingsStartRequest("traycer", sandboxSetupOperationIds.handoverTraycer),
    settingsStartRequest("website", sandboxSetupOperationIds.handoverWebsite),
    settingsStartRequest("docs", sandboxSetupOperationIds.handoverDocs),
  ],
};

export const sandboxSetupStartResults: Record<string, SandboxSetupStartResponse> = {
  accepted: { kind: "accepted", setupChat: sandboxSetupChat },
  setupDisabled: { kind: "refused", code: "setup_disabled" },
  staleTurnOnCount: { kind: "refused", code: "setup_stale_turn_on_count" },
  sandboxUnavailable: { kind: "refused", code: "setup_sandbox_unavailable" },
  unavailable: { kind: "refused", code: "setup_unavailable" },
  waiting: { kind: "refused", code: "setup_waiting" },
  alreadyRunning: { kind: "refused", code: "setup_already_running" },
  scriptTooLarge: { kind: "refused", code: "setup_script_too_large" },
};

export const sandboxSetupContinueOffer = {
  frame: sandboxSetupTaskFrames.offerWithoutSetupChat,
  personRead: sandboxSetupContinuePersonRead,
  hostAction: sandboxSetupStartRequests.continue,
};

export const sandboxSetupOtherPersonBusyOffer = {
  frame: sandboxSetupTaskFrames.offerWithoutSetupChat,
  hostAction: sandboxSetupStartRequests.offer,
  hostResult: sandboxSetupStartResults.alreadyRunning,
};

export const sandboxSetupVersionActions: Record<string, SandboxSetupVersionActionRequest> = {
  approved: {
    ...sandboxSetupChat,
    versionId: sandboxSetupVersionId,
    outcome: { kind: "approved" },
  },
  sent: {
    ...sandboxSetupChat,
    versionId: sandboxSetupVersionId,
    outcome: { kind: "sent" },
  },
  discarded: {
    ...sandboxSetupChat,
    versionId: sandboxSetupVersionId,
    outcome: { kind: "discarded" },
  },
  waitingRefusal: {
    ...sandboxSetupChat,
    versionId: sandboxSetupVersionId,
    outcome: { kind: "refused", code: "setup_waiting" },
  },
  outOfDateRefusal: {
    ...sandboxSetupChat,
    versionId: sandboxSetupVersionId,
    outcome: { kind: "refused", code: "setup_out_of_date" },
  },
};
