import { describe, expect, it } from "vitest";
import {
  GET_TASK_CONTEXTS_MAX_IDS,
  type GetTaskContextsResponse,
  type ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import {
  chunkTaskIds,
  combineLocalPinReadings,
  combineTaskPinnedStateResults,
  overlayLocalHomedPinnedStates,
  type TaskPinnedState,
} from "@/hooks/epic/use-epic-task-pinned-states-query";

function listTaskLight(epicId: string | null, pinned: boolean): ListTaskLight {
  return {
    epic: {
      light:
        epicId === null
          ? null
          : {
              id: epicId,
              title: epicId,
              initialUserPrompt: "",
              ticketCount: 0,
              specCount: 0,
              storyCount: 0,
              reviewCount: 0,
              status: "draft",
              createdAt: 0,
              updatedAt: 0,
              createdBy: "user-1",
              version: "1.0.0",
            },
      permission: null,
      repos: [],
      workspaces: [],
      roomInfo: null,
    },
    pinned,
  };
}

function taskContexts(
  tasks: GetTaskContextsResponse["tasks"],
  localHomedTaskIds: GetTaskContextsResponse["localHomedTaskIds"],
): GetTaskContextsResponse {
  return { tasks, localHomedTaskIds };
}

describe("chunkTaskIds", () => {
  it("splits requests that exceed the task-context request limit", () => {
    const taskIds = Array.from(
      { length: GET_TASK_CONTEXTS_MAX_IDS + 1 },
      (_value, index) => `epic-${index}`,
    );

    expect(chunkTaskIds(taskIds)).toEqual([
      taskIds.slice(0, GET_TASK_CONTEXTS_MAX_IDS),
      taskIds.slice(GET_TASK_CONTEXTS_MAX_IDS),
    ]);
  });
});

describe("combineTaskPinnedStateResults", () => {
  it("returns the shared empty state when no requests are present", () => {
    const pinnedStates = combineTaskPinnedStateResults([]);

    expect(pinnedStates).toBe(combineTaskPinnedStateResults([]));
    expect([...pinnedStates.entries()]).toEqual([]);
  });

  it("merges found rows and skips unknown or incomplete task entries", () => {
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts(
          {
            first: { status: "found", task: listTaskLight("epic-a", true) },
            missing: { status: "unknown", reason: "transport" },
            incomplete: { status: "found", task: listTaskLight(null, true) },
          },
          undefined,
        ),
      },
      {
        data: taskContexts(
          {
            second: { status: "found", task: listTaskLight("epic-b", false) },
          },
          undefined,
        ),
      },
      { data: undefined },
    ]);

    // The map holds `TaskPinnedState`, not a bare boolean: `home` rides along
    // so a row can disable its cloud-only pin action without a second lookup.
    // No local-home set is supplied here, so `home` is absent for both.
    // `pinnedKnown` is `true` for every resolved task - the host answered.
    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", { pinned: true, home: undefined, hostId: null, pinnedKnown: true }],
      ["epic-b", { pinned: false, home: undefined, hostId: null, pinnedKnown: true }],
    ]);
  });

  it("marks a row local when the host's localHomedTaskIds names it", () => {
    // The populated arm: `localHomedTaskIds` is a real answer that must flip
    // `home` to `"local"` for exactly the ids it names.
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts(
          {
            first: { status: "found", task: listTaskLight("epic-a", true) },
          },
          ["epic-a"],
        ),
      },
    ]);

    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", { pinned: true, home: "local", hostId: null, pinnedKnown: true }],
    ]);
  });

  it("treats an EMPTY localHomedTaskIds as a real answer of none, not absence", () => {
    // An absent key means the host did not answer; an empty array means it
    // did, and the answer is "no task here is local-homed". Both must leave
    // `home` at `undefined`, but for different reasons - this pins the
    // second one so it cannot silently start behaving like the first.
    const pinnedStates = combineTaskPinnedStateResults([
      {
        data: taskContexts(
          {
            first: { status: "found", task: listTaskLight("epic-a", true) },
          },
          [],
        ),
      },
    ]);

    expect([...pinnedStates.entries()]).toEqual([
      ["epic-a", { pinned: true, home: undefined, hostId: null, pinnedKnown: true }],
    ]);
  });
});

/**
 * The list query has not answered yet. Every case passing this is asserting the
 * in-flight column, which is also the pre-R1 behaviour - so these are not stale
 * fixtures, they are "nobody has answered" stated explicitly.
 */
const NO_LOCAL_READINGS: ReadonlyMap<string, boolean> = new Map();

/** No session named a host - so `hostId` stays `null` and a pin follows the window. */
const NO_LOCAL_HOSTS: ReadonlyMap<string, string> = new Map();

/**
 * `combineLocalPinReadings` is the only place a row's `pinned` bit is promoted
 * to a READING, and `home` is the whole of the test: a `home: "cloud"` row
 * carries `pinned: false` as "the absence of a claim", so admitting one would
 * publish a false reading for every cloud-homed epic on the host - indetectable
 * downstream, because `pinnedKnown` would then say the answer is known.
 */
describe("combineLocalPinReadings", () => {
  function homedRow(
    epicId: string,
    pinned: boolean,
    home: "local" | "cloud" | undefined,
  ): ListTaskLight {
    return { ...listTaskLight(epicId, pinned), home };
  }

  it("reads the pin off local-homed rows and ignores cloud-homed ones", () => {
    const readings = combineLocalPinReadings([
      {
        data: {
          tasks: [
            homedRow("epic-local-pinned", true, "local"),
            homedRow("epic-local-unpinned", false, "local"),
            homedRow("epic-cloud-unpinned", false, "cloud"),
            homedRow("epic-cloud-pinned", true, "cloud"),
          ],
          hasMore: false,
        },
      },
    ]);

    expect([...readings.entries()].sort()).toEqual([
      ["epic-local-pinned", true],
      ["epic-local-unpinned", false],
    ]);
    // Not `false` for these - ABSENT, which is what keeps `pinnedKnown` false.
    expect(readings.has("epic-cloud-unpinned")).toBe(false);
    expect(readings.has("epic-cloud-pinned")).toBe(false);
  });

  it("ignores a row with no `home` at all - a `@1.5` host answering", () => {
    const readings = combineLocalPinReadings([
      { data: { tasks: [homedRow("epic-1", false, undefined)], hasMore: false } },
    ]);

    expect(readings.size).toBe(0);
  });

  it("merges every host's page and skips rows with no epic id", () => {
    const readings = combineLocalPinReadings([
      {
        data: {
          tasks: [homedRow("epic-a", true, "local"), listTaskLight(null, true)],
          hasMore: false,
        },
      },
      { data: undefined },
      { data: { tasks: [homedRow("epic-b", false, "local")], hasMore: false } },
    ]);

    expect([...readings.entries()].sort()).toEqual([
      ["epic-a", true],
      ["epic-b", false],
    ]);
  });
});

describe("overlayLocalHomedPinnedStates", () => {
  it("returns the SAME map object when there is nothing to overlay", () => {
    // Deliberate identity preservation, not merely equal content: the common
    // case (no locally-homed epics among the open tabs) must not hand
    // consumers a fresh map every render.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-a", { pinned: true, home: undefined, hostId: null, pinnedKnown: true }],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(overlaid).toBe(queried);
  });

  it("adds an entry for a local-homed epic the queried host never resolved, with pinnedKnown false", () => {
    // The wrong-host gap this hook exists to close: the epic id never reached
    // the queried map at all, so `pinned` has no source and must fall back to
    // filler rather than being left absent. `pinnedKnown: false` is what
    // marks that fallback as a FILLER, not a reading - the flag `epic.set
    // Pinned@1.1` made load-bearing (lane 9 item 5): a consumer that reads
    // `pinned` while this is false is reading "nobody answered" as "not
    // pinned".
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map();

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-local-only"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect([...overlaid.entries()]).toEqual([
      [
        "epic-local-only",
        { pinned: false, home: "local", hostId: null, pinnedKnown: false },
      ],
    ]);
  });

  it("keeps the queried `pinned` value while overriding `home` to local, with pinnedKnown true", () => {
    // `pinned` is a cloud-only preference the queried host answers correctly
    // regardless of ownership - only `home` is ever overridden by the
    // session's own answer. `pinnedKnown` is `true` here because the queried
    // map ALREADY had this epic - the host resolved it.
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-both", { pinned: true, home: undefined, hostId: null, pinnedKnown: true }],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-both"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(overlaid.get("epic-both")).toEqual({
      pinned: true,
      home: "local",
      hostId: null,
      pinnedKnown: true,
    });
  });

  it("leaves an epic absent from `localHomedEpicIds` exactly as queried", () => {
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-cloud", { pinned: true, home: undefined, hostId: null, pinnedKnown: true }],
    ]);

    const overlaid = overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-unrelated"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(overlaid.get("epic-cloud")).toEqual({
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
  });

  it("takes `pinned` from the LOCAL REGISTRY reading, and marks it known", () => {
    // R1. The cold unverified tab: the cloud batch is withheld, so `queried` is
    // empty and the old code answered `pinnedKnown: false` forever, which the
    // `@1.1` menu renders as permanently unavailable. The host's local arm
    // stores the pin in `local_epic.pinnedByUserId`, and the local-first list
    // line reports it as `pinned` on a `home: "local"` row - a real reading
    // from an account-scoped durable field, with no cloud read behind it.
    const overlaid = overlayLocalHomedPinnedStates(
      new Map(),
      new Set(["epic-local-only"]),
      new Map([["epic-local-only", true]]),
      new Map([["epic-local-only", "host-owning"]]),
    );

    expect(overlaid.get("epic-local-only")).toEqual({
      pinned: true,
      home: "local",
      hostId: "host-owning",
      pinnedKnown: true,
    });
  });

  it("lets the local reading WIN over a cloud answer for the same epic", () => {
    // Precedence, asserted with the two sources DISAGREEING - the only
    // arrangement that can tell which one won. For a local-homed epic the
    // registry is the authority: the cloud has no row for it, so a cloud
    // `pinned: false` there is an absence wearing a boolean. This reverses the
    // old rule, which was right while every pin was a cloud pin.
    const overlaid = overlayLocalHomedPinnedStates(
      new Map([
        ["epic-both", { pinned: false, home: undefined, hostId: null, pinnedKnown: true }],
      ]),
      new Set(["epic-both"]),
      new Map([["epic-both", true]]),
      new Map([["epic-both", "host-owning"]]),
    );

    expect(overlaid.get("epic-both")?.pinned).toBe(true);
  });

  it("reads `false` from the registry as a READING, not as filler", () => {
    // The discriminating case for `pinnedKnown`, and the reason the reading is
    // a Map rather than a set of pinned ids: an unpinned local epic and an
    // unanswered one are both `pinned: false`, and only the map's KEY
    // distinguishes them. A `Set<string>` of pinned ids could not.
    const overlaid = overlayLocalHomedPinnedStates(
      new Map(),
      new Set(["epic-local-unpinned"]),
      new Map([["epic-local-unpinned", false]]),
      new Map([["epic-local-unpinned", "host-owning"]]),
    );

    expect(overlaid.get("epic-local-unpinned")).toEqual({
      pinned: false,
      home: "local",
      hostId: "host-owning",
      pinnedKnown: true,
    });
  });

  it("does not mutate the queried map it was given", () => {
    const queried: ReadonlyMap<string, TaskPinnedState> = new Map([
      ["epic-a", { pinned: false, home: undefined, hostId: null, pinnedKnown: true }],
    ]);

    overlayLocalHomedPinnedStates(
      queried,
      new Set(["epic-a"]),
      NO_LOCAL_READINGS,
      NO_LOCAL_HOSTS,
    );

    expect(queried.get("epic-a")).toEqual({
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
  });
});
