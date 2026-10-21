import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { CompilerHarnessProbe } from "./react-compiler-harness-probe";

// A component on `REACT_COMPILER_REGRESSION_FILES` must reach the compiler in
// a form it compiles. The development JSX transform hands it `this`, which it
// refuses, and every component-site regression test on the list then runs
// uncompiled and passes whether or not the bug ships.
describe("React Compiler test harness", () => {
  it("compiles a listed component: its child is not rendered again for unchanged props", () => {
    const onChildCommit = vi.fn();
    const { rerender } = render(
      <CompilerHarnessProbe label="probe" onChildCommit={onChildCommit} />,
    );
    rerender(
      <CompilerHarnessProbe label="probe" onChildCommit={onChildCommit} />,
    );
    // Uncompiled, the parent builds a fresh child element and the child
    // renders and commits again; compiled, the element is cached on
    // unchanged props and React skips the child.
    expect(onChildCommit).toHaveBeenCalledTimes(1);
  });
});
