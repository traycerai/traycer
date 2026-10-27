import { useEffect, useState, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EnvOverrideEditor } from "../env-override-editor";

/**
 * The editor stays mounted while a write travels to the host and until the
 * read that follows shows it: the person's Add and Remove must stay
 * represented the whole time, never as "No variables" or as the old value,
 * and a refused write keeps the draft to correct. The parent owns the
 * mutation (`onCommit` and `onDelete` resolve after the post-write read) and
 * the rows it passes back; here the "host" is a test-held write and a test-held
 * read, so each gap is something the test opens and closes.
 */

const EMPTY_LABEL = "No environment variables.";

interface Write {
  readonly settle: (outcome: "ok" | "refused") => Promise<void>;
  readonly finishRead: () => Promise<void>;
}

interface Row {
  readonly key: string;
  readonly value: string | null;
}

/** A parent that hands the editor the rows a test says the host has read. */
function Parent(props: {
  readonly initial: readonly Row[];
  readonly onWrite: (write: Write) => void;
  readonly onRows: (setRows: (rows: readonly Row[]) => void) => void;
}): ReactNode {
  const [rows, setRows] = useState<readonly Row[]>(props.initial);
  const { onRows } = props;
  useEffect(() => {
    onRows(setRows);
  }, [onRows]);
  const start = (): Promise<void> => {
    const completed = new Promise<void>((resolve, reject) => {
      let accepted = false;
      let readComplete = false;
      props.onWrite({
        finishRead: async () => {
          await act(async () => {
            readComplete = true;
            if (accepted) {
              resolve();
              await completed;
            }
          });
        },
        settle: async (outcome) => {
          await act(async () => {
            if (outcome === "ok") {
              accepted = true;
              if (readComplete) {
                resolve();
                await completed;
              }
            } else {
              reject(new Error("The host refused this change."));
              await completed.catch(() => undefined);
            }
          });
        },
      });
    });
    return completed;
  };
  return (
    <EnvOverrideEditor
      overrides={rows}
      disabled={false}
      credentialRefusal={null}
      rowNotes={new Map()}
      claimedBy={new Map()}
      onHold={new Map()}
      keyRefusal={null}
      staleRefusal={null}
      namePlaceholder="OPENAI_API_KEY"
      emptyLabel={EMPTY_LABEL}
      onCommit={start}
      onDelete={start}
    />
  );
}

function mountEditor(initial: readonly Row[]) {
  const held: {
    write: Write | null;
    count: number;
    setRows: (rows: readonly Row[]) => void;
  } = { write: null, count: 0, setRows: () => undefined };
  render(
    <Parent
      initial={initial}
      onWrite={(write) => {
        held.count += 1;
        held.write = write;
      }}
      onRows={(setRows) => {
        held.setRows = setRows;
      }}
    />,
  );
  const settle = async (outcome: "ok" | "refused"): Promise<void> => {
    if (held.write === null) throw new Error("no write is in flight");
    await held.write.settle(outcome);
  };
  /** The read the host answers once it has applied the write. */
  const observe = async (rows: readonly Row[]): Promise<void> => {
    act(() => held.setRows(rows));
    await held.write?.finishRead();
  };
  return {
    settle,
    observe,
    held: { writes: () => held.count },
  };
}

function stageAdd(name: string, value: string): void {
  fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
  fireEvent.change(screen.getByLabelText("New variable name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("New variable value"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply variable" }));
}

function expectPendingDraft(): void {
  const name = screen.getByLabelText("New variable name");
  const value = screen.getByLabelText("New variable value");
  expect(name).toHaveProperty("value", "NEW_VAR");
  expect(name).toHaveProperty("disabled", true);
  expect(value).toHaveProperty("value", "one");
  expect(value).toHaveProperty("disabled", true);
  expect(screen.getByText(/NEW_VAR/)).toBeTruthy();
  expect(screen.getByText(/adding/i)).toBeTruthy();
  expect(screen.queryByText(EMPTY_LABEL)).toBeNull();
}

afterEach(() => {
  cleanup();
});

describe("EnvOverrideEditor left mounted across a write", () => {
  it("keeps an added variable's draft, disabled, as Adding from Apply until the read lists it, never as an empty table", async () => {
    const { settle, observe } = mountEditor([]);

    stageAdd("NEW_VAR", "one");

    // The write is in flight: the draft stays, disabled and unchanged, so a
    // refusal can hand back exactly what was typed.
    expectPendingDraft();

    // The write was accepted but the read has not caught up yet.
    await settle("ok");
    expectPendingDraft();

    // The read lists it: the draft closes and an ordinary editable row
    // replaces it.
    await observe([{ key: "NEW_VAR", value: "one" }]);
    expect(screen.queryByLabelText("New variable name")).toBeNull();
    expect(screen.getByLabelText("Value for NEW_VAR")).toBeTruthy();
    expect(screen.queryByText(/adding/i)).toBeNull();
    expect(screen.queryByText(EMPTY_LABEL)).toBeNull();
  });

  it.each([
    { reason: "changed elsewhere", rows: [{ key: "NEW_VAR", value: "other" }] },
    { reason: "removed elsewhere", rows: [] },
    {
      reason: "normalized by the host",
      rows: [{ key: "NEW_VAR", value: "ONE" }],
    },
  ])(
    "unlocks after an accepted Add is $reason in the next read",
    async ({ rows }) => {
      const { settle, observe } = mountEditor([]);

      stageAdd("NEW_VAR", "one");
      await settle("ok");
      expectPendingDraft();

      await observe(rows);

      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByLabelText("New variable name")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Add a variable" }),
      ).toHaveProperty("disabled", false);
      if (rows.length > 0) {
        expect(screen.getByLabelText("Value for NEW_VAR")).toHaveProperty(
          "value",
          rows[0]?.value,
        );
      } else {
        expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
      }
    },
  );

  it("unlocks when the completed read keeps the original empty array through structural sharing", async () => {
    const original: readonly Row[] = [];
    const { settle, observe } = mountEditor(original);
    stageAdd("NEW_VAR", "one");
    await settle("ok");
    expectPendingDraft();

    await observe(original);

    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
  });

  it("waits for write completion when the normalized read arrives first", async () => {
    const { settle, observe } = mountEditor([]);
    stageAdd("NEW_VAR", "one");
    await observe([{ key: "NEW_VAR", value: "ONE" }]);
    expectPendingDraft();

    await settle("ok");

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("Value for NEW_VAR")).toHaveProperty(
      "value",
      "ONE",
    );
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
  });

  it("shows a removed variable as Removing from Remove until the read drops it, not as a value still Set", async () => {
    const { settle, observe, held } = mountEditor([
      { key: "OLD_VAR", value: "token" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove OLD_VAR" }));

    // The real row stays, with its Remove disabled: a second press cannot
    // send the delete again.
    expect(screen.getByText(/removing/i)).toBeTruthy();
    const pendingRemove = screen.getByRole("button", {
      name: "Remove OLD_VAR",
    });
    expect(pendingRemove).toHaveProperty("disabled", true);
    fireEvent.click(pendingRemove);
    expect(held.writes()).toBe(1);

    // Accepted, but the read still lists it: still Removing, still disabled.
    await settle("ok");
    expect(screen.getByText(/removing/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove OLD_VAR" }),
    ).toHaveProperty("disabled", true);
    expect(held.writes()).toBe(1);

    await observe([]);
    expect(screen.queryByText(/OLD_VAR/)).toBeNull();
    expect(screen.queryByText(/removing/i)).toBeNull();
    expect(screen.getByText(EMPTY_LABEL)).toBeTruthy();
  });

  it("settles an accepted Remove when the post-write read shows the key recreated elsewhere", async () => {
    const { settle, observe } = mountEditor([
      { key: "OLD_VAR", value: "original" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove OLD_VAR" }));
    await settle("ok");
    await observe([{ key: "OLD_VAR", value: "recreated" }]);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("Value for OLD_VAR")).toHaveProperty(
      "value",
      "recreated",
    );
    expect(
      screen.getByRole("button", { name: "Remove OLD_VAR" }),
    ).toHaveProperty("disabled", false);
  });

  it("shows a normalized saved edit without overwriting another row's draft or resubmitting on blur", async () => {
    const { settle, observe, held } = mountEditor([
      { key: "OLD_VAR", value: "original" },
      { key: "OTHER_VAR", value: "saved" },
    ]);
    fireEvent.change(screen.getByLabelText("Value for OTHER_VAR"), {
      target: { value: "unsaved" },
    });
    fireEvent.change(screen.getByLabelText("Value for OLD_VAR"), {
      target: { value: "submitted" },
    });
    fireEvent.blur(screen.getByLabelText("Value for OLD_VAR"));
    await settle("ok");
    await observe([
      { key: "OLD_VAR", value: "NORMALIZED" },
      { key: "OTHER_VAR", value: "saved" },
    ]);

    expect(screen.getByLabelText("Value for OLD_VAR")).toHaveProperty(
      "value",
      "NORMALIZED",
    );
    expect(screen.getByLabelText("Value for OTHER_VAR")).toHaveProperty(
      "value",
      "unsaved",
    );
    fireEvent.blur(screen.getByLabelText("Value for OLD_VAR"));
    expect(held.writes()).toBe(1);
  });

  it("puts a refused Add back as an editable draft with the refusal, nothing pending", async () => {
    const { settle } = mountEditor([]);

    stageAdd("NEW_VAR", "one");
    await settle("refused");

    const name = screen.getByLabelText("New variable name");
    expect(name).toHaveProperty("value", "NEW_VAR");
    expect(screen.getByLabelText("New variable value")).toHaveProperty(
      "value",
      "one",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "The host refused this change.",
    );
    expect(screen.queryByText(/adding/i)).toBeNull();
    // The draft can be corrected and sent again.
    fireEvent.change(name, { target: { value: "OTHER_VAR" } });
    expect(
      screen.getByRole("button", { name: "Apply variable" }),
    ).toHaveProperty("disabled", false);
  });

  it("puts a refused Remove back as the row it was, with the refusal", async () => {
    const { settle } = mountEditor([{ key: "OLD_VAR", value: "token" }]);

    fireEvent.click(screen.getByRole("button", { name: "Remove OLD_VAR" }));
    await settle("refused");

    expect(screen.getByLabelText("Value for OLD_VAR")).toHaveProperty(
      "value",
      "token",
    );
    expect(screen.getByRole("button", { name: "Remove OLD_VAR" })).toBeTruthy();
    expect(screen.queryByText(/removing/i)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "The host refused this change.",
    );
  });
});
