import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { LocalRowNote } from "@/components/settings/environment/local-row-note";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

/*
 * The move's own progress, through the surface a person is looking at: the
 * Local row's note reads `environment.status`, and that read is the ONLY
 * source of the move's `<n> of <m> items applied`. A move of a handful of
 * items takes a couple of seconds, so a read that only ticks every five
 * leaves the pre-move note standing through the whole move and the progress
 * line standing after it ended.
 */

const HOST_ID = "old";
const ACCEPTED_AT = Date.UTC(2026, 9, 20, 12);
/**
 * The span a progress claim is given: longer than a move's own first reads
 * (500 ms, then 1 s), shorter than the cadence every other status read keeps.
 * A claim inside it is a claim about the move's pace, not the steady one.
 */
const WITHIN_THE_MOVE_MS = 4_000;
/**
 * The span a "nothing was re-read" claim is held open for. Well short of the
 * steady 5 s, so a slow machine has to fall more than two seconds behind
 * before a legitimate steady read could land inside it and read as the move
 * lane's work.
 */
const BEFORE_THE_STEADY_READ_MS = 2_500;

const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => clientMock.current,
}));

// Details opens the configuration drawer, which has its own suite.
vi.mock("@/components/settings/details/overview-card-details-line", () => ({
  OverviewCardDetailsLine: () => <button type="button">Details</button>,
}));

/** Not moved and waiting for the person's word: the pre-move note. */
const AWAITING_CONSENT: EnvironmentStatusResponseV11 = environmentStatusFixture(
  {
    principal: null,
    planes: { records: "local", broker: "local", room: "local" },
    consent: null,
    setup: { stage: "moving_settings", state: "awaiting_consent" },
  },
);

/**
 * Accepted, uploading: `applied` of three items are in Personal.
 *
 * `consent` is `null` throughout, which is what a first move really reports:
 * the status serves the migration MARKER's consent, and the host writes that
 * marker only once the upload has finished
 * (`traycer-host/src/domain/environment/migration/migrator.ts`, step 5). A
 * fixture that sets it here would let a cadence keyed on the consent pass a
 * test the real feed fails.
 */
function moving(applied: number): EnvironmentStatusResponseV11 {
  const keys = ["ANTHROPIC_AUTH_TOKEN", "DEPLOY_KEY", "github"];
  return environmentStatusFixture({
    principal: { kind: "personal" },
    planes: { records: "local", broker: "local", room: "local" },
    consent: null,
    setup: { stage: "moving_settings", state: "running" },
    items: keys.map((key, index) =>
      itemStatusFixture({
        kind: "env_var",
        key,
        status: index < applied ? "applied" : "pending",
      }),
    ),
  });
}

/** The move finished: this computer runs Personal. */
const MOVED: EnvironmentStatusResponseV11 = environmentStatusFixture({
  principal: { kind: "personal" },
  consent: { acceptedAt: ACCEPTED_AT, planHash: "plan-1" },
  setup: { stage: "done", state: "done" },
});

function renderNote(answer: () => EnvironmentStatusResponseV11): {
  readonly queryClient: QueryClient;
  readonly reads: () => number;
} {
  let reads = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "environment.status": () => {
        reads += 1;
        return answer();
      },
    },
  });
  clientMock.current = client;
  recordNegotiatedHostManifest(HOST_ID, {
    "environment.status": { major: 1, minor: 1 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LocalRowNote />
    </QueryClientProvider>,
  );
  return { queryClient, reads: () => reads };
}

/** What the accept does: one read of the status it just changed. */
async function acceptTheMove(queryClient: QueryClient): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "environment.status"),
    });
  });
}

/** Holds the assertion's span open without asking the host anything. */
async function holdFor(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  useMoveSheetStore.setState({ target: null });
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: HOST_ID, hostName: "Old laptop" },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("the status read while this computer's move runs", () => {
  it("counts the items up and clears the note when the move ends, within the move's own span", async () => {
    let answer: EnvironmentStatusResponseV11 = AWAITING_CONSENT;
    const { queryClient } = renderNote(() => answer);
    await waitFor(() =>
      expect(screen.getByTestId("local-row-note").textContent).toContain(
        "not in Personal yet",
      ),
    );

    // The person presses Move to Personal: the host starts the upload.
    answer = moving(1);
    await acceptTheMove(queryClient);
    await waitFor(() =>
      expect(
        screen.getByTestId("host-settings-card-progress").textContent,
      ).toBe(
        "Moving this computer's settings to Personal · 1 of 3 items applied",
      ),
    );

    // The count moves with the upload, and the note clears when the move
    // ends - both inside a span the steady cadence cannot resolve.
    answer = moving(2);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("host-settings-card-progress").textContent,
        ).toBe(
          "Moving this computer's settings to Personal · 2 of 3 items applied",
        ),
      { timeout: WITHIN_THE_MOVE_MS },
    );

    answer = MOVED;
    await waitFor(
      () =>
        expect(screen.queryByTestId("host-settings-card-progress")).toBeNull(),
      { timeout: WITHIN_THE_MOVE_MS },
    );
  });

  it("leaves a computer that has not moved on the steady cadence", async () => {
    const { reads } = renderNote(() => AWAITING_CONSENT);
    await waitFor(() =>
      expect(screen.getByTestId("local-row-note").textContent).toContain(
        "not in Personal yet",
      ),
    );

    await holdFor(BEFORE_THE_STEADY_READ_MS);

    // A computer resting at `moving_settings`/`awaiting_consent` is the
    // ordinary un-moved computer, not a move under way: the one read so far.
    expect(reads()).toBe(1);
  });

  it("leaves a computer that stopped sharing on the steady cadence", async () => {
    // `Stop sharing from this computer` KEEPS the migration marker, so the
    // status still carries that marker's consent - the old `acceptedAt` and
    // all - while first start runs again and rests at `awaiting_consent`
    // waiting to be asked (`traycer-host/.../migration/marker.ts`, and
    // `environment-move-after-stop.test.ts` asserts the pair). Nobody is
    // being asked anything and nothing is uploading.
    const stoppedSharing = environmentStatusFixture({
      principal: { kind: "personal" },
      planes: { records: "stopped", broker: "stopped", room: "stopped" },
      consent: { acceptedAt: ACCEPTED_AT, planHash: "plan-1" },
      setup: { stage: "moving_settings", state: "awaiting_consent" },
    });
    const { reads } = renderNote(() => stoppedSharing);
    await waitFor(() =>
      expect(screen.getByTestId("local-row-note").textContent).toContain(
        "not in Personal yet",
      ),
    );

    await holdFor(BEFORE_THE_STEADY_READ_MS);

    expect(reads()).toBe(1);
  });

  it("leaves a stopped move on the steady cadence: Retry is what asks again", async () => {
    const stopped = environmentStatusFixture({
      principal: { kind: "personal" },
      planes: { records: "local", broker: "local", room: "local" },
      consent: null,
      setup: { stage: "moving_settings", state: "failed" },
      items: [
        itemStatusFixture({ kind: "env_var", key: "A", status: "failed" }),
      ],
    });
    const { reads } = renderNote(() => stopped);
    await waitFor(() =>
      expect(
        screen.getByTestId("host-settings-card-move-stopped").textContent,
      ).toBe("Moving stopped: it couldn't finish. 1 item left."),
    );

    await holdFor(BEFORE_THE_STEADY_READ_MS);

    expect(reads()).toBe(1);
  });
});
