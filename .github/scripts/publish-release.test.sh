#!/usr/bin/env bash
# Local scenarios for publish-release.sh. The stubbed gh never reaches GitHub.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/.github/scripts/publish-release.sh"
export FIXTURE_JQ="$(command -v jq)"
# Linux images ship only python3, while a Windows Git Bash usually exposes only
# `python`. A Git Bash `python3` can also be the Microsoft Store placeholder,
# which `command -v` finds but cannot run, so each candidate is verified before
# it is chosen.
PYTHON=""
for candidate in python3 python; do
  found="$(command -v "$candidate" 2>/dev/null)" || continue
  "$found" -c 'import sys' >/dev/null 2>&1 || continue
  PYTHON="$found"
  break
done
if [[ -z "$PYTHON" ]]; then
  echo "no runnable python3 or python found" >&2
  exit 1
fi
export PYTHON
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/repo/wxt" "$work/repo/artifacts/extension-chrome" "$work/repo/artifacts/extension-firefox"
cat > "$work/repo/wxt/package.json" <<'EOF'
{ "version": "3.1.3" }
EOF

make_zip() {
  local version="$1"
  local zip="$2"
  "$PYTHON" - "$version" "$zip" <<'PY'
import json, sys, zipfile
version, path = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", json.dumps({"version": version, "name": "fixture"}))
PY
}

make_zip "3.1.3" "$work/repo/artifacts/extension-chrome/rewards-3.1.3-chrome.zip"
make_zip "3.1.3" "$work/repo/artifacts/extension-firefox/rewards-3.1.3-firefox.zip"

# Prefer the host jq; when the host has none (a bare WSL or Git Bash often
# ships without it, and the local gates run there), fall back to the checked-in
# python implementation of exactly the expressions the script under test uses.
cat > "$work/bin/jq" <<EOF
#!/usr/bin/env bash
set -o pipefail
if [[ -n "\${FIXTURE_JQ:-}" ]]; then
  "\$FIXTURE_JQ" "\$@" | tr -d '\r'
else
  "\$PYTHON" "$root/.github/scripts/jq-fallback.py" "\$@" | tr -d '\r'
fi
EOF

# The script under test reads the manifest version through a bare `python`
# heredoc, and the interpreter chosen above may answer only to python3. A shim
# in the same bin the gh/jq stubs live in — the PATH prefix the fixtures already
# use to intercept gh — answers that name, so the fixtures and the script run
# the same one.
cat > "$work/bin/python" <<EOF
#!/usr/bin/env bash
exec "$PYTHON" "\$@"
EOF

cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FIXTURE_DIR}/state"
log="${FIXTURE_DIR}/gh.log"
printf '%s\n' "$*" >> "$log"

mode() { printf '%s' "$(cat "$state/$1" 2>/dev/null || true)"; }

if [[ "$1" == "api" ]]; then
  shift
  silent=0
  include=0
  jq_expr=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --silent) silent=1; shift ;;
      -i) include=1; shift ;;
      --jq) jq_expr="$2"; shift 2 ;;
      *) path="$1"; shift ;;
    esac
  done
  code="500"
  body='{"message":"fixture default"}'
  if [[ "$path" == *"/git/ref/tags/"* ]]; then
    tag="${path##*/}"
    case "$(mode "tag-${tag}")" in
      same) code=200; body="{\"object\":{\"sha\":\"${BUILD_SHA}\",\"type\":\"commit\"}}" ;;
      annotated) code=200; body='{"object":{"sha":"annotated-object","type":"tag"}}' ;;
      other) code=200; body='{"object":{"sha":"other-sha","type":"commit"}}' ;;
      absent) code=404; body='{"message":"Not Found"}' ;;
      *) code="$(mode "tag-${tag}")"; body='{"message":"query failure"}' ;;
    esac
  elif [[ "$path" == *"/git/tags/annotated-object" ]]; then
    code=200
    body="{\"object\":{\"sha\":\"${BUILD_SHA}\",\"type\":\"commit\"}}"
  elif [[ "$path" == *"/releases/tags/"* ]]; then
    tag="${path##*/}"
    case "$(mode "release-${tag}")" in
      exists) code=200; body="{\"html_url\":\"https://example.test/releases/${tag}\"}" ;;
      absent) code=404; body='{"message":"Not Found"}' ;;
      *) code="$(mode "release-${tag}")"; body='{"message":"query failure"}' ;;
    esac
  fi
  if [[ "$include" == "1" ]]; then
    printf 'HTTP/2 %s \r\n\r\n%s\n' "$code" "$body"
    [[ "$code" == "200" ]] || exit 1
    exit 0
  fi
  [[ "$code" == "200" ]] || exit 1
  if [[ -n "$jq_expr" ]]; then
    printf '%s' "$body" | jq -r "$jq_expr"
  elif [[ "$silent" == "0" ]]; then
    printf '%s\n' "$body"
  fi
  exit 0
fi

if [[ "$1" == "release" && "$2" == "create" ]]; then
  tag="$3"
  [[ " ${*} " == *" --verify-tag "* && " ${*} " == *" --target ${BUILD_SHA} "* && " ${*} " == *" --notes-from-tag "* ]] || exit 1
  [[ " ${*} " == *" artifacts/extension-chrome/"*"-chrome.zip "* && " ${*} " == *" artifacts/extension-firefox/"*"-firefox.zip "* ]] || exit 1
  # --notes-from-tag cannot work with a remote-only tag after shallow checkout.
  [[ -f "$state/local-tag" || -f "$state/fetched-tag" ]] || exit 1
  printf 'exists\n' > "$state/release-${tag}"
  printf '%s\n' "$tag" > "$state/created"
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
EOF

cat > "$work/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FIXTURE_DIR}/git.log"
if [[ "$1" == "tag" ]]; then
  [[ "$2" == "-a" && "$4" == "$BUILD_SHA" && "$5" == "-F" ]] || exit 2
  # Annotated tags record a tagger; the CI runner has no git identity, so the
  # script must supply one. Fail here the way git does when it is missing.
  [[ -n "${GIT_AUTHOR_NAME:-}" && -n "${GIT_AUTHOR_EMAIL:-}" \
     && -n "${GIT_COMMITTER_NAME:-}" && -n "${GIT_COMMITTER_EMAIL:-}" ]] || {
    echo "Committer identity unknown" >&2
    exit 128
  }
  cp "$6" "${FIXTURE_DIR}/tag-message"
  printf '%s %s\n' "$3" "$4" > "${FIXTURE_DIR}/state/local-tag"
  exit 0
fi
if [[ "$1" == "push" && "$2" == "origin" && "$3" == refs/tags/* ]]; then
  tag="${3#refs/tags/}"
  read -r name sha < "${FIXTURE_DIR}/state/local-tag"
  [[ "$name" == "$tag" && "$sha" == "$BUILD_SHA" ]] || exit 3
  if [[ "$(cat "${FIXTURE_DIR}/state/push-${tag}" 2>/dev/null || true)" == "race" ]]; then
    printf 'exists\n' > "${FIXTURE_DIR}/state/release-${tag}"
  fi
  printf 'same\n' > "${FIXTURE_DIR}/state/tag-${tag}"
  exit 0
fi
if [[ "$1" == "fetch" && "$2" == "--no-tags" && "$3" == "origin" ]]; then
  tag="${4#refs/tags/}"
  tag="${tag%%:*}"
  [[ "$4" == "refs/tags/${tag}:refs/tags/${tag}" ]] || exit 4
  printf '%s\n' "$tag" > "${FIXTURE_DIR}/state/fetched-tag"
  exit 0
fi
echo "unexpected git invocation: $*" >&2
exit 1
EOF

chmod +x "$work/bin/jq" "$work/bin/gh" "$work/bin/git" "$work/bin/python"

run_case() {
  local name="$1"
  local expected="$2"
  local expected_store_tag="$3"
  shift 3
  local case_dir="$work/cases/$name"
  local saved="$work/saved/$name"
  mkdir -p "$case_dir/state" "$saved"
  if [[ -d "$saved" ]]; then
    cp -a "$saved/." "$case_dir/state/" 2>/dev/null || true
  fi
  cp -a "$work/repo/." "$case_dir/repo"
  (
    cd "$case_dir/repo"
    export PATH="$work/bin:$PATH"
    export FIXTURE_DIR="$case_dir"
    export GITHUB_STEP_SUMMARY="$case_dir/summary.md"
    export GITHUB_OUTPUT="$case_dir/outputs"
    export BUILD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    export GH_REPO="example/rewards"
    export GH_TOKEN="fixture"
    export GITHUB_EVENT_NAME="push"
    export GITHUB_REF="refs/heads/master"
    export GITHUB_REF_NAME="master"
    export CONFIRM_RELEASE=""
    set +e
    if [[ "${1:-}" == "bash" && "${2:-}" == "-c" ]]; then
      bash -c "$3"
      setup_status=$?
    elif [[ $# -gt 0 ]]; then
      export "$@"
      setup_status=$?
    else
      setup_status=0
    fi
    if [[ "$setup_status" == "0" ]]; then
      bash "$script" > "$case_dir/stdout" 2> "$case_dir/stderr"
      status=$?
    else
      printf '%s\n' "$setup_status" > "$case_dir/status"
      exit 0
    fi
    printf '%s\n' "$status" > "$case_dir/status"
  )
  local status summary
  status="$(cat "$case_dir/status")"
  summary="$(cat "$case_dir/summary.md" 2>/dev/null || true)"
  local ok=0
  case "$expected" in
    skip)
      [[ "$status" == "0" && "$summary" == *"跳过原因："* && "$summary" != *"跳过原因：无"* && ! -f "$case_dir/state/created" ]] && ok=1
      ;;
    create)
      [[ "$status" == "0" && "$summary" == *"是否创建标签：是"* && "$summary" == *"跳过原因：无"* && -f "$case_dir/state/local-tag" ]] && ok=1
      ;;
    reuse)
      [[ "$status" == "0" && "$summary" == *"是否创建标签：否"* && "$summary" == *"跳过原因：无"* && ! -f "$case_dir/state/local-tag" && -f "$case_dir/state/fetched-tag" && -f "$case_dir/state/created" ]] && ok=1
      ;;
    fail)
      [[ "$status" != "0" && "$summary" == *"发布失败"* && "$summary" != *"跳过原因：无"* && ! -f "$case_dir/state/created" && ! -f "$case_dir/state/local-tag" ]] && ok=1
      ;;
  esac
  local store_tag
  store_tag="$(awk -F= '$1 == "store_release_tag" { tag = $2 } END { print tag }' "$case_dir/outputs")"
  [[ "$store_tag" == "$expected_store_tag" ]] || ok=0
  if [[ "$ok" != "1" ]]; then
    echo "FAIL $name (status=$status)"
    echo "$summary"
    echo "--- stderr ---"
    cat "$case_dir/stderr"
    echo "--- gh log ---"
    cat "$case_dir/gh.log" 2>/dev/null || true
    exit 1
  fi
  printf '%s\n' "$summary" > "$case_dir/accepted-summary"
  echo "PASS $name"
}

set_state() {
  local case_name="$1"
  local key="$2"
  local value="$3"
  mkdir -p "$work/saved/$case_name"
  printf '%s\n' "$value" > "$work/saved/$case_name/$key"
}

prepare_absent() {
  set_state "$1" "tag-v3.1.3" "absent"
  set_state "$1" "release-v3.1.3" "absent"
}

prepare_absent new-version
run_case new-version create v3.1.3

prepare_absent existing-release
set_state existing-release release-v3.1.3 exists
set_state existing-release tag-v3.1.3 same
run_case existing-release skip v3.1.3
[[ ! -s "$work/cases/existing-release/git.log" ]] || { echo "FAIL existing release wrote to git"; exit 1; }

prepare_absent existing-release-annotated-tag
set_state existing-release-annotated-tag release-v3.1.3 exists
set_state existing-release-annotated-tag tag-v3.1.3 annotated
run_case existing-release-annotated-tag skip v3.1.3

prepare_absent existing-release-missing-tag
set_state existing-release-missing-tag release-v3.1.3 exists
run_case existing-release-missing-tag fail ''

prepare_absent existing-release-tag-query-error
set_state existing-release-tag-query-error release-v3.1.3 exists
set_state existing-release-tag-query-error tag-v3.1.3 503
run_case existing-release-tag-query-error fail ''

# Normal master commits retain the version but no longer match its old tag.
prepare_absent existing-release-older-tag
set_state existing-release-older-tag release-v3.1.3 exists
set_state existing-release-older-tag tag-v3.1.3 other
run_case existing-release-older-tag skip ''
[[ ! -s "$work/cases/existing-release-older-tag/git.log" ]] || { echo "FAIL existing release wrote to git"; exit 1; }

prepare_absent same-tag
set_state same-tag tag-v3.1.3 same
run_case same-tag reuse v3.1.3

prepare_absent other-tag
set_state other-tag tag-v3.1.3 other
run_case other-tag fail ''

prepare_absent build-failed
run_case build-failed fail '' \
  bash -c 'rm -f artifacts/extension-firefox/*-firefox.zip'

prepare_absent api-error
set_state api-error release-v3.1.3 503
run_case api-error fail ''

prepare_absent tag-query-error
set_state tag-query-error tag-v3.1.3 401
run_case tag-query-error fail ''

prepare_absent annotated-tag
set_state annotated-tag tag-v3.1.3 annotated
run_case annotated-tag reuse v3.1.3

# Manual reruns of the same master commit also continue to store submission.
prepare_absent manual-existing-release
set_state manual-existing-release release-v3.1.3 exists
set_state manual-existing-release tag-v3.1.3 same
run_case manual-existing-release skip v3.1.3 \
  env GITHUB_EVENT_NAME="workflow_dispatch" CONFIRM_RELEASE="true"

# Tag-triggered releases, including prereleases, never request store submission.
prepare_absent stable-tag
set_state stable-tag tag-v3.1.3 same
run_case stable-tag reuse '' \
  env GITHUB_REF="refs/tags/v3.1.3" GITHUB_REF_NAME="v3.1.3"

prepare_absent prerelease-existing-tag
set_state prerelease-existing-tag tag-v3.1.3-beta.2 annotated
set_state prerelease-existing-tag release-v3.1.3-beta.2 absent
run_case prerelease-existing-tag reuse '' \
  env GITHUB_REF="refs/tags/v3.1.3-beta.2" GITHUB_REF_NAME="v3.1.3-beta.2"

prepare_absent prerelease
set_state prerelease tag-v3.1.3-beta.2 absent
set_state prerelease release-v3.1.3-beta.2 absent
run_case prerelease fail '' \
  env GITHUB_REF="refs/tags/v3.1.3-beta.2" GITHUB_REF_NAME="v3.1.3-beta.2"

prepare_absent stable-tag-mismatch
set_state stable-tag-mismatch tag-v3.1.2 absent
set_state stable-tag-mismatch release-v3.1.2 absent
run_case stable-tag-mismatch fail '' \
  env GITHUB_REF="refs/tags/v3.1.2" GITHUB_REF_NAME="v3.1.2"

prepare_absent manual-confirmed
run_case manual-confirmed create v3.1.3 \
  env GITHUB_EVENT_NAME="workflow_dispatch" GITHUB_REF="refs/heads/master" CONFIRM_RELEASE="true"

prepare_absent manual-unconfirmed
run_case manual-unconfirmed fail '' \
  env GITHUB_EVENT_NAME="workflow_dispatch" CONFIRM_RELEASE="false"

prepare_absent raced-publish
set_state raced-publish push-v3.1.3 race
run_case raced-publish skip v3.1.3

# A wrong manifest version must fail before any tag or release is considered.
prepare_absent bad-manifest
run_case bad-manifest fail '' \
  bash -c '"$PYTHON" - artifacts/extension-chrome/rewards-3.1.3-chrome.zip '"'"'{"version":"9.9.9","name":"fixture"}'"'"' <<'"'"'PY'"'"'
import json, sys, zipfile
path, payload = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", payload)
PY'

echo "ALL LOCAL SCENARIOS PASSED"
echo "--- new version summary ---"
cat "$work/cases/new-version/accepted-summary"
echo "--- tag message ---"
cat "$work/cases/new-version/tag-message"
