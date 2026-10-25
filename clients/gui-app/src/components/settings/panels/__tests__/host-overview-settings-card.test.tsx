import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  EnvironmentReviewResponseV11,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentMoveStopPreviewResponse,
  EnvironmentMoveStopRequest,
} from "@traycer/protocol/host/environment/move-contracts";
import { hostSettingsCardState } from "@/components/settings/panels/host-overview-settings-card-model";
import { HostOverviewSettingsCard } from "@/components/settings/panels/host-overview-settings-card";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
  pendingUploadFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

const ACCEPTED_AT = Date.UTC(2026, 9, 20, 12);
const STOPPED_AT = Date.UTC(2026, 9, 21, 12);

/**
 * The card over a fake host that negotiated the redesign's methods, so the
 * dated lines, Stop sharing and the retrospective run their real reads.
 */
function renderCard(
  status: EnvironmentStatusResponseV11,
  handlers: MockHandlerMap<HostRpcRegistry>,
): void {
  const { client } = buildEnvironmentClient({ hostId: "old", handlers });
  recordNegotiatedHostManifest("old", {
    "environment.status": { major: 1, minor: 1 },
    "environment.review": { major: 1, minor: 1 },
    "environment.review.record": { major: 1, minor: 0 },
    "environment.move.stopPreview": { major: 1, minor: 0 },
    "environment.move.stop": { major: 1, minor: 0 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <HostOverviewSettingsCard
        client={client}
        hostId="old"
        hostName="Old laptop"
        status={status}
      />
    </QueryClientProvider>,
  );
}

function reviewFixture(shownAt: number | null): EnvironmentReviewResponseV11 {
  return {
    entries: [],
    shownAt,
    acknowledgedAt: null,
    evidence: { version: null, at: null },
  };
}

/** A promise and the function that settles it, for an answer held back. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const MOVE_LINES = [
  "host-settings-card-local",
  "host-settings-card-progress",
  "host-settings-card-moved",
];

function shownLines(): string[] {
  return MOVE_LINES.filter((id) => screen.queryByTestId(id) !== null);
}

beforeEach(() => {
  useMoveSheetStore.setState({ target: null });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

describe("<HostOverviewSettingsCard />", () => {
  it("says the settings are on this computer only while awaiting, and Move to Personal opens the sheet", () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        setup: { stage: "moving_settings", state: "awaiting_consent" },
      }),
      {},
    );

    expect(shownLines()).toEqual(["host-settings-card-local"]);
    expect(screen.getByTestId("host-settings-card-local").textContent).toBe(
      "Settings on this computer only.",
    );
    fireEvent.click(screen.getByTestId("host-settings-card-move"));
    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("shows N of M items applied while moving", () => {
    renderCard(
      environmentStatusFixture({
        consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
        setup: { stage: "moving_settings", state: "running" },
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "applied" }),
          itemStatusFixture({ kind: "variable", key: "C", status: "pending" }),
        ],
        pendingUploads: [pendingUploadFixture({ kind: "variable", key: "D" })],
      }),
      {},
    );

    expect(shownLines()).toEqual(["host-settings-card-progress"]);
    expect(
      screen
        .getByTestId("host-settings-card-progress")
        .textContent.replace(/\s+/g, " "),
    ).toBe(
      "Moving this computer's settings to Personal · 2 of 4 items applied",
    );
    expect(screen.queryByTestId("host-settings-card-move")).toBeNull();
  });

  it("leaves a configuration's sandbox defaults out of the items moving", () => {
    expect(
      hostSettingsCardState(
        environmentStatusFixture({
          consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
          setup: { stage: "moving_settings", state: "running" },
          items: [
            itemStatusFixture({
              kind: "variable",
              key: "A",
              status: "applied",
            }),
            itemStatusFixture({
              kind: "sandbox_defaults",
              key: "sandbox",
              status: "pending",
            }),
          ],
        }),
      ),
    ).toEqual({ kind: "moving", applied: 1, total: 1 });
  });

  it("says when it moved, from the consent, once setup is past the move", () => {
    renderCard(
      environmentStatusFixture({
        consent: { acceptedAt: ACCEPTED_AT, planHash: "h" },
        setup: { stage: "done", state: "done" },
      }),
      {},
    );

    expect(shownLines()).toEqual(["host-settings-card-moved"]);
    expect(screen.getByTestId("host-settings-card-moved").textContent).toBe(
      `Moved to Personal on ${new Date(ACCEPTED_AT).toLocaleDateString(
        undefined,
        {
          day: "numeric",
          month: "short",
        },
      )}`,
    );
  });

  it("shows none of these lines with no consent on record", () => {
    renderCard(environmentStatusFixture({ setup: null }), {});
    expect(shownLines()).toEqual([]);
    cleanup();
    renderCard(
      environmentStatusFixture({ setup: { stage: "done", state: "done" } }),
      {},
    );
    expect(shownLines()).toEqual([]);
  });
});

describe("<HostOverviewSettingsCard /> after Stop sharing", () => {
  it("counts the removals a stop still owes, and names each failed one with its failure", () => {
    renderCard(
      environmentStatusFixture({
        principal: null,
        reachability: "offline",
        planes: { records: "stopped", broker: "stopped", room: "stopped" },
        stoppedAt: STOPPED_AT,
        items: [
          itemStatusFixture({ kind: "variable", key: "A", status: "pending" }),
          itemStatusFixture({ kind: "variable", key: "B", status: "pending" }),
          itemStatusFixture({
            kind: "variable",
            key: "LOG_LEVEL",
            status: "failed",
            code: "permission_denied",
          }),
        ],
      }),
      {},
    );

    expect(
      screen.getByTestId("overview-stop-cleanup-pending").textContent,
    ).toBe("2 items still being removed from this computer.");
    expect(
      screen
        .getAllByTestId("overview-stop-cleanup-failed")
        .map((line) => line.textContent),
    ).toEqual(["LOG_LEVEL couldn't be removed: permission denied."]);
  });

  it("refetches a changed preview on choices_missing, names the row that now needs a choice, and sends again only once it has one", async () => {
    const logLevel = {
      row: {
        kind: "variable",
        key: "LOG_LEVEL",
        os: "any" as const,
        label: "LOG_LEVEL",
        detail: null,
      },
      reason: "edited_here" as const,
    };
    const editor = {
      row: {
        kind: "variable",
        key: "EDITOR",
        os: "any" as const,
        label: "EDITOR",
        detail: null,
      },
      reason: "depended_on" as const,
    };
    const previews: EnvironmentMoveStopPreviewResponse[] = [
      { managed: [], needsChoice: [logLevel] },
      { managed: [], needsChoice: [logLevel, editor] },
    ];
    let previewReads = 0;
    const sent: EnvironmentMoveStopRequest[] = [];
    renderCard(environmentStatusFixture({}), {
      "environment.status": () => environmentStatusFixture({}),
      "environment.move.stopPreview": () => {
        const preview = previews[Math.min(previewReads, previews.length - 1)];
        previewReads += 1;
        return preview;
      },
      "environment.move.stop": (request) => {
        sent.push(request);
        return sent.length === 1
          ? { outcome: "choices_missing" }
          : { outcome: "stopped" };
      },
    });

    fireEvent.click(screen.getByTestId("overview-stop-sharing"));
    fireEvent.click(
      await screen.findByTestId(
        "stop-sharing-choice-variable-LOG_LEVEL-keep_locally",
      ),
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    const changed = await screen.findByTestId("stop-sharing-preview-changed");
    expect(changed.textContent).toContain("EDITOR");
    const confirm = screen.getByTestId("stop-sharing-confirm");
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);

    fireEvent.click(
      screen.getByTestId(
        "stop-sharing-choice-variable-EDITOR-remove_from_this_computer",
      ),
    );
    fireEvent.click(screen.getByTestId("stop-sharing-confirm"));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({
      choices: [
        { kind: "variable", key: "LOG_LEVEL", choice: "keep_locally" },
        {
          kind: "variable",
          key: "EDITOR",
          choice: "remove_from_this_computer",
        },
      ],
    });
  });
});

describe("<HostOverviewSettingsCard /> retrospective", () => {
  const SHARED_EARLIER = environmentStatusFixture({
    planes: { records: "shared_unrecorded", broker: "local", room: "local" },
  });

  it("stays closed while the review is loading, then opens and records shown once the review says it was never shown", async () => {
    const review = deferred<EnvironmentReviewResponseV11>();
    const recorded: string[] = [];
    let reviewReads = 0;
    renderCard(SHARED_EARLIER, {
      "environment.status": () => SHARED_EARLIER,
      "environment.review": () => {
        reviewReads += 1;
        return review.promise;
      },
      "environment.review.record": (request) => {
        recorded.push(request.event);
        return { outcome: "recorded" };
      },
    });

    await waitFor(() => expect(reviewReads).toBe(1));
    expect(screen.queryByTestId("retrospective-sheet")).toBeNull();
    expect(recorded).toEqual([]);

    await act(async () => {
      review.resolve(reviewFixture(null));
      await review.promise;
    });

    await screen.findByTestId("retrospective-sheet");
    await waitFor(() => expect(recorded).toEqual(["shown"]));
  });

  it("does not open once the review says it was already shown", async () => {
    let answered = 0;
    const recorded: string[] = [];
    renderCard(SHARED_EARLIER, {
      "environment.status": () => SHARED_EARLIER,
      "environment.review": () => {
        answered += 1;
        return reviewFixture(STOPPED_AT);
      },
      "environment.review.record": (request) => {
        recorded.push(request.event);
        return { outcome: "recorded" };
      },
    });

    await waitFor(() => expect(answered).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("retrospective-sheet")).toBeNull();
    expect(recorded).toEqual([]);
  });
});

describe("hostSettingsCardState", () => {
  it("reads moved off status.consent when setup has not started or has left the move", () => {
    const consent = { acceptedAt: ACCEPTED_AT, planHash: "h" };
    expect(
      hostSettingsCardState(environmentStatusFixture({ consent, setup: null })),
    ).toEqual({ kind: "moved", acceptedAt: ACCEPTED_AT });
    expect(hostSettingsCardState(environmentStatusFixture({}))).toEqual({
      kind: "other",
    });
  });
});
