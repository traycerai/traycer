import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";

function ReadHost() {
  return <span data-testid="bound">{useTabHostId()}</span>;
}

describe("<TabHostProvider />", () => {
  afterEach(() => cleanup());

  it("returns the hostId set on the surrounding provider", () => {
    const { getByTestId } = render(
      <TabHostProvider hostId="host-A">
        <ReadHost />
      </TabHostProvider>,
    );
    expect(getByTestId("bound").textContent).toBe("host-A");
  });

  it("is independent per provider instance", () => {
    const { getAllByTestId } = render(
      <>
        <TabHostProvider hostId="host-A">
          <ReadHost />
        </TabHostProvider>
        <TabHostProvider hostId="host-B">
          <ReadHost />
        </TabHostProvider>
      </>,
    );
    const bound = getAllByTestId("bound").map((node) => node.textContent);
    expect(bound).toEqual(["host-A", "host-B"]);
  });

  it("throws when useTabHostId is called without a provider", () => {
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<ReadHost />)).toThrow(
        /useTabHostId must be called inside <TabHostProvider>/,
      );
    } finally {
      console.error = consoleError;
    }
  });
});
