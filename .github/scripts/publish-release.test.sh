#!/usr/bin/env bash
# Local scenarios for publish-release.sh. The stubbed gh never reaches GitHub.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/.github/scripts/publish-release.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/repo/wxt" "$work/repo/artifacts/extension-chrome" "$work/repo/artifacts/extension-firefox"
cat > "$work/repo/wxt/package.json" <<'EOF'
{ "version": "3.1.3" }
EOF

make_zip() {
  local version="$1"
  local zip="$2"
  python - "$version" "$zip" <<'PY'
import json, sys, zipfile
version, path = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", json.dumps({"version": version, "name": "fixture"}))
PY
}

make_zip "3.1.3" "$work/repo/artifacts/extension-chrome/rewards-3.1.3-chrome.zip"
make_zip "3.1.3" "$work/repo/artifacts/extension-firefox/rewards-3.1.3-firefox.zip"

cat > "$work/bin/jq" <<'EOF'
#!/usr/bin/env bash
exec /c/Users/ming/.local/bin/jq.exe "$@"
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
echo "unexpected git invocation: $*" >&2
exit 1
EOF

chmod +x "$work/bin/jq" "$work/bin/gh" "$work/bin/git"

run_case() {
  local name="$1"
  local expected="$2"
  shift 2
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
      [[ "$status" == "0" && "$summary" == *"是否创建标签：否"* && "$summary" == *"跳过原因：无"* && ! -f "$case_dir/state/local-tag" && -f "$case_dir/state/created" ]] && ok=1
      ;;
    fail)
      [[ "$status" != "0" && "$summary" == *"发布失败"* && "$summary" != *"跳过原因：无"* && ! -f "$case_dir/state/created" && ! -f "$case_dir/state/local-tag" ]] && ok=1
      ;;
  esac
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
run_case new-version create

prepare_absent existing-release
set_state existing-release release-v3.1.3 exists
run_case existing-release skip

prepare_absent same-tag
set_state same-tag tag-v3.1.3 same
run_case same-tag reuse

prepare_absent other-tag
set_state other-tag tag-v3.1.3 other
run_case other-tag fail

prepare_absent build-failed
run_case build-failed fail \
  bash -c 'rm -f artifacts/extension-firefox/*-firefox.zip'

prepare_absent api-error
set_state api-error release-v3.1.3 503
run_case api-error fail

prepare_absent tag-query-error
set_state tag-query-error tag-v3.1.3 401
run_case tag-query-error fail

prepare_absent annotated-tag
set_state annotated-tag tag-v3.1.3 annotated
run_case annotated-tag reuse

prepare_absent prerelease
set_state prerelease tag-v3.1.3-beta.2 absent
set_state prerelease release-v3.1.3-beta.2 absent
run_case prerelease fail \
  env GITHUB_REF="refs/tags/v3.1.3-beta.2" GITHUB_REF_NAME="v3.1.3-beta.2"

prepare_absent stable-tag-mismatch
set_state stable-tag-mismatch tag-v3.1.2 absent
set_state stable-tag-mismatch release-v3.1.2 absent
run_case stable-tag-mismatch fail \
  env GITHUB_REF="refs/tags/v3.1.2" GITHUB_REF_NAME="v3.1.2"

prepare_absent manual-confirmed
run_case manual-confirmed create \
  env GITHUB_EVENT_NAME="workflow_dispatch" GITHUB_REF="refs/heads/master" CONFIRM_RELEASE="true"

prepare_absent manual-unconfirmed
run_case manual-unconfirmed fail \
  env GITHUB_EVENT_NAME="workflow_dispatch" CONFIRM_RELEASE="false"

prepare_absent raced-publish
set_state raced-publish push-v3.1.3 race
run_case raced-publish skip

# A wrong manifest version must fail before any tag or release is considered.
prepare_absent bad-manifest
run_case bad-manifest fail \
  bash -c 'python - artifacts/extension-chrome/rewards-3.1.3-chrome.zip '"'"'{"version":"9.9.9","name":"fixture"}'"'"' <<'"'"'PY'"'"'
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
