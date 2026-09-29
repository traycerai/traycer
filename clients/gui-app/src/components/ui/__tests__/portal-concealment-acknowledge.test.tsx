import { useContext, useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PortalConcealmentBoundary,
  PortalPresentationContext,
} from "@/components/ui/portal-concealment-context";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";

afterEach(cleanup);

const ITEMS = { a: "Alpha", b: "Beta" };

function StubbornSelect(props: { readonly label: string }): React.JSX.Element {
  // A controlled owner that never lets go of `open`, so it ignores the
  // synthetic presentation-loss close it is sent on concealment.
  return (
    <Select items={ITEMS} open onOpenChange={() => undefined} value="a">
      <SelectTrigger aria-label={props.label}>
        <SelectValue placeholder="None" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Alpha</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ClosedSelect(props: { readonly label: string }): React.JSX.Element {
  return (
    <Select items={ITEMS} value="a" onValueChange={() => undefined}>
      <SelectTrigger aria-label={props.label}>
        <SelectValue placeholder="None" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Alpha</SelectItem>
      </SelectContent>
    </Select>
  );
}

function region(props: {
  readonly concealed: boolean;
  readonly stubborn: boolean;
}): React.JSX.Element {
  return (
    <PortalConcealmentBoundary concealed={props.concealed}>
      <div data-testid="region">
        <ClosedSelect label="Closed" />
        {props.stubborn ? <StubbornSelect label="Stubborn" /> : null}
      </div>
    </PortalConcealmentBoundary>
  );
}

describe("PortalConcealmentBoundary acknowledgement", () => {
  it("hides the region even when a controlled owner ignores the presentation-loss close", () => {
    const view = render(region({ concealed: false, stubborn: true }));
    expect(isConcealed(screen.getByTestId("region"))).toBe(false);

    view.rerender(region({ concealed: true, stubborn: true }));

    expect(isConcealed(screen.getByTestId("region"))).toBe(true);
  });

  it("hides the region once the last still-pending root unmounts", () => {
    // A bare registrant never reports closed, so it alone holds the region
    // visible; only removing it can let the boundary finish.
    function BareRoot(): null {
      const host = useContext(PortalPresentationContext);
      const [token] = useState(() => ({}));
      const register = host?.register;
      useLayoutEffect(() => register?.(token), [register, token]);
      return null;
    }
    const tree = (pending: boolean) => (
      <PortalConcealmentBoundary concealed>
        <div data-testid="region">{pending ? <BareRoot /> : null}</div>
      </PortalConcealmentBoundary>
    );
    const view = render(tree(true));
    expect(isConcealed(screen.getByTestId("region"))).toBe(false);

    view.rerender(tree(false));

    expect(isConcealed(screen.getByTestId("region"))).toBe(true);
  });
});
