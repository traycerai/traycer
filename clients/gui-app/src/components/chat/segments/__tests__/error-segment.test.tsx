import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ErrorSegment } from "../error-segment";

describe("<ErrorSegment />", () => {
  afterEach(() => {
    cleanup();
  });

  // Auth errors never reach this component - they're suppressed at the
  // projection layer (`suppressAuthErrors`). This is the static chrome for every
  // other (non-auth) error: the "Error" overline, the code badge, and the
  // message.
  it("renders the error chrome with the code badge and message", () => {
    render(
      <ErrorSegment
        message="Boom went the host"
        code="RUNTIME_THROWN"
        findUnitId={null}
      />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("RUNTIME_THROWN")).toBeDefined();
    expect(screen.getByText("Boom went the host")).toBeDefined();
  });

  it("omits the code badge when there is no code", () => {
    render(
      <ErrorSegment message="Something failed" code={null} findUnitId={null} />,
    );

    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("Something failed")).toBeDefined();
  });
});
