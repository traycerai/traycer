#!/usr/bin/env bash
# commit-msg hook: enforce the Developer Certificate of Origin locally, the same
# rule as .github/workflows/dco.yml. pre-commit passes the path to the commit
# message file as $1. The commit author's `Signed-off-by:` trailer must be
# present — add it with `git commit -s`.
set -euo pipefail

msg_file="$1"

# Merge commits carry no contributed authorship — skip them.
if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
  exit 0
fi

# Match the DCO trailer to the commit's actual author. Git exports GIT_AUTHOR_*
# into the commit-msg hook environment, so these reflect a `--author` override;
# fall back to git config when they're unset.
name="${GIT_AUTHOR_NAME:-$(git config user.name)}"
email="${GIT_AUTHOR_EMAIL:-$(git config user.email)}"
expected="Signed-off-by: ${name} <${email}>"

if grep -qixF "$expected" "$msg_file"; then
  exit 0
fi

cat >&2 <<EOF
Commit is missing its DCO sign-off trailer:

  $expected

Re-run with sign-off:  git commit -s
(amending the last commit:  git commit --amend -s)
See CONTRIBUTING.md#developer-certificate-of-origin-dco
EOF
exit 1
