import { useEffect, useState } from "react";

// Compiled by the suite (it is on `REACT_COMPILER_REGRESSION_FILES`) so
// `react-compiler-harness.test.tsx` can tell whether a listed component
// actually compiles. Not app code. It calls a hook on purpose: the compiler
// meets this file after the JSX transform, where a function is recognized as
// a component by its hook calls, as in the packaged renderer.

export function CompilerHarnessProbe(props: {
  readonly label: string;
  readonly onChildCommit: () => void;
}) {
  const [suffix] = useState("");
  return (
    <CompilerHarnessChild
      label={props.label + suffix}
      onCommit={props.onChildCommit}
    />
  );
}

function CompilerHarnessChild(props: {
  readonly label: string;
  readonly onCommit: () => void;
}) {
  // Every committed render of the child, and only those.
  useEffect(() => {
    props.onCommit();
  });
  return <span>{props.label}</span>;
}
