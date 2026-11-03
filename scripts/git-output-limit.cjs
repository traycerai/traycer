"use strict";

/**
 * The `maxBuffer` of every Node child process that runs `git` and keeps its
 * output. Node's default is 1 MiB, and a listing of this repository
 * (`git ls-files`, `git diff`, `git log`) grows with it: `git ls-files -z`
 * read 858,984 bytes on 2026-11-03, three times its size in August, and the
 * same listing in the internal repository had already crossed 1 MiB and
 * failed its source scans with ENOBUFS. Node grows the buffer as output
 * arrives, so a high limit costs nothing until a run uses it.
 * `scripts/__tests__/git-output-max-buffer.test.mjs` holds every such call to
 * this constant.
 */
const GIT_OUTPUT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

module.exports = { GIT_OUTPUT_MAX_BUFFER_BYTES };
