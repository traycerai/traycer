import { buildProgram } from "../../../src/index";
import commands from "../commands.cjs";

for (const [argv, path] of [
  [commands.serviceStart, ["host", "service", "start"]],
  [commands.restart, ["host", "restart"]],
  [
    [...commands.supervisor, "host", "capabilities", "--has", "service-label"],
    ["host", "capabilities"],
  ],
  [
    [
      ...commands.supervisor,
      "host",
      "adoption-nonce",
      "--service-label",
      "ai.traycer.host.dev",
    ],
    ["host", "adoption-nonce"],
  ],
  [
    [
      ...commands.supervisor,
      "host",
      "start",
      "--service-label",
      "ai.traycer.host.dev",
      "--adoption-nonce",
      "c3349888-373c-47cd-ab5a-0b415dc54dbd",
    ],
    ["host", "start"],
  ],
] as const) {
  const program = buildProgram().exitOverride();
  let leaf = program;
  for (const name of path) {
    const next = leaf.commands.find((command) => command.name() === name);
    if (next === undefined) throw new Error(`Missing CLI command: ${name}`);
    leaf = next;
  }
  let parsed = false;
  leaf.action(() => {
    parsed = true;
  });
  await program.parseAsync(argv, { from: "user" });
  if (!parsed)
    throw new Error(`The proof CLI arguments did not parse: ${path.join(" ")}`);
}
console.log("Proof CLI commands parse");
