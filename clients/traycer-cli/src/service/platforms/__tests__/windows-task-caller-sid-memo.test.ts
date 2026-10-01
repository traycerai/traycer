import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The caller's SID is read from `whoami` once and kept (the account a process
// runs as cannot change under it), while the task's principal is read afresh
// for every verb. `execFileSync` is the one place `whoami` is spawned.
const whoami = vi.hoisted(() => ({
  calls: 0,
  answer: null as string | null,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: () => {
      whoami.calls += 1;
      if (whoami.answer === null) throw new Error("whoami is unavailable");
      return whoami.answer;
    },
  };
});

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("../../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../logger")>();
  const record =
    (level: string) =>
    (message: string, fields: unknown): void => {
      logged.lines.push(`${level} ${message} ${JSON.stringify(fields)}`);
    };
  return {
    ...actual,
    createCliLogger: () => ({
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    }),
  };
});

import {
  readWindowsServiceTaskOwnership,
  setWindowsAccountSidResolverForTests,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskUserSidReaderForTests,
} from "../windows";
import { serviceLabelFor } from "../../label";

const CALLER_SID = "S-1-5-21-1111-2222-3333-1001";
const label = serviceLabelFor("staging");
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function whoamiOutput(sid: string): string {
  return `"HOST\\someone","${sid}"\r\n`;
}

const TASK_XML = `<Task><Principals><Principal id="Author"><UserId>${CALLER_SID}</UserId></Principal></Principals><Actions Context="Author"><Exec><Command>x</Command></Exec></Actions></Task>`;

let queries = 0;

beforeEach(() => {
  whoami.calls = 0;
  whoami.answer = whoamiOutput(CALLER_SID);
  queries = 0;
  logged.lines.length = 0;
  Object.defineProperty(process, "platform", { value: "win32" });
  // `null` restores the real `whoami` reader and clears its memo.
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(async () => null);
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => {
      queries += 1;
      return { kind: "xml", xml: TASK_XML };
    },
    predictCli: async () => {
      throw new Error("not used");
    },
    resolveCli: async () => {
      throw new Error("not used");
    },
  });
});

afterEach(() => {
  if (originalPlatform !== undefined) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  setWindowsTaskUserSidReaderForTests(null);
  setWindowsAccountSidResolverForTests(null);
  setWindowsDefinitionDepsForTests(null);
});

describe("the ownership gate's inputs: the caller's SID is memoised, the task's principal is not", () => {
  it("two reads spawn `whoami` once and query the task twice", async () => {
    const first = await readWindowsServiceTaskOwnership(label);
    const second = await readWindowsServiceTaskOwnership(label);
    expect(first.kind).toBe("caller");
    expect(second.kind).toBe("caller");
    expect(whoami.calls).toBe(1);
    expect(queries).toBe(2);
  });

  it("a `whoami` that failed is not kept: the next read asks again, and the failed one fails closed", async () => {
    whoami.answer = null;
    const failed = await readWindowsServiceTaskOwnership(label);
    expect(failed).toMatchObject({ kind: "not-owned", reason: "unconfirmed" });
    whoami.answer = whoamiOutput(CALLER_SID);
    const recovered = await readWindowsServiceTaskOwnership(label);
    expect(recovered.kind).toBe("caller");
    expect(whoami.calls).toBe(2);
  });

  it("the memo does not carry a task's principal: a task handed to another user between two reads is refused on the second", async () => {
    const first = await readWindowsServiceTaskOwnership(label);
    expect(first.kind).toBe("caller");
    setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => {
        queries += 1;
        return {
          kind: "xml",
          xml: TASK_XML.replace(CALLER_SID, "S-1-5-21-1111-2222-3333-1002"),
        };
      },
      predictCli: async () => {
        throw new Error("not used");
      },
      resolveCli: async () => {
        throw new Error("not used");
      },
    });
    const second = await readWindowsServiceTaskOwnership(label);
    expect(second).toMatchObject({ kind: "not-owned", reason: "other-owner" });
    expect(whoami.calls).toBe(1);
  });
});
