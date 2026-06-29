import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MonitorEventSegment } from "@/components/chat/segments/monitor-event-segment";

describe("<MonitorEventSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the monitor event line", () => {
    render(<MonitorEventSegment name="watch logs" />);

    expect(
      screen.getByText('Event received from monitor "watch logs"'),
    ).toBeTruthy();
  });
});
