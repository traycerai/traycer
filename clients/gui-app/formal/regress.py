#!/usr/bin/env python3
"""The formal regression: checks one config against its recorded result.

Usage:
  formal/regress.py --list          the configs, as a JSON array
  formal/regress.py <Config>...     check each config

The CI subset is the explicit DEPTH selection in expected.py; other configs
remain available for exploration with check.sh/run-all.sh. A selected config
is explored breadth-first to its depth in expected.py
(ChatScrollBounded.tla, or the explicitly selected T2 companion). Like
run-all.sh, each pass checks every remaining
invariant, saves the first violation's trace to
results/<Config>.<Invariant>.out, drops that invariant and runs again, until
a pass finds none. The run passes when the violations found are exactly the
ones expected.py records: one it records and the pass no longer finds means
a model change hid a bug; one it does not record is a regression.

Needs Java 11+ (JAVA, or java on PATH) and tools/tla2tools.jar; TLC_WORKERS
(default 4) and JAVA_XMX (default 6g) size the run.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from expected import CHECK_DEADLOCK, DEPTH, MODULES, VIOLATIONS  # noqa: E402


def configs():
    names = sorted(DEPTH)
    available = {f[:-4] for f in os.listdir(HERE)
                 if f.startswith("ChatScroll_") and f.endswith(".cfg")}
    stale = sorted(set(names) - available)
    unknown = sorted(set(VIOLATIONS) - set(names))
    unmapped = sorted(set(MODULES) - available)
    bad_deadlock = sorted(k for k, v in CHECK_DEADLOCK.items()
                          if k not in names or type(v) is not bool)
    if (not names or stale or unknown or unmapped or bad_deadlock
            or any(type(d) is not int or d < 2 for d in DEPTH.values())):
        sys.exit(f"invalid CI selection: missing configs {stale}, unselected expectations {unknown}, "
                 f"missing module configs {unmapped}, invalid deadlock selection {bad_deadlock}")
    return names


def invariants(cfg_text):
    block = cfg_text.split("INVARIANTS", 1)[1]
    return [line.strip() for line in block.splitlines() if line.strip()]


def tlc(config, cfg_text, invs):
    """One bounded pass. Returns (violated invariant or None, TLC output)."""
    module, spec = MODULES.get(config, ("ChatScrollBounded", "Spec"))
    if not re.search(rf"^SPECIFICATION {re.escape(spec)}$", cfg_text, re.M):
        return "TLC_FAILED", f"{config}: {module} requires SPECIFICATION {spec}\n"
    check_deadlock = CHECK_DEADLOCK.get(config, False)
    settings = re.findall(r"^[ \t]*CHECK_DEADLOCK\b([^\n]*)$", cfg_text, re.M)
    wanted = "TRUE" if check_deadlock else "FALSE"
    if (len(settings) > 1 or (check_deadlock and not settings)
            or (settings and settings[0].strip() != wanted)):
        return "TLC_FAILED", f"{config}: CHECK_DEADLOCK selection and cfg directive disagree\n"
    work = os.path.join(HERE, "states", f"{config}.regress")
    os.makedirs(work, exist_ok=True)
    head = cfg_text.split("INVARIANTS", 1)[0]
    with open(os.path.join(work, "run.cfg"), "w") as f:
        f.write(head)
        f.write(f"    MaxLevel = {DEPTH[config]}\nCONSTRAINT WithinBound\nINVARIANTS\n")
        f.write("".join(f"    {i}\n" for i in invs))
    java = os.environ.get("JAVA", "java")
    cmd = [java, f"-Djava.io.tmpdir={work}", "-XX:+UseParallelGC", f"-Xmx{os.environ.get('JAVA_XMX', '6g')}",
           "-cp", os.path.join(HERE, "tools", "tla2tools.jar"), "tlc2.TLC",
           "-config", os.path.join(work, "run.cfg"), "-metadir", os.path.join(work, "meta"),
           "-workers", os.environ.get("TLC_WORKERS", "4")]
    if not check_deadlock:
        cmd.append("-deadlock")
    cmd.append(f"{module}.tla")
    result = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    out = result.stdout + result.stderr
    shutil.rmtree(work)
    m = re.search(r"^Error: Invariant (\w+) is violated\.$", out, re.M)
    if m:
        return m.group(1), out
    if result.returncode != 0 or "Model checking completed. No error has been found" not in out:
        return "TLC_FAILED", out
    return None, out


def check(config):
    start = time.time()
    with open(os.path.join(HERE, f"{config}.cfg")) as f:
        cfg_text = f.read()
    remaining = invariants(cfg_text)
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    found = {}
    while True:
        violated, out = tlc(config, cfg_text, remaining)
        if violated == "TLC_FAILED":
            path = os.path.join(HERE, "results", f"{config}.error.out")
            open(path, "w").write(out)
            print(f"{config}: TLC failed; see {os.path.relpath(path, HERE)}")
            return False
        if violated is None:
            break
        steps = len(re.findall(r"^State \d+: ", out, re.M))
        found[violated] = steps
        open(os.path.join(HERE, "results", f"{config}.{violated}.out"), "w").write(out)
        remaining = [i for i in remaining if i != violated]
    open(os.path.join(HERE, "results", f"{config}.ok.out"), "w").write(out)
    states = re.findall(r"([\d,]+) distinct states found", out)
    depth = re.search(r"The depth of the complete state graph search is (\d+)", out)
    expected = VIOLATIONS.get(config, {})
    hidden = sorted(set(expected) - set(found))
    new = sorted(set(found) - set(expected))
    for inv, steps in found.items():
        tag = "expected" if inv in expected else "NEW"
        print(f"{config}: {inv} violated in {steps} states ({tag})")
    for inv in hidden:
        print(f"{config}: {inv} HOLDS, but expected.py records it violated: {expected[inv]}")
    print(f"{config}: the rest hold to depth {depth.group(1) if depth else '?'} "
          f"(bound {DEPTH[config]}, {states[-1] if states else '?'} distinct states), "
          f"{time.time() - start:.0f}s")
    return not hidden and not new


def main(args):
    if args == ["--list"]:
        print(json.dumps(configs()))
        return 0
    if not args:
        sys.exit(__doc__)
    known = configs()
    ok = True
    for config in args:
        if config not in known:
            sys.exit(f"no config {config}")
        ok = check(config) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
