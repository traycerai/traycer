import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV23,
  parseKnownHostNotificationPayloadForKind,
  type HostNotificationKind,
} from "@traycer/protocol/host/notifications/contracts";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

interface RowState {
  row: MergedNotificationRow | null;
}

const mocks = vi.hoisted(() => {
  const state: RowState = { row: null };
  return { state };
});

vi.mock("@/stores/notifications/merged-notifications", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/stores/notifications/merged-notifications")
    >();
  return {
    ...actual,
    useMergedNotificationRow: () => mocks.state.row,
  };
});
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-reactive-local-host-entry", () => ({
  useReactiveLocalHostEntry: () => null,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useRemoteSessionPollReadiness: () => false,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

import { NotificationRow } from "@/components/notifications/notification-row";
import { rowFromHostEntry } from "@/stores/notifications/merged-notifications";

const NEW_KINDS = [
  "secret.rotated",
  "team.member.removed",
  "team.member.joined",
  "team.policy.unapplied",
  "team.policy.authority_expired",
  "team.installing_admin.gone",
  "team.plan.unlinked",
  "team.pods.full",
] as const satisfies readonly HostNotificationKind[];

type NewKind = (typeof NEW_KINDS)[number];

const TEAM_KINDS = [
  "team.member.removed",
  "team.member.joined",
  "team.policy.unapplied",
  "team.policy.authority_expired",
  "team.installing_admin.gone",
  "team.plan.unlinked",
  "team.pods.full",
] as const satisfies readonly NewKind[];

const ROTATED_PAYLOAD: Record<string, unknown> = {
  kind: "secret_rotated",
  secretName: "DB_PASSWORD",
  secretId: "secret-1",
  environmentId: "env-1",
  rotationId: "rotation-1",
  state: "enforced",
  evidence: [
    {
      producer: "gateway-1",
      workerClass: "postgres",
      hostId: null,
      hostName: null,
      status: "acknowledged",
      evidence: [{ kind: "session_closed", count: 3 }],
    },
  ],
};

const NEW_PAYLOADS: Readonly<Record<NewKind, Record<string, unknown>>> = {
  "secret.rotated": ROTATED_PAYLOAD,
  "team.member.removed": {
    kind: "team_member_removed",
    environmentId: "env-1",
    teamName: "Acme",
    memberName: "Sam",
    hosts: [
      {
        hostId: "host-1",
        hostName: "Build host",
        stopped: "done",
        credentialClosed: "done",
        replacementDelivered: "done",
      },
    ],
  },
  "team.member.joined": {
    kind: "team_member_joined",
    environmentId: "env-1",
    teamName: "Acme",
    memberName: "Sam",
    toNewcomer: false,
  },
  "team.policy.unapplied": {
    kind: "team_policy_unapplied",
    environmentId: "env-1",
    teamName: "Acme",
    policyVersion: 3,
  },
  "team.policy.authority_expired": {
    kind: "team_policy_authority_expired",
    environmentId: "env-1",
    teamName: "Acme",
    hostId: "host-1",
    hostName: "Build host",
  },
  "team.installing_admin.gone": {
    kind: "team_installing_admin_gone",
    environmentId: "env-1",
    teamName: "Acme",
    adminName: "Sam",
    reason: "left",
  },
  "team.plan.unlinked": {
    kind: "team_plan_unlinked",
    environmentId: "env-1",
    teamName: "Acme",
  },
  "team.pods.full": {
    kind: "team_pods_full",
    environmentId: "env-1",
    teamName: "Acme",
    podCount: 4,
  },
};

/** A schema-valid entry of one new kind, on the arm's own outcome. */
function entryFor(
  kind: NewKind,
  severity: string,
  outcome: string,
  payload: Record<string, unknown>,
) {
  return hostNotificationEntrySchemaV23.parse({
    id: `entry-${kind}`,
    updatedAt: 1_700_000_000_000,
    readAt: null,
    sourceRef: "source-1",
    epicId: null,
    chatId: null,
    kind,
    severity,
    outcome,
    payload,
  });
}

/** The severity the host files each new kind under. */
function hostSeverity(kind: NewKind): string {
  return kind === "secret.rotated" ? "done" : "info";
}

function defaultEntry(kind: NewKind) {
  return entryFor(kind, hostSeverity(kind), "completed", NEW_PAYLOADS[kind]);
}

function failedRotationEntry() {
  return entryFor("secret.rotated", "failure", "errored", {
    ...ROTATED_PAYLOAD,
    state: "failed",
    evidence: [],
  });
}

type RowCallback = (row: MergedNotificationRow) => void;

interface RenderedRow {
  readonly entry: HTMLElement;
  readonly onActivate: Mock<RowCallback>;
  readonly onAcknowledge: Mock<RowCallback>;
}

function renderRow(row: MergedNotificationRow): RenderedRow {
  mocks.state.row = row;
  const onActivate = vi.fn<RowCallback>();
  const onAcknowledge = vi.fn<RowCallback>();
  render(
    <ul>
      <NotificationRow
        feedId={row.feedId}
        highlightRelocation={false}
        onActivate={onActivate}
        onAcknowledge={onAcknowledge}
      />
    </ul>,
  );
  return {
    entry: screen.getByTestId("notification-entry"),
    onActivate,
    onAcknowledge,
  };
}

/** The class of the glyph the row drew: the svg inside its aria-hidden tile. */
function glyphClass(entry: HTMLElement): string {
  const glyph = entry.querySelector("span[aria-hidden] > svg");
  if (!(glyph instanceof SVGElement)) {
    throw new Error("the row drew no glyph");
  }
  return glyph.getAttribute("class") ?? "";
}

function textOf(entry: HTMLElement, testId: string): string {
  const element = entry.querySelector(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`${testId} is not in the row`);
  return element.textContent;
}

function hasNavigableBody(entry: HTMLElement): boolean {
  return (
    entry.querySelector("button:has([data-testid=notification-title])") !== null
  );
}

beforeEach(() => {
  mocks.state.row = null;
});
afterEach(cleanup);

describe("<NotificationRow /> secret.rotated and team rows: copy", () => {
  it.each(NEW_KINDS)(
    "%s shows the host-composed title and body verbatim",
    (kind) => {
      const entry = defaultEntry(kind);
      const presentation = formatHostNotificationPresentation(entry);
      expect(presentation.title).not.toBe("");
      expect(presentation.body).not.toBe("");

      const { entry: rendered } = renderRow(rowFromHostEntry(entry));

      expect(textOf(rendered, "notification-title")).toBe(presentation.title);
      expect(textOf(rendered, "notification-body")).toBe(presentation.body);
    },
  );

  it("shows the copy of a rotation that failed, not the enforced copy", () => {
    const failed = failedRotationEntry();
    const enforcedBody = formatHostNotificationPresentation(
      defaultEntry("secret.rotated"),
    ).body;
    const failedBody = formatHostNotificationPresentation(failed).body;
    expect(failedBody).not.toBe(enforcedBody);

    const { entry } = renderRow(rowFromHostEntry(failed));

    expect(textOf(entry, "notification-body")).toBe(failedBody);
  });
});

describe("<NotificationRow /> secret.rotated and team rows: glyph", () => {
  it.each(TEAM_KINDS)(
    "%s draws the team glyph, not the unknown-row bell",
    (kind) => {
      const { entry } = renderRow(rowFromHostEntry(defaultEntry(kind)));

      const drawn = glyphClass(entry);
      expect(drawn).toContain("lucide-users");
      expect(drawn).not.toContain("lucide-bell");
      expect(drawn).toContain("text-muted-foreground");
    },
  );

  it("draws a finished rotation with the success tone and a failed one with the failure tone", () => {
    const done = renderRow(rowFromHostEntry(defaultEntry("secret.rotated")));
    const doneClass = glyphClass(done.entry);
    expect(doneClass).toContain("lucide-message-square-check");
    expect(doneClass).toContain("text-success-foreground");
    cleanup();

    const failed = renderRow(rowFromHostEntry(failedRotationEntry()));
    const failedClass = glyphClass(failed.entry);
    expect(failedClass).toContain("lucide-message-square-x");
    expect(failedClass).toContain("text-destructive");
    expect(failedClass).not.toBe(doneClass);
  });

  it("falls back to the key glyph for a rotation whose severity names no tone", () => {
    const { entry } = renderRow(
      rowFromHostEntry(
        entryFor("secret.rotated", "info", "completed", ROTATED_PAYLOAD),
      ),
    );

    const drawn = glyphClass(entry);
    expect(drawn).toContain("lucide-key-round");
    expect(drawn).not.toContain("lucide-bell");
  });

  it("gives a team row a glyph a rotation row does not share", () => {
    const rotated = renderRow(rowFromHostEntry(defaultEntry("secret.rotated")));
    const rotatedClass = glyphClass(rotated.entry);
    cleanup();
    const team = renderRow(rowFromHostEntry(defaultEntry("team.pods.full")));

    expect(glyphClass(team.entry)).not.toBe(rotatedClass);
  });
});

describe("<NotificationRow /> secret.rotated and team rows: activation", () => {
  it.each(NEW_KINDS)(
    "%s is complete on itself: no navigation target, no body button, acknowledge only",
    (kind) => {
      const row = rowFromHostEntry(defaultEntry(kind));
      // The row names secrets, hosts and people, never a chat to open.
      expect(row.payload).toBeNull();

      const { entry, onActivate, onAcknowledge } = renderRow(row);

      expect(hasNavigableBody(entry)).toBe(false);
      expect(screen.queryByTestId("notification-mark-read")).toBeNull();

      fireEvent.click(screen.getByTestId("notification-title"));
      fireEvent.keyDown(entry, { key: "Enter" });
      fireEvent.keyDown(entry, { key: " " });
      expect(onActivate).not.toHaveBeenCalled();

      const acknowledge = screen.getByTestId("notification-acknowledge");
      expect(acknowledge.getAttribute("aria-label")).toBe("Acknowledge");
      fireEvent.click(acknowledge);
      expect(onAcknowledge).toHaveBeenCalledTimes(1);
      expect(onAcknowledge).toHaveBeenCalledWith(row);
      expect(onActivate).not.toHaveBeenCalled();
    },
  );

  it("is not the shape of a row that does navigate: a chat row activates with its row", () => {
    const row = rowFromHostEntry(
      hostNotificationEntrySchemaV23.parse({
        id: "agent.stopped:chat-1",
        updatedAt: 10,
        readAt: null,
        kind: "agent.stopped",
        sourceRef: "chat-1",
        severity: "done",
        outcome: "completed",
        epicId: "epic-1",
        chatId: "chat-1",
        payload: {
          kind: "chat",
          epicId: "epic-1",
          chatId: "chat-1",
          agentName: "Agent",
          taskTitle: "Task",
          outcome: "completed",
        },
      }),
    );
    expect(row.payload).toMatchObject({
      kind: "chat",
      epicId: "epic-1",
      chatId: "chat-1",
    });

    const { entry, onActivate } = renderRow(row);

    expect(hasNavigableBody(entry)).toBe(true);
    fireEvent.click(screen.getByTestId("notification-title"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(row);
  });
});

describe("<NotificationRow /> secret.rotated and team rows: no account identifiers", () => {
  const DISPLAY_NAME = "Pat Example";
  const USER_ID = "user_01HZX9K3Q7ACCOUNT4821";
  const EMAIL = "pat.example@acme-corp.test";

  function withDisplayName(kind: NewKind): Record<string, unknown> {
    const payload = NEW_PAYLOADS[kind];
    if (kind === "team.member.removed" || kind === "team.member.joined") {
      return { ...payload, memberName: DISPLAY_NAME };
    }
    if (kind === "team.installing_admin.gone") {
      return { ...payload, adminName: DISPLAY_NAME };
    }
    return payload;
  }

  it.each(NEW_KINDS)(
    "%s renders a payload's extra id and e-mail keys nowhere in the row",
    (kind) => {
      const clean = withDisplayName(kind);
      const noisy = {
        ...clean,
        userId: USER_ID,
        accountId: USER_ID,
        actorEmail: EMAIL,
      };
      // The extras must not push the payload off its schema: a payload the
      // build could not read would render generic copy and pass for the wrong
      // reason.
      expect(
        parseKnownHostNotificationPayloadForKind(kind, noisy),
      ).not.toBeNull();
      const expected = formatHostNotificationPresentation(
        entryFor(kind, hostSeverity(kind), "completed", clean),
      );

      const { entry } = renderRow(
        rowFromHostEntry(
          entryFor(kind, hostSeverity(kind), "completed", noisy),
        ),
      );

      expect(textOf(entry, "notification-title")).toBe(expected.title);
      expect(textOf(entry, "notification-body")).toBe(expected.body);
      if (clean !== NEW_PAYLOADS[kind]) {
        expect(entry.textContent).toContain(DISPLAY_NAME);
      }
      // The whole markup, so text, aria-label, title and data attributes are
      // all covered at once.
      expect(entry.outerHTML).not.toContain(USER_ID);
      expect(entry.outerHTML).not.toContain(EMAIL);
      expect(entry.textContent).not.toContain(USER_ID);
      expect(entry.textContent).not.toContain(EMAIL);
    },
  );
});
