#!/usr/bin/env bash
# Local scenarios for publish-cws.sh. The stubbed curl and gh never reach any
# network endpoint; no Chrome Web Store state is read or changed.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/.github/scripts/publish-cws.sh"
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

mkdir -p "$work/bin" "$work/case"
export FIXTURE_DIR="$work/case"
export CWS_ACCESS_TOKEN="fixture-token"
export CWS_WIF_PROVIDER="projects/123456789/locations/global/workloadIdentityPools/github/providers/-github"
export CWS_SERVICE_ACCOUNT="cws@example.iam.gserviceaccount.com"
export CWS_EXTENSION_ID="abcdefghijklmnopabcdefghijklmnop"
export CWS_PUBLISHER_ID="publisher-1234"
export GITHUB_EVENT_NAME="workflow_dispatch"
export GITHUB_REF="refs/heads/master"
export GH_REPO="shixiaogaoya/MicrosoftRewardsWebsite"
export GH_TOKEN="fixture"
export RUNNER_TEMP="$work"
export CWS_UPLOAD_POLL_ATTEMPTS="2"
export CWS_UPLOAD_POLL_SECONDS="0"

# The local jq.exe writes CRLF; GitHub's Linux runners do not, so strip CR here
# to keep the fixtures byte-identical to the real environment. A host without
# any jq (a bare WSL, or a Git Bash without it — the local gates run there)
# falls back to the checked-in python implementation of exactly the
# expressions the script under test uses.
cat > "$work/bin/jq" <<EOF
#!/usr/bin/env bash
set -o pipefail
if [[ -n "\${FIXTURE_JQ:-}" ]]; then
  "\$FIXTURE_JQ" "\$@" | tr -d '\r'
else
  "\$PYTHON" "$root/.github/scripts/jq-fallback.py" "\$@" | tr -d '\r'
fi
EOF

# The script under test reads its manifest through a bare `python` heredoc, and
# the interpreter chosen above may answer only to python3. A shim in the same
# bin the stubs live in — the PATH prefix the fixtures already use to intercept
# gh — answers that name, so the fixtures and the script run the same one.
cat > "$work/bin/python" <<EOF
#!/usr/bin/env bash
exec "$PYTHON" "\$@"
EOF

make_zip() {
  local version="$1" path="$2" name="${3:-manifest.json}"
  "$PYTHON" - "$version" "$path" "$name" <<'PY'
import json, sys, zipfile
version, path, name = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr(name, json.dumps({"manifest_version": 3, "version": version}))
PY
}

# --- curl stub -------------------------------------------------------------
# Records each request and answers from files under $FIXTURE_DIR/curl.
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out="" status_var=""
url="" method="GET" body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -X) method="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    --data-binary) body="${2#@}"; shift 2 ;;
    -T) body="$2"; shift 2 ;;
    -H|--header) shift 2 ;;
    -sS|-s) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s %s\n' "$method" "$url" >> "$FIXTURE_DIR/curl.log"
if [[ -f "$FIXTURE_DIR/curl/network-failure" ]]; then
  exit 7
fi
if [[ "$method" == "POST" && "$url" == *":publish" ]]; then
  cp "$body" "$FIXTURE_DIR/publish-request.json"
  [[ "$url" == *"/v2/publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop:publish" ]] || exit 9
  cat "$FIXTURE_DIR/curl/publish-body" > "$out"
  cat "$FIXTURE_DIR/curl/publish-status"
  exit 0
fi
if [[ "$method" == "POST" && "$url" == *":upload" ]]; then
  [[ -s "$body" ]] || exit 9
  cp "$body" "$FIXTURE_DIR/uploaded.zip"
  [[ "$url" == *"/upload/v2/publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop:upload" ]] || exit 9
  cat "$FIXTURE_DIR/curl/upload-body" > "$out"
  cat "$FIXTURE_DIR/curl/upload-status"
  exit 0
fi
if [[ "$method" == "GET" && "$url" == *":fetchStatus" ]]; then
  [[ "$url" == *"/v2/publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop:fetchStatus" ]] || exit 9
  count=$(( $(cat "$FIXTURE_DIR/status-count" 2>/dev/null || echo 0) + 1 ))
  echo "$count" > "$FIXTURE_DIR/status-count"
  # A numbered body/status overrides the default, so polls can change state.
  if [[ -f "$FIXTURE_DIR/curl/fetch-status-$count" ]]; then
    cat "$FIXTURE_DIR/curl/fetch-body-$count" > "$out"
    cat "$FIXTURE_DIR/curl/fetch-status-$count"
  else
    cat "$FIXTURE_DIR/curl/fetch-body" > "$out"
    cat "$FIXTURE_DIR/curl/fetch-status"
  fi
  exit 0
fi
echo "unexpected curl: $method $url" >&2
exit 1
EOF

# --- gh stub ---------------------------------------------------------------
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_DIR/gh.log"
[[ "${1:-}" == "api" || "${1:-}" == "release" && "${2:-}" == "download" ]] || { echo "unexpected gh: $*" >&2; exit 1; }
if [[ "$1" == "api" ]]; then
  shift
  include=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --silent) shift ;;
      -i) include=1; shift ;;
      *) path="$1"; shift ;;
    esac
  done
  code="$(cat "$FIXTURE_DIR/release-status")"
  if [[ "$include" == "1" ]]; then
    printf 'HTTP/2 %s \r\n\r\n' "$code"
    [[ "$code" == "200" ]] || exit 1
    exit 0
  fi
  [[ "$code" == "200" ]] || exit 1
  cat "$FIXTURE_DIR/release.json"
  exit 0
fi
if [[ "$1" == "release" && "$2" == "download" ]]; then
  tag="$3"
  [[ "$tag" == "${RELEASE_TAG:-}" ]] || exit 8
  dir=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --dir) dir="$2"; shift 2 ;; *) shift ;; esac
  done
  [[ -n "$dir" ]] || exit 8
  cp "$FIXTURE_DIR/zip/"*-chrome.zip "$dir/"
  exit 0
fi
EOF

chmod +x "$work/bin/jq" "$work/bin/curl" "$work/bin/gh" "$work/bin/python"

# --- helpers ---------------------------------------------------------------
reset_case() {
  rm -rf "$work/case"
  mkdir -p "$work/case/curl" "$work/case/zip"
  : > "$work/case/curl.log"
  : > "$work/case/gh.log"
  printf '%s' '{"tag_name":"v3.1.3","draft":false,"prerelease":false}' > "$work/case/release.json"
  printf '%s\n' "200" > "$work/case/release-status"
  printf '%s\n' "200" > "$work/case/curl/fetch-status"
  printf '%s' '{"name":"publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop","itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.2","deployPercentage":100}]},"lastAsyncUploadState":"SUCCEEDED"}' \
    > "$work/case/curl/fetch-body"
  printf '%s\n' "200" > "$work/case/curl/upload-status"
  printf '%s' '{"name":"publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop","itemId":"abcdefghijklmnopabcdefghijklmnop","crxVersion":"3.1.3","uploadState":"SUCCEEDED"}' \
    > "$work/case/curl/upload-body"
  printf '%s\n' "200" > "$work/case/curl/publish-status"
  printf '%s' '{"name":"publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop","itemId":"abcdefghijklmnopabcdefghijklmnop","state":"PENDING_REVIEW"}' \
    > "$work/case/curl/publish-body"
  make_zip 3.1.3 "$work/case/zip/rewards-3.1.3-chrome.zip"
}

run() {
  local action="$1"
  local status=0
  ( cd "$work/case" && PATH="$work/bin:$PATH" GITHUB_STEP_SUMMARY="$work/case/summary.md" \
      bash "$script" "$action" > "$work/case/stdout" 2> "$work/case/stderr" ) || status=$?
  printf '%s\n' "$status" > "$work/case/status"
}

summary() { cat "$work/case/summary.md" 2>/dev/null || true; }
stdout() { cat "$work/case/stdout" 2>/dev/null || true; }
stderr() { cat "$work/case/stderr" 2>/dev/null || true; }

expect_fail() {
  local name="$1" pattern="$2"
  local status; status="$(cat "$work/case/status")"
  local text; text="$(summary)
$(stderr)
$(stdout)"
  if [[ "$status" == "0" ]]; then
    echo "FAIL $name: expected failure, got success"
    echo "$text"
    exit 1
  fi
  if [[ -n "$pattern" && "$text" != *"$pattern"* ]]; then
    echo "FAIL $name: output does not contain: $pattern"
    echo "$text"
    exit 1
  fi
  if grep -q "$CWS_ACCESS_TOKEN" "$work/case/summary.md" "$work/case/stdout" "$work/case/stderr" 2>/dev/null; then
    echo "FAIL $name: access token leaked into output"
    exit 1
  fi
  echo "PASS $name (exit=$status)"
}

expect_ok() {
  local name="$1"
  local status; status="$(cat "$work/case/status")"
  if [[ "$status" != "0" ]]; then
    echo "FAIL $name: expected success, got exit $status"
    echo "--- summary ---"; summary
    echo "--- stdout ---"; stdout
    echo "--- stderr ---"; stderr
    echo "--- curl log ---"; cat "$work/case/curl.log"
    exit 1
  fi
  if grep -q "$CWS_ACCESS_TOKEN" "$work/case/summary.md" "$work/case/stdout" "$work/case/stderr" 2>/dev/null; then
    echo "FAIL $name: access token leaked into output"
    exit 1
  fi
  echo "PASS $name"
}

# --- scenarios -------------------------------------------------------------

# 1. check: reads status only.
reset_case
MODE=check run check
expect_ok "check-reads-status"
case "$(cat "$work/case/summary.md")" in
  *"扩展 ID：abcdefghijklmnopabcdefghijklmnop"*"已发布版本：3.1.2"*"PUBLISHED"*) ;;
  *) echo "FAIL check summary content"; cat "$work/case/summary.md"; exit 1 ;;
esac
[[ "$(grep -c '^GET ' "$work/case/curl.log")" == "1" ]] || { echo "FAIL check should issue exactly one GET"; cat "$work/case/curl.log"; exit 1; }
! grep -qE '^(POST|PUT|DELETE|PATCH) ' "$work/case/curl.log" || { echo "FAIL check issued a write request"; cat "$work/case/curl.log"; exit 1; }
echo "PASS check-made-no-write-requests"

# 2. check with API permission failure must not look like "not published".
reset_case
printf '%s\n' "403" > "$work/case/curl/fetch-status"
printf '%s' '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"The caller does not have permission"}}' > "$work/case/curl/fetch-body"
MODE=check run check
expect_fail "check-permission-denied" "认证或权限失败"
grep -q "已发布版本：未发布" "$work/case/summary.md" && { echo "FAIL permission error claimed not published"; exit 1; }
echo "PASS check-permission-error-not-treated-as-unpublished"

# 3. check with 404 must be an explicit configuration error.
reset_case
printf '%s\n' "404" > "$work/case/curl/fetch-status"
printf '%s' '{"error":{"code":404,"status":"NOT_FOUND","message":"Item not found"}}' > "$work/case/curl/fetch-body"
MODE=check run check
expect_fail "check-not-found" "404"

# 4. check with network failure must fail, not report missing item.
reset_case
touch "$work/case/curl/network-failure"
MODE=check run check
expect_fail "check-network-error" "网络或 TLS 错误"
if grep -q "已发布版本：未发布" "$work/case/summary.md" 2>/dev/null; then
  echo "FAIL network error claimed not published"; exit 1
fi

# 5. missing variables fail before any request is made.
reset_case
( cd "$work/case" && PATH="$work/bin:$PATH" GITHUB_STEP_SUMMARY="$work/case/summary.md" \
    MODE=check CWS_PUBLISHER_ID= bash "$script" preflight > "$work/case/stdout" 2> "$work/case/stderr" ) || printf '%s\n' "$?" > "$work/case/status"
expect_fail "preflight-missing-variable" "CWS_PUBLISHER_ID"
[[ ! -s "$work/case/curl.log" ]] || { echo "FAIL preflight issued a request"; cat "$work/case/curl.log"; exit 1; }

# 6. the provider ID keeps its leading hyphen; an invalid resource name fails.
reset_case
provider_status=0
( cd "$work/case" && PATH="$work/bin:$PATH" GITHUB_STEP_SUMMARY="$work/case/summary.md" \
    MODE=check bash "$script" preflight > "$work/case/stdout" 2> "$work/case/stderr" ) || provider_status=$?
[[ "$provider_status" == "0" ]] || { echo "FAIL provider ending in -github was rejected"; cat "$work/case/stderr"; exit 1; }
echo "PASS provider-leading-hyphen-accepted"

reset_case
( cd "$work/case" && PATH="$work/bin:$PATH" GITHUB_STEP_SUMMARY="$work/case/summary.md" \
    MODE=check CWS_WIF_PROVIDER="projects/1/locations/global/workloadIdentityPools/p/publishers/github" \
    bash "$script" preflight > "$work/case/stdout" 2> "$work/case/stderr" ) || printf '%s\n' "$?" > "$work/case/status"
expect_fail "preflight-rejects-invalid-provider-shape" "CWS_WIF_PROVIDER"

# 7. submit without release_tag.
reset_case
MODE=submit RELEASE_TAG= run submit
expect_fail "submit-requires-release-tag" "release_tag"

# 8. submit with a prerelease tag is rejected before touching the store.
reset_case
MODE=submit RELEASE_TAG=v3.1.3-beta.1 run submit
expect_fail "submit-rejects-prerelease-tag" "正式版本标签"

# 9. submit from a missing Release never reaches the store.
reset_case
printf '%s\n' "404" > "$work/case/release-status"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-missing-release" "不存在"
[[ ! -s "$work/case/curl.log" ]] || { echo "FAIL store was contacted for a missing release"; cat "$work/case/curl.log"; exit 1; }
echo "PASS submit-missing-release-no-store-call"

# 10. submit with a Release that has no Chrome ZIP fails before the store.
reset_case
rm -f "$work/case/zip/"*-chrome.zip
make_zip 3.1.3 "$work/case/zip/rewards-3.1.3-firefox.zip"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-missing-chrome-zip" "Chrome ZIP"
[[ ! -s "$work/case/curl.log" ]] || { echo "FAIL store was contacted without a ZIP"; exit 1; }
echo "PASS submit-missing-zip-no-store-call"

# 11. manifest version must match the tag.
reset_case
rm -f "$work/case/zip/"*-chrome.zip
make_zip 3.1.2 "$work/case/zip/rewards-3.1.3-chrome.zip"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-tag-manifest-mismatch" "不一致"

# 12. ZIP whose manifest is not at the root.
reset_case
rm -f "$work/case/zip/"*-chrome.zip
make_zip 3.1.3 "$work/case/zip/rewards-3.1.3-chrome.zip" "nested/manifest.json"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-manifest-not-at-root" "manifest.json"

# 13. draft Release is rejected.
reset_case
printf '%s' '{"tag_name":"v3.1.3","draft":true,"prerelease":false}' > "$work/case/release.json"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-draft-release" "草稿"

# 14. the same version in review is already submitted; reruns do not write.
reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.2"}]},"submittedItemRevisionStatus":{"state":"PENDING_REVIEW","distributionChannels":[{"crxVersion":"3.1.3"}]}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "submit-skips-same-version-pending-review"
! grep -q '^POST ' "$work/case/curl.log" || { echo "FAIL write attempted during same-version review"; exit 1; }
grep -q 'PENDING_REVIEW' "$work/case/summary.md" || { echo "FAIL existing review status missing"; exit 1; }
echo "PASS submit-no-writes-during-same-version-review"

reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","submittedItemRevisionStatus":{"state":"PENDING_REVIEW","distributionChannels":[{"crxVersion":"3.1.4"}]}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-blocked-by-other-pending-review" "正在审核"
! grep -q '^POST ' "$work/case/curl.log" || { echo "FAIL write attempted during another review"; exit 1; }

reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","submittedItemRevisionStatus":{"state":"PENDING_REVIEW"}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-blocked-by-unknown-pending-review-version" "正在审核"
! grep -q '^POST ' "$work/case/curl.log" || { echo "FAIL write attempted for unknown review version"; exit 1; }

# 15. the same version already published is a successful no-op.
reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.3"}]}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "submit-skips-published-same-version"
! grep -q '^POST ' "$work/case/curl.log" || { echo "FAIL write attempted for published version"; exit 1; }

reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED_TO_TESTERS","distributionChannels":[{"crxVersion":"3.1.3"}]}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "submit-skips-same-version-published-to-testers"
! grep -q '^POST ' "$work/case/curl.log" || { echo "FAIL write attempted for tester version"; exit 1; }

# 16. another version staged blocks overwriting.
reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.2"}]},"submittedItemRevisionStatus":{"state":"STAGED","distributionChannels":[{"crxVersion":"3.1.4"}]}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-blocked-by-other-staged" "STAGED"

# 17. a same-version staged revision is left ready for manual public launch.
reset_case
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.2"}]},"submittedItemRevisionStatus":{"state":"STAGED","distributionChannels":[{"crxVersion":"3.1.3"}]}}' \
  > "$work/case/curl/fetch-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "submit-skips-staged-same-version"
! grep -q '^POST ' "$work/case/curl.log" || { echo "FAIL write attempted for staged version"; exit 1; }
grep -q '等待手动上线' "$work/case/summary.md" || { echo "FAIL staged next step missing"; exit 1; }
echo "PASS submit-staged-ready-without-writes"

# 18. successful upload then publish with the exact payload.
reset_case
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "submit-upload-and-publish"
[[ "$(cat "$work/case/publish-request.json")" == '{"publishType":"DEFAULT_PUBLISH","skipReview":false,"blockOnWarnings":true}' ]] \
  || { echo "FAIL publish payload"; cat "$work/case/publish-request.json"; exit 1; }
echo "PASS publish-payload-exact"
[[ -s "$work/case/uploaded.zip" ]] || { echo "FAIL uploaded ZIP missing"; exit 1; }
echo "PASS uploaded-downloaded-zip"

# 19. upload IN_PROGRESS then SUCCEEDED via polling, then publish.
# The pre-check sees a settled store; only the poll responses report progress.
reset_case
printf '%s' '{"name":"publishers/publisher-1234/items/abcdefghijklmnopabcdefghijklmnop","uploadState":"IN_PROGRESS"}' \
  > "$work/case/curl/upload-body"
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.2"}]},"lastAsyncUploadState":"IN_PROGRESS"}' \
  > "$work/case/curl/fetch-body-2"
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","publishedItemRevisionStatus":{"state":"PUBLISHED","distributionChannels":[{"crxVersion":"3.1.2"}]},"lastAsyncUploadState":"SUCCEEDED"}' \
  > "$work/case/curl/fetch-body-3"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "submit-polls-until-upload-succeeds"
grep -q "轮询确认" "$work/case/summary.md" || { echo "FAIL poll result not reported"; cat "$work/case/summary.md"; exit 1; }
grep -q ':publish' "$work/case/curl.log" || { echo "FAIL publish missing after poll"; exit 1; }
echo "PASS poll-before-publish"

# 20. upload never confirms -> no publish.
reset_case
printf '%s' '{"uploadState":"IN_PROGRESS"}' > "$work/case/curl/upload-body"
for n in 2 3; do
  printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","lastAsyncUploadState":"IN_PROGRESS"}' \
    > "$work/case/curl/fetch-body-$n"
  printf '%s\n' "200" > "$work/case/curl/fetch-status-$n"
done
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-poll-timeout" "仍未确认成功"
! grep -q ':publish' "$work/case/curl.log" || { echo "FAIL published despite unfinished upload"; exit 1; }
echo "PASS no-publish-after-poll-timeout"

# 21. async upload FAILED -> no publish.
reset_case
printf '%s' '{"uploadState":"IN_PROGRESS"}' > "$work/case/curl/upload-body"
printf '%s' '{"itemId":"abcdefghijklmnopabcdefghijklmnop","lastAsyncUploadState":"FAILED"}' \
  > "$work/case/curl/fetch-body-2"
printf '%s\n' "200" > "$work/case/curl/fetch-status-2"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-poll-failed" "上传失败"
! grep -q ':publish' "$work/case/curl.log" || { echo "FAIL published after failed upload"; exit 1; }
echo "PASS no-publish-after-failed-upload"

# 22. immediate upload FAILED -> no publish.
reset_case
printf '%s' '{"uploadState":"FAILED"}' > "$work/case/curl/upload-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-upload-failed" "上传失败"
! grep -q ':publish' "$work/case/curl.log" || { echo "FAIL published after failed upload"; exit 1; }
echo "PASS no-publish-on-upload-failure"

# 23. upload version mismatch -> no publish.
reset_case
printf '%s' '{"uploadState":"SUCCEEDED","crxVersion":"9.9.9"}' > "$work/case/curl/upload-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-upload-version-mismatch" "不一致"

# 24. publish rejected by validation -> explicit error, no success summary.
reset_case
printf '%s\n' "400" > "$work/case/curl/publish-status"
printf '%s' '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Item validation failed","details":[{"warnings":[{"reason":"PERMISSIONS","description":"Excessive permissions"}]}]}}' \
  > "$work/case/curl/publish-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-publish-validation-error" "提审失败"
grep -q "Excessive permissions" "$work/case/summary.md" || { echo "FAIL warning detail missing"; cat "$work/case/summary.md"; exit 1; }
echo "PASS publish-error-reports-warnings"

# 25. publish response without a recognizable state is not reported as submitted.
reset_case
printf '%s' '{}' > "$work/case/curl/publish-body"
MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "submit-publish-state-missing" "不能确认已提交"

# 26. non-master branch fails before authentication.
reset_case
( cd "$work/case" && PATH="$work/bin:$PATH" GITHUB_STEP_SUMMARY="$work/case/summary.md" \
    GITHUB_REF="refs/heads/feature" MODE=check bash "$script" check > "$work/case/stdout" 2> "$work/case/stderr" ) || printf '%s\n' "$?" > "$work/case/status"
expect_fail "check-requires-master" "master"
[[ ! -s "$work/case/curl.log" ]] || { echo "FAIL store contacted from non-master"; exit 1; }
echo "PASS non-master-no-store-call"

# 27. missing token after authentication step.
reset_case
( cd "$work/case" && PATH="$work/bin:$PATH" GITHUB_STEP_SUMMARY="$work/case/summary.md" \
    CWS_ACCESS_TOKEN= MODE=check bash "$script" check > "$work/case/stdout" 2> "$work/case/stderr" ) || printf '%s\n' "$?" > "$work/case/status"
expect_fail "check-missing-token" "访问令牌"

# 28. token never printed on a successful store read.
reset_case
MODE=check run check
expect_ok "no-token-in-output"
! grep -rq "$CWS_ACCESS_TOKEN" "$work/case" --exclude=curl.log --exclude-dir=curl 2>/dev/null || { echo "FAIL token found in case files"; exit 1; }
echo "PASS no-token-stored-in-output"

# 29. A reusable workflow inherits push from its master caller.
reset_case
GITHUB_EVENT_NAME=push MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_ok "master-push-submit"
[[ -f "$work/case/uploaded.zip" && -f "$work/case/publish-request.json" ]] || { echo "FAIL master push did not upload and submit"; exit 1; }
echo "PASS master-push-upload-and-submit"

# 30. Pull requests and tag pushes cannot reach the store.
reset_case
GITHUB_EVENT_NAME=pull_request MODE=check run check
expect_fail "reject-pull-request" "push / workflow_dispatch"
[[ ! -s "$work/case/curl.log" && ! -s "$work/case/gh.log" ]] || { echo "FAIL pull request contacted external API"; exit 1; }

reset_case
GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v3.1.3 MODE=submit RELEASE_TAG=v3.1.3 run submit
expect_fail "reject-tag-push" "master"
[[ ! -s "$work/case/curl.log" && ! -s "$work/case/gh.log" ]] || { echo "FAIL tag push contacted external API"; exit 1; }

echo "ALL LOCAL CWS SCENARIOS PASSED"
echo "--- successful submit summary ---"
reset_case
MODE=submit RELEASE_TAG=v3.1.3 run submit
cat "$work/case/summary.md"
echo "--- publish payload ---"
cat "$work/case/publish-request.json"
echo
