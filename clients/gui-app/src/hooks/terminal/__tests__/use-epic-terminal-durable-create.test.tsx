import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptEpicTerminalDurableCreate,
  resetEpicTerminalDurableCreatesForTests,
} from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import {
  useEpicTerminalDurableCreate,
  useEpicTerminalDurableCreateJobs,
  useEpicTerminalDurableCreateJobViews,
} from "@/hooks/terminal/use-epic-terminal-durable-create";

const REQUEST = {
  hostId: "host-1",
  terminalId: "terminal-1",
  epicId: "epic-1",
  cwd: "/repo",
  cols: 80,
  rows: 24,
} as const;

describe("epic terminal durable create hooks", () => {
  afterEach(() => {
    cleanup();
    resetEpicTerminalDurableCreatesForTests();
  });

  it("observes a create accepted after the hooks mount", async () => {
    const rendered = renderHook(() => ({
      jobs: useEpicTerminalDurableCreateJobs(REQUEST.epicId),
      views: useEpicTerminalDurableCreateJobViews(REQUEST.epicId),
      job: useEpicTerminalDurableCreate(REQUEST.hostId, REQUEST.terminalId),
    }));

    expect(rendered.result.current).toEqual({
      jobs: [],
      views: [],
      job: null,
    });

    act(() => {
      acceptEpicTerminalDurableCreate(REQUEST);
    });

    await waitFor(() => {
      expect(rendered.result.current.jobs).toEqual([REQUEST]);
      expect(rendered.result.current.views).toEqual([
        { request: REQUEST, status: "accepted", error: null },
      ]);
      expect(rendered.result.current.job).toEqual({
        request: REQUEST,
        status: "accepted",
        error: null,
      });
    });
  });
});
