#!/bin/sh
# Traycer host launcher. Written by 'traycer host service install'; the
# LaunchAgent plist executes this file with the CLI invocation as its
# arguments. It exists as a FILE (not an inline 'sh -c' program) so macOS
# names the login item after it instead of after /bin/sh.
"$@" host capabilities --has service-label >/dev/null 2>&1 && "$@" host capabilities --has host-start-adoption-v2 >/dev/null 2>&1 && nonce="$("$@" host adoption-nonce --service-label 'ai.traycer.host' 2>/dev/null)" && [ -n "$nonce" ] && exec "$@" host start --service-label 'ai.traycer.host' --adoption-nonce "$nonce" || "$@" host capabilities --has service-label >/dev/null 2>&1 && exec "$@" host start --service-label 'ai.traycer.host' || exec "$@" host start
