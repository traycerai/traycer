#!/usr/bin/env bash
# Runs TLC on one config: formal/check.sh <Config> [TLC args...]
# <Config> names an ordinary <Config>.cfg; companion controls use regress.py.
# Needs Java 11+ and formal/tools/tla2tools.jar (gitignored; see README.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
config="${1:?usage: check.sh <Config> [TLC args...]}"
shift
if ! grep -q '^SPECIFICATION Spec$' "$here/$config.cfg"; then
  echo "Companion controls require a recorded depth bound. Use formal/regress.py once the config is selected in expected.py." >&2
  exit 2
fi
jar="$here/tools/tla2tools.jar"
if [ ! -f "$jar" ]; then
  echo "missing $jar; fetch it with:" >&2
  echo "  gh release download v1.7.4 -R tlaplus/tlaplus -p tla2tools.jar -D $here/tools" >&2
  exit 2
fi
# macOS ships a /usr/bin/java stub that exits 0 with no runtime behind it, so
# a keg-only Homebrew JDK is preferred when present.
java_bin="${JAVA:-java}"
if [ -z "${JAVA:-}" ] && [ -x /opt/homebrew/opt/openjdk@17/bin/java ]; then
  java_bin=/opt/homebrew/opt/openjdk@17/bin/java
fi
cd "$here"
# -deadlock: a behaviour whose budgets are spent and whose tile is quiet
# stops; that is quiescence, not a deadlock.
# TLC extracts its standard modules into java.io.tmpdir. Parallel configs
# need distinct directories so one parser cannot read another's partial file.
run_dir="$here/states/$(basename "$config")"
mkdir -p "$run_dir"
exec "$java_bin" -Djava.io.tmpdir="$run_dir" -XX:+UseParallelGC -Xmx"${JAVA_XMX:-3g}" -cp "$jar" tlc2.TLC \
  -config "$config.cfg" -metadir "$here/states/$(basename "$config")" \
  -workers "${TLC_WORKERS:-2}" -deadlock "$@" ChatScroll.tla
