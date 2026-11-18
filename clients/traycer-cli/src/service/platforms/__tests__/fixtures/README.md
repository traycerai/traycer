# W1: a Scheduled Task written by an older CLI

`w1-cli-v1.1.4-task-*.xml` are the task definitions the **released
cli-v1.1.4** (`9faddaaed`) wrote, produced by EXECUTING that tag's own builder
(`buildScheduledTaskXml`, `clients/traycer-cli/src/service/platforms/windows.ts`
at blob `e8df7c79a2befd7e82a54b4e55af1381cb818a3c`) - not hand-written. That
builder names the principal by account NAME (`<domain>\<name>` from
`USERDOMAIN` + `USERNAME`, or a bare `<name>`), never by SID, which is the
shape the ownership gate has to normalise to a SID before comparing.

Regenerate from a scratch directory, never from this checkout:

```sh
git archive 9faddaaed clients/traycer-cli/src protocol/src \
  protocol/package.json clients/traycer-cli/package.json package.json \
  | tar -x -C "$SCRATCH"
# link node_modules, with @traycer/protocol pointed at the extracted protocol/
cat > "$SCRATCH/gen-w1.ts" <<'TS'
import { buildScheduledTaskXml } from "./clients/traycer-cli/src/service/platforms/windows";
import { serviceLabelFor } from "./clients/traycer-cli/src/service/label";
process.stdout.write(
  buildScheduledTaskXml({
    label: serviceLabelFor("production"),
    cli: { command: "C:\\Users\\alice\\.traycer\\cli\\bin\\traycer.exe", args: [] },
  }),
);
TS
(cd "$SCRATCH" && env USERDOMAIN=CONTOSO USERNAME=alice bun run gen-w1.ts) > w1-cli-v1.1.4-task-domain.xml
(cd "$SCRATCH" && env -u USERDOMAIN USERNAME=alice bun run gen-w1.ts) > w1-cli-v1.1.4-task-bare.xml
```

`env` matters under zsh, where `USERNAME` is a special parameter and a plain
prefix assignment is ignored.
