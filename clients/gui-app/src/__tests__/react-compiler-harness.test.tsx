import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { CompilerHarnessProbe } from "./react-compiler-harness-probe";

// A component on `REACT_COMPILER_REGRESSION_FILES` must reach the compiler in
// a form it compiles. The development JSX transform hands it `this`, which it
// refuses, and every component-site regression test on the list then runs
// uncompiled and passes whether or not the bug ships.
describe("React Compiler test harness", () => {
  it("compiles a listed component: its child element is memoized across a same-props render", () => {
    const onChildRender = vi.fn();
    const { rerender } = render(
      <CompilerHarnessProbe label="probe" onChildRender={onChildRender} />,
    );
    rerender(
      <CompilerHarnessProbe label="probe" onChildRender={onChildRender} />,
    );
    // Uncompiled, the parent builds a fresh child element and the child
    // renders again; compiled, the element is cached on unchanged props.
    expect(onChildRender).toHaveBeenCalledTimes(1);
  });
});
