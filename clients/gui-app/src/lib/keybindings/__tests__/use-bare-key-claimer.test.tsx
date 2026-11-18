import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";

afterEach(cleanup);

function pressR(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "r", cancelable: true }),
  );
}

describe("useBareKeyClaimer", () => {
  it("runs the CURRENT render's handler for a key that lands before passive effects flush", () => {
    // The caller is outside React. `bare-key-owner`'s window listener fires on
    // whatever task the keystroke lands on - including the window between a
    // commit and React's passive-effect flush, which is a separate scheduler
    // task. Hand the ref over passively and it points at the PREVIOUS render
    // for that whole window: the surface is on screen in its new state while
    // the key still runs the old closure.
    //
    // `Dispatcher` presses the key from a LAYOUT effect, which is exactly that
    // window - the DOM is committed, passive effects are not yet flushed - and
    // is ordered after `Surface`'s own hand-off by tree order. Driving it from
    // a real out-of-act commit would reproduce the same thing only sometimes;
    // this pins it every run. (`flushSync` does NOT: a sync-lane commit flushes
    // its own passive effects before returning, so it closes the window it was
    // meant to open, and this test passed against the passive version.)
    //
    // Not hypothetical: this is what made `workspace-folders-refresh` ›
    // "re-derives on R while the picker is open" flake in CI. Its `settle()`
    // waits for the Refresh button to re-enable - a DOM fact that lands in the
    // mutation phase - and then presses `R`. When the flush had not run, `R`
    // ran the handler from the render where `refreshing` was still true, whose
    // `trigger` early-returns, and no refresh happened at all.
    const seen: number[] = [];
    let bump: (value: number) => void = () => undefined;

    function Surface(props: { readonly value: number }): null {
      const claimKey = useBareKeyClaimer("r", () => {
        seen.push(props.value);
      });
      useEffect(() => claimKey(), [claimKey]);
      return null;
    }

    function Dispatcher(props: { readonly token: number }): null {
      const token = props.token;
      useLayoutEffect(() => {
        if (token === 0) return;
        pressR();
      }, [token]);
      return null;
    }

    function Harness(): ReactNode {
      const [value, setValue] = useState(0);
      bump = setValue;
      return (
        <>
          <Surface value={value} />
          <Dispatcher token={value} />
        </>
      );
    }

    render(<Harness />);
    pressR();
    expect(seen).toEqual([0]);

    act(() => {
      bump(1);
    });

    expect(seen).toEqual([0, 1]);
  });

  it("keeps one identity across handler changes, so a claim is not re-prioritized by one", () => {
    // `claimBareKey` is last-claim-wins and releases by `lastIndexOf(handler)`.
    // A factory whose identity moved with the handler would re-claim on every
    // render - pushing an older overlay back above a newer one - and would hand
    // `lastIndexOf` a handler that is no longer the registered one.
    const identities = new Set<() => () => void>();
    let bump: (value: number) => void = () => undefined;

    function Surface(): null {
      const [value, setValue] = useState(0);
      bump = setValue;
      const claimKey = useBareKeyClaimer("r", () => {
        identities.add(claimKey);
        void value;
      });
      identities.add(claimKey);
      useEffect(() => claimKey(), [claimKey]);
      return null;
    }

    render(<Surface />);
    act(() => {
      bump(1);
    });
    act(() => {
      bump(2);
    });

    expect(identities.size).toBe(1);
  });
});
