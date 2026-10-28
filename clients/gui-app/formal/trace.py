#!/usr/bin/env python3
"""Prints a ChatScroll counterexample one line per step: the action, then the
viewport, the follow state and what is in flight.

Usage: formal/trace.py <TLC output file>
"""
import re
import sys


def parse(text):
    """Parses a TLC value (records, tuples, sets, ints, strings, booleans)."""
    pos = 0

    def ws():
        nonlocal pos
        while pos < len(text) and text[pos].isspace():
            pos += 1

    def value():
        nonlocal pos
        ws()
        c = text[pos]
        if text.startswith("<<", pos):
            pos += 2
            items = []
            ws()
            while not text.startswith(">>", pos):
                items.append(value())
                ws()
                if text[pos] == ",":
                    pos += 1
                ws()
            pos += 2
            return items
        if c == "[":
            pos += 1
            rec = {}
            ws()
            while text[pos] != "]":
                m = re.compile(r"\s*(\w+)\s*\|->").match(text, pos)
                pos = m.end()
                rec[m.group(1)] = value()
                ws()
                if text[pos] == ",":
                    pos += 1
                ws()
            pos += 1
            return rec
        if c == "{":
            pos += 1
            items = []
            ws()
            while text[pos] != "}":
                items.append(value())
                ws()
                if text[pos] == ",":
                    pos += 1
                ws()
            pos += 1
            return set(map(str, items))
        if c == '"':
            end = text.index('"', pos + 1)
            s = text[pos + 1 : end]
            pos = end + 1
            return s
        m = re.compile(r"-?\d+|TRUE|FALSE").match(text, pos)
        pos = m.end()
        tok = m.group(0)
        return tok == "TRUE" if tok in ("TRUE", "FALSE") else int(tok)

    return value()


def states(text):
    blocks = re.split(r"^State (\d+): <([^\n]*)>\n", text, flags=re.M)
    for i in range(1, len(blocks) - 2, 3):
        body = blocks[i + 2].split("\n\n")[0]
        values, key = {}, None
        for line in body.splitlines():
            m = re.match(r"^/\\ (\w+) = (.*)$", line)
            if m:
                key = m.group(1)
                values[key] = m.group(2)
            elif key is not None:
                values[key] += " " + line.strip()
        yield {k: parse(v) for k, v in values.items()}


def geometry(w):
    sz = w["sz"]
    lo, hi = w["lo"], w["hi"]
    tops, acc = {}, 0
    for i in range(lo, hi + 1):
        tops[i] = acc
        acc += sz[i - 1]
    return tops, acc


def describe(w, intent):
    if not w["mounted"]:
        return "unmounted"
    tops, h = geometry(w)
    vh = w["V"]
    maxs = max(0, h - 2) if vh == 0 else max(0, h - vh)
    s = w["s"]
    rows = []
    for i in range(w["lo"], w["hi"] + 1):
        mark = "" if w["sz"][i - 1] == w["real"][i - 1] else f"~{w['real'][i-1]}"
        rows.append(f"r{i}@{tops[i]}:{w['sz'][i-1]}{mark}")
    at_bottom = vh > 0 and s >= maxs
    parts = [
        f"s={s}/{maxs}{' BOTTOM' if at_bottom else ''}",
        f"V={vh}",
        "rows " + " ".join(rows),
        f"mode={w['mode']} perm={'T' if w['perm'] else 'F'} pill={'T' if w['pill'] else 'F'}",
        f"arm={w['armed']['src']}",
    ]
    if w["corr"]["on"]:
        parts.append(f"corr(att {w['corr']['att']}, {w['corr']['stage']})")
    if w["cmd"]["k"] != "none":
        c = w["cmd"]
        parts.append(f"cmd={c['k']}#{c['tok']}{' anim' if c['anim'] else ''}:{c['ph']}")
    if w["nav"]["k"] != "none":
        n = w["nav"]
        parts.append(f"nav={n['k']}/{n['pol']} r{n['row']} {n['ph']} ret{n['ret']} #{n['tok']}")
    if w["smooth"] != -1:
        parts.append(f"smooth->{w['smooth']}")
    flags = [f for f in ("dirty", "send", "settling", "ro", "hydFx", "structUnsettled", "finger", "gate") if w.get(f)]
    if w["pendHyd"]:
        flags.append(f"pendHyd=r{w['pendHyd']}")
    if w["pendMeas"]["on"]:
        flags.append(f"pendMeas=r{w['pendMeas']['row']}")
    if w["pendEnd"]:
        flags.append(f"pendEnd=#{w['pendEnd']}")
    if w["deferred"] != -1:
        flags.append(f"deferred={w['deferred']}")
    if w["flingDir"]:
        flags.append(f"fling{w['flingDir']:+d}")
    if flags:
        parts.append("{" + ",".join(flags) + "}")
    st = w["store"]
    parts.append(
        "store=" + ("-" if not st["on"] else (st["mode"] if st["mode"] == "follow" else f"free r{st['anchor']}{st['off']:+d}"))
    )
    parts.append(f"intent={intent['k']}" + (f" r{intent['row']}{intent['off']:+d}" if intent["k"] in ("at", "nav") else ""))
    return "  ".join(parts)


def main(path):
    text = open(path).read()
    head = re.search(r"Error: (Invariant \w+ is violated)", text)
    if head is None:
        print("no counterexample in", path)
        return
    print(head.group(1))
    for n, st in enumerate(states(text), 1):
        print(f"{n:2} {st['last']:<22} {describe(st['w'], st['intent'])}")


if __name__ == "__main__":
    main(sys.argv[1])
