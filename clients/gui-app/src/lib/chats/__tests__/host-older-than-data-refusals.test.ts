import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHostOlderThanDataRefusal,
  hostRefusesEpicStore,
  recordHostOlderThanDataRefusal,
  resetHostOlderThanDataRefusalsForTests,
  subscribeHostOlderThanDataRefusal,
} from "@/lib/chats/host-older-than-data-refusals";

const HOST_ID = "host-a";
const EPIC_ID = "epic-1";

beforeEach(() => {
  resetHostOlderThanDataRefusalsForTests();
});

describe("hostRefusesEpicStore", () => {
  it("answers true after a refusal is recorded for the same current build", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });

    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: "1.2.3",
      }),
    ).toBe(true);
  });

  it("answers false, and evicts, when the current build differs from the recorded one", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });

    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: "1.3.0",
      }),
    ).toBe(false);

    // Evicted: a later read with the ORIGINAL version is also false now.
    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: "1.2.3",
      }),
    ).toBe(false);
  });

  it("treats two unknown versions (null/null) as equal", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: null,
      now: 1,
    });

    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: null,
      }),
    ).toBe(true);
  });

  it("answers false when nothing was ever recorded", () => {
    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: "1.2.3",
      }),
    ).toBe(false);
  });
});

describe("clearHostOlderThanDataRefusal", () => {
  it("drops only the cleared (host, epic) pair, leaving a sibling epic's refusal intact", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: "epic-2",
      hostVersion: "1.2.3",
      now: 1,
    });

    clearHostOlderThanDataRefusal({ hostId: HOST_ID, epicId: EPIC_ID });

    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: "1.2.3",
      }),
    ).toBe(false);
    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: "epic-2",
        hostVersion: "1.2.3",
      }),
    ).toBe(true);
  });
});

describe("subscribeHostOlderThanDataRefusal", () => {
  it("does not wake a listener keyed to another epic or host", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHostOlderThanDataRefusal(
      HOST_ID,
      EPIC_ID,
      listener,
    );

    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: "epic-other",
      hostVersion: "1.2.3",
      now: 1,
    });
    recordHostOlderThanDataRefusal({
      hostId: "host-other",
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifies listeners on record and on clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeHostOlderThanDataRefusal(
      HOST_ID,
      EPIC_ID,
      listener,
    );

    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    clearHostOlderThanDataRefusal({ hostId: HOST_ID, epicId: EPIC_ID });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("does not notify on an idempotent re-record of the same build", () => {
    const listener = vi.fn();
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });

    const unsubscribe = subscribeHostOlderThanDataRefusal(
      HOST_ID,
      EPIC_ID,
      listener,
    );
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 2,
    });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("resetHostOlderThanDataRefusalsForTests", () => {
  it("drops every recorded refusal", () => {
    recordHostOlderThanDataRefusal({
      hostId: HOST_ID,
      epicId: EPIC_ID,
      hostVersion: "1.2.3",
      now: 1,
    });

    resetHostOlderThanDataRefusalsForTests();

    expect(
      hostRefusesEpicStore({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        hostVersion: "1.2.3",
      }),
    ).toBe(false);
  });
});
