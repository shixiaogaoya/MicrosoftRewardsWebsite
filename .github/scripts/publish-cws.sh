#!/usr/bin/env bash
# Chrome Web Store V2 helper for manual runs and the build workflow's store job.
#
#   publish-cws.sh preflight  validate the run context and repository variables
#   publish-cws.sh check      read fetchStatus only; never uploads or publishes
#   publish-cws.sh submit     download a Release ZIP, upload it and submit it
#
# Authentication is a short-lived access token minted through WIF. The token is
# read from CWS_ACCESS_TOKEN and is never printed.
#
# submit always verifies the Release and the ZIP root manifest first. It then
# refuses to upload over an in-progress review, an in-flight upload, or a
# staged copy of a different version. The same version already in review,
# staged, or published is a successful no-op, so reruns never upload it again.
# After upload, the async state is polled for a bounded time; publish
# is only called once the store confirms the upload succeeded.
set -euo pipefail

API_ROOT="https://chromewebstore.googleapis.com"
CWS_BODY_FILE="${RUNNER_TEMP:-/tmp}/cws-api-body.$$"
CWS_PUBLISH_BODY="${RUNNER_TEMP:-/tmp}/cws-publish-request.$$"
CWS_DOWNLOAD_DIR=""
CWS_RELEASE_JSON=""

cleanup() {
  rm -f "$CWS_BODY_FILE" "$CWS_PUBLISH_BODY"
  [[ -z "$CWS_RELEASE_JSON" ]] || rm -f "$CWS_RELEASE_JSON"
  [[ -z "$CWS_DOWNLOAD_DIR" ]] || rm -rf "$CWS_DOWNLOAD_DIR"
}
trap cleanup EXIT

summary() {
  {
    echo "### Chrome Web Store"
    printf '%s\n' "$@"
  } >> "$GITHUB_STEP_SUMMARY"
}

fail() {
  echo "::error::$1" >&2
  summary "- 结果：失败" "- 原因：$1"
  exit 1
}

preflight() {
  local mode="${MODE:-}"
  local command="${1:-}"

  # Reusable workflows inherit the caller's event, including master pushes.
  [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" || "${GITHUB_EVENT_NAME:-}" == "push" ]] \
    || fail "工作流只接受 master 推送或手动运行（push / workflow_dispatch）"
  # The Google-side WIF binding only accepts this branch, so fail early rather
  # than presenting a confusing authentication error.
  [[ "${GITHUB_REF:-}" == "refs/heads/master" ]] || fail "必须从 master 分支运行；当前 ref 为 ${GITHUB_REF:-<empty>}"

  [[ "$mode" == "check" || "$mode" == "submit" ]] || fail "工作流输入 mode 必须是 check 或 submit，实际为：${mode:-<empty>}"
  if [[ -n "$command" && "$command" != "preflight" && "$mode" != "$command" ]]; then
    fail "工作流输入 mode=$mode 与脚本动作 $command 不一致"
  fi

  [[ -n "${CWS_WIF_PROVIDER:-}" ]] || fail "缺少 Repository Variable：CWS_WIF_PROVIDER"
  [[ -n "${CWS_SERVICE_ACCOUNT:-}" ]] || fail "缺少 Repository Variable：CWS_SERVICE_ACCOUNT"
  [[ -n "${CWS_EXTENSION_ID:-}" ]] || fail "缺少 Repository Variable：CWS_EXTENSION_ID"
  [[ -n "${CWS_PUBLISHER_ID:-}" ]] || fail "缺少 Repository Variable：CWS_PUBLISHER_ID"

  # Do not normalize the provider value: the real provider ID ends with
  # "providers/-github" and the leading hyphen is intentional. Only reject
  # values that cannot be a full WIF provider resource name.
  [[ "$CWS_WIF_PROVIDER" =~ ^projects/[0-9]+/locations/global/workloadIdentityPools/[A-Za-z0-9._-]+/providers/[A-Za-z0-9._-]+$ ]] \
    || fail "CWS_WIF_PROVIDER 不是完整的 projects/.../providers/... 资源名（保留原值，未做修正）"
  [[ "$CWS_SERVICE_ACCOUNT" =~ ^[^[:space:]/]+$ ]] \
    || fail "CWS_SERVICE_ACCOUNT 格式不正确"
  [[ "$CWS_EXTENSION_ID" =~ ^[a-p]{32}$ ]] \
    || fail "CWS_EXTENSION_ID 不是 32 位 Chrome 扩展 ID"
  [[ "$CWS_PUBLISHER_ID" =~ ^[A-Za-z0-9_-]{8,64}$ ]] \
    || fail "CWS_PUBLISHER_ID 格式不正确"

  if [[ "$mode" == "submit" ]]; then
    [[ -n "${RELEASE_TAG:-}" ]] || fail "submit 模式必须提供 release_tag，例如 v3.1.3"
    [[ "$RELEASE_TAG" =~ ^v[0-9]+([.][0-9]+){0,3}$ ]] \
      || fail "release_tag 必须是正式版本标签（如 v3.1.3），不支持预发布标签：$RELEASE_TAG"
  fi
}

require_token() {
  [[ -n "${CWS_ACCESS_TOKEN:-}" ]] || fail "未取得 WIF 访问令牌；请检查 CWS_WIF_PROVIDER、CWS_SERVICE_ACCOUNT 和 id-token 权限"
}

# Set CWS_STATUS and write the response body to CWS_BODY_FILE. Transport
# failures and unparseable statuses are fatal; callers decide what each HTTP
# status means. No request or response body is ever echoed here because the
# response could contain authentication-related details.
cws_request() {
  local method="$1"
  local url="$2"
  local data_file="${3:-}"
  local args=(-sS --max-time 120 -o "$CWS_BODY_FILE" -w '%{http_code}' -X "$method"
    -H "Authorization: Bearer ${CWS_ACCESS_TOKEN}")
  if [[ -n "$data_file" ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary "@${data_file}")
  fi

  local status rc=0
  status="$(curl "${args[@]}" "$url")" || rc=$?
  if [[ "$rc" != "0" ]]; then
    fail "调用 Chrome Web Store API 失败（网络或 TLS 错误，curl 退出码 ${rc}）：${url}"
  fi
  [[ "$status" =~ ^[0-9]{3}$ ]] || fail "Chrome Web Store API 返回了无法识别的 HTTP 状态：${status}"
  CWS_STATUS="$status"
}

cws_upload() {
  local zip_path="$1"
  local url="$2"
  local status rc=0
  # Simple media upload: POST the raw ZIP to the /upload endpoint.
  status="$(curl -sS --max-time 900 -o "$CWS_BODY_FILE" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${CWS_ACCESS_TOKEN}" \
    -H 'Content-Type: application/zip' \
    -T "$zip_path" "$url")" || rc=$?
  if [[ "$rc" != "0" ]]; then
    fail "上传 Chrome ZIP 失败（网络或 TLS 错误，curl 退出码 ${rc}）"
  fi
  [[ "$status" =~ ^[0-9]{3}$ ]] || fail "上传接口返回了无法识别的 HTTP 状态：${status}"
  CWS_STATUS="$status"
}

api_error_summary() {
  jq -r '
    [(.error.status // empty), (.error.message // empty)]
    | map(select(. != ""))
    | join("：")
  ' "$CWS_BODY_FILE" 2>/dev/null || true
}

api_error_warnings() {
  jq -r '
    (.error.details // [])[]?
    | (.warnings // [])[]?
    | "- " + ((.reason // "") + "：" + (.description // ""))
  ' "$CWS_BODY_FILE" 2>/dev/null || true
}

require_json() {
  jq -e . "$CWS_BODY_FILE" >/dev/null 2>&1 || fail "$1 的响应不是有效 JSON（HTTP ${CWS_STATUS}）"
}

item_state_label() {
  case "${1:-}" in
    "") printf '无' ;;
    PENDING_REVIEW) printf '审核中（PENDING_REVIEW）' ;;
    STAGED) printf '已通过审核，等待手动上线（STAGED）' ;;
    PUBLISHED) printf '已发布（PUBLISHED）' ;;
    PUBLISHED_TO_TESTERS) printf '仅发布给测试者（PUBLISHED_TO_TESTERS）' ;;
    REJECTED) printf '审核未通过（REJECTED）' ;;
    CANCELLED) printf '已取消（CANCELLED）' ;;
    *) printf '%s' "$1" ;;
  esac
}

status_url() {
  printf '%s/v2/publishers/%s/items/%s:fetchStatus' "$API_ROOT" "$CWS_PUBLISHER_ID" "$CWS_EXTENSION_ID"
}

fetch_status() {
  cws_request GET "$(status_url)"
  case "$CWS_STATUS" in
    200) ;;
    401|403)
      fail "Chrome Web Store 认证或权限失败（HTTP ${CWS_STATUS}）：$(api_error_summary)。请确认服务账号已加入发布者账号，并允许该仓库 master 通过 WIF 认证；不能据此判断“未发布”"
      ;;
    404)
      fail "Chrome Web Store 返回 HTTP 404：$(api_error_summary)。这通常表示扩展 ID 或发布者 ID 配置错误，或服务账号无权访问该条目；不能据此判断“未发布”"
      ;;
    *)
      fail "fetchStatus 失败（HTTP ${CWS_STATUS}）：$(api_error_summary)"
      ;;
  esac
  require_json "fetchStatus"

  STATUS_ITEM_ID="$(jq -r '.itemId // ""' "$CWS_BODY_FILE")"
  [[ -z "$STATUS_ITEM_ID" || "$STATUS_ITEM_ID" == "$CWS_EXTENSION_ID" ]] \
    || fail "fetchStatus 返回的条目 ID 与 CWS_EXTENSION_ID 不一致"
  PUBLISHED_STATE="$(jq -r '.publishedItemRevisionStatus.state // ""' "$CWS_BODY_FILE")"
  SUBMITTED_STATE="$(jq -r '.submittedItemRevisionStatus.state // ""' "$CWS_BODY_FILE")"
  LAST_UPLOAD_STATE="$(jq -r '.lastAsyncUploadState // ""' "$CWS_BODY_FILE")"
  TAKEN_DOWN="$(jq -r '.takenDown // false' "$CWS_BODY_FILE")"
  WARNED="$(jq -r '.warned // false' "$CWS_BODY_FILE")"
  PUBLISHED_VERSIONS_TEXT="$(jq -r '[.publishedItemRevisionStatus.distributionChannels[]? | .crxVersion // empty] | unique | join("、")' "$CWS_BODY_FILE")"
  SUBMITTED_VERSIONS_TEXT="$(jq -r '[.submittedItemRevisionStatus.distributionChannels[]? | .crxVersion // empty] | unique | join("、")' "$CWS_BODY_FILE")"
  mapfile -t PUBLISHED_VERSIONS < <(jq -r '[.publishedItemRevisionStatus.distributionChannels[]? | .crxVersion // empty] | unique | .[]' "$CWS_BODY_FILE")
  mapfile -t SUBMITTED_VERSIONS < <(jq -r '[.submittedItemRevisionStatus.distributionChannels[]? | .crxVersion // empty] | unique | .[]' "$CWS_BODY_FILE")
}

version_list_has() {
  local version="$1"
  shift
  local candidate
  for candidate in "$@"; do
    [[ "$candidate" == "$version" ]] && return 0
  done
  return 1
}

skip_existing_version() {
  local state="$1"
  summary \
    "- 模式：submit" \
    "- Release：${RELEASE_TAG}" \
    "- 结果：该版本已在商店，跳过重复上传和提审" \
    "- 商店状态：$(item_state_label "$state")" \
    "- 本次未上传、未提审、未改变商店状态"
  echo "CWS submit already satisfied: ${RELEASE_TAG} -> ${state}"
  exit 0
}

check_mode() {
  preflight check
  require_token

  fetch_status
  summary \
    "- 模式：check（只读取商店状态，未上传、未提审、未改变商店状态）" \
    "- 扩展 ID：${CWS_EXTENSION_ID}" \
    "- 发布者 ID：${CWS_PUBLISHER_ID}" \
    "- WIF 认证：已获取短期访问令牌（令牌未输出）" \
    "- 已发布版本：${PUBLISHED_VERSIONS_TEXT:-未发布}" \
    "- 已发布状态：$(item_state_label "$PUBLISHED_STATE")" \
    "- 当前提交审核状态：$(item_state_label "$SUBMITTED_STATE")${SUBMITTED_VERSIONS_TEXT:+（版本 ${SUBMITTED_VERSIONS_TEXT}）}" \
    "- 最近上传状态：${LAST_UPLOAD_STATE:-无}" \
    "- 商店标记：warned=${WARNED}，takenDown=${TAKEN_DOWN}"
  echo "CWS check completed: published=${PUBLISHED_VERSIONS_TEXT:-none} submitted=${SUBMITTED_STATE:-none}"
}

github_status() {
  local path="$1"
  local response
  response="$(gh api --silent -i "$path" 2>&1 || true)"
  GITHUB_STATUS="$(printf '%s\n' "$response" | tr -d '\r' | awk 'BEGIN { code = "" } /^HTTP\// { code = $2 } END { print code }')"
  if [[ ! "$GITHUB_STATUS" =~ ^[0-9]{3}$ ]]; then
    fail "GitHub API 查询失败，不能判断 Release 是否存在：$path"
  fi
}

read_zip_manifest() {
  local zip_path="$1"
  python - "$zip_path" <<'PY'
import json
import sys
import zipfile

path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    if "manifest.json" not in archive.namelist():
        raise SystemExit(2)
    try:
        manifest = json.load(archive.open("manifest.json"))
    except ValueError:
        raise SystemExit(3)
print(manifest.get("manifest_version", ""))
print(manifest.get("version", ""))
PY
}

submit_mode() {
  preflight submit
  require_token

  local release_api="repos/${GH_REPO}/releases/tags/${RELEASE_TAG}"
  CWS_RELEASE_JSON="${RUNNER_TEMP:-/tmp}/cws-release-${RELEASE_TAG}.$$.json"
  CWS_DOWNLOAD_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/cws-release.XXXXXX")"
  local release_json="$CWS_RELEASE_JSON"
  local download_dir="$CWS_DOWNLOAD_DIR"

  github_status "$release_api"
  case "$GITHUB_STATUS" in
    200) ;;
    404) fail "GitHub Release ${RELEASE_TAG} 不存在，不能上传" ;;
    401|403) fail "读取 GitHub Release ${RELEASE_TAG} 失败（HTTP ${GITHUB_STATUS}），不能把它当作不存在" ;;
    *) fail "查询 GitHub Release ${RELEASE_TAG} 返回 HTTP ${GITHUB_STATUS}，不能继续" ;;
  esac
  if ! gh api "$release_api" > "$release_json" 2>/dev/null; then
    fail "无法读取 GitHub Release ${RELEASE_TAG} 的元数据"
  fi
  [[ "$(jq -r '.tag_name // ""' "$release_json")" == "$RELEASE_TAG" ]] \
    || fail "Release 标签与输入不一致：期望 ${RELEASE_TAG}"
  [[ "$(jq -r '.draft // false' "$release_json")" == "false" ]] \
    || fail "Release ${RELEASE_TAG} 仍是草稿，不能提交到商店"
  [[ "$(jq -r '.prerelease // false' "$release_json")" == "false" ]] \
    || fail "Release ${RELEASE_TAG} 是预发布，不能提交到商店"

  if ! gh release download "$RELEASE_TAG" --repo "$GH_REPO" --pattern '*-chrome.zip' --dir "$download_dir" --clobber; then
    fail "无法从 Release ${RELEASE_TAG} 下载 Chrome ZIP"
  fi
  mapfile -t zips < <(find "$download_dir" -maxdepth 1 -type f -name '*-chrome.zip' | sort)
  [[ "${#zips[@]}" == "1" ]] || fail "Release ${RELEASE_TAG} 应恰好包含一个 Chrome ZIP，实际 ${#zips[@]} 个"
  local chrome_zip="${zips[0]}"
  [[ -s "$chrome_zip" ]] || fail "下载的 Chrome ZIP 为空"

  local zip_manifest
  if ! zip_manifest="$(read_zip_manifest "$chrome_zip")"; then
    fail "Chrome ZIP 根目录没有可解析的 manifest.json"
  fi
  local manifest_version zip_version
  manifest_version="$(printf '%s\n' "$zip_manifest" | sed -n '1p')"
  zip_version="$(printf '%s\n' "$zip_manifest" | sed -n '2p')"
  [[ "$manifest_version" == "3" ]] || fail "Chrome ZIP 的 manifest_version 不是 3：${manifest_version:-<empty>}"
  [[ "$zip_version" =~ ^[0-9]+([.][0-9]+){0,3}$ ]] || fail "Chrome ZIP 的 manifest 版本号无效：${zip_version:-<empty>}"
  [[ "$RELEASE_TAG" == "v${zip_version}" ]] \
    || fail "Release 标签 ${RELEASE_TAG} 与 Chrome ZIP 的 manifest 版本 ${zip_version} 不一致"

  fetch_status
  [[ "$TAKEN_DOWN" == "true" ]] && fail "商店条目已被下架（takenDown=true），请先在开发者后台处理，不会尝试上传"
  [[ "$LAST_UPLOAD_STATE" == "IN_PROGRESS" ]] \
    && fail "商店仍有一个上传在处理中（lastAsyncUploadState=IN_PROGRESS），本次不会再次上传；请稍后用 check 模式确认"

  case "$SUBMITTED_STATE" in
    PENDING_REVIEW)
      if version_list_has "$zip_version" "${SUBMITTED_VERSIONS[@]}"; then
        skip_existing_version "$SUBMITTED_STATE"
      fi
      fail "商店已有提交正在审核（版本：${SUBMITTED_VERSIONS_TEXT:-未知}），不会上传或覆盖进行中的审核"
      ;;
    STAGED)
      if version_list_has "$zip_version" "${SUBMITTED_VERSIONS[@]}"; then
        skip_existing_version "$SUBMITTED_STATE"
      else
        fail "商店已有其他版本等待上线（STAGED：${SUBMITTED_VERSIONS_TEXT:-未知}），请先在开发者后台上线或取消，不会覆盖"
      fi
      ;;
  esac
  case "$PUBLISHED_STATE" in
    PUBLISHED|PUBLISHED_TO_TESTERS)
      if version_list_has "$zip_version" "${PUBLISHED_VERSIONS[@]}"; then
        skip_existing_version "$PUBLISHED_STATE"
      fi
      ;;
  esac

  local upload_result upload_version
  cws_upload "$chrome_zip" "${API_ROOT}/upload/v2/publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}:upload"
  case "$CWS_STATUS" in
    200|201) ;;
    401|403) fail "上传认证或权限失败（HTTP ${CWS_STATUS}）：$(api_error_summary)" ;;
    *) fail "上传失败（HTTP ${CWS_STATUS}）：$(api_error_summary)" ;;
  esac
  require_json "上传接口"
  local upload_state
  upload_state="$(jq -r '.uploadState // ""' "$CWS_BODY_FILE")"
  upload_version="$(jq -r '.crxVersion // ""' "$CWS_BODY_FILE")"
  case "$upload_state" in
    SUCCEEDED)
      [[ "$upload_version" == "$zip_version" ]] \
        || fail "上传接口返回的版本 ${upload_version:-<empty>} 与 ZIP 的 manifest 版本 ${zip_version} 不一致"
      upload_result="SUCCEEDED"
      ;;
    IN_PROGRESS)
      local attempts="${CWS_UPLOAD_POLL_ATTEMPTS:-24}"
      local seconds="${CWS_UPLOAD_POLL_SECONDS:-10}"
      [[ "$attempts" =~ ^[0-9]+$ && "$seconds" =~ ^[0-9]+$ ]] \
        || fail "上传轮询参数必须是整数"
      local attempt=1
      local confirmed=0
      while (( attempt <= attempts )); do
        echo "上传处理中，第 ${attempt}/${attempts} 次查询商店状态..."
        sleep "$seconds"
        fetch_status
        case "$LAST_UPLOAD_STATE" in
          SUCCEEDED) confirmed=1; break ;;
          FAILED) fail "商店报告本次上传失败（lastAsyncUploadState=FAILED），不会提审" ;;
          NOT_FOUND) fail "商店未找到本次上传（lastAsyncUploadState=NOT_FOUND），不会提审" ;;
          IN_PROGRESS|"") ;;
          *) fail "无法识别的上传状态：${LAST_UPLOAD_STATE}，不会提审" ;;
        esac
        attempt=$((attempt + 1))
      done
      [[ "$confirmed" == "1" ]] \
        || fail "上传在 ${attempts} 次轮询内仍未确认成功（最后一次：${LAST_UPLOAD_STATE:-未知}），不会提审；请稍后用 check 模式确认，不要重复上传"
      upload_result="SUCCEEDED（轮询确认）"
      ;;
    FAILED) fail "商店报告上传失败（uploadState=FAILED），不会提审" ;;
    NOT_FOUND) fail "商店未找到上传结果（uploadState=NOT_FOUND），不会提审" ;;
    *) fail "无法识别的上传结果：${upload_state:-<empty>}，不会提审" ;;
  esac

  # The payload is fixed: staged publishing, real review, warnings block.
  printf '%s' '{"publishType":"STAGED_PUBLISH","skipReview":false,"blockOnWarnings":true}' > "$CWS_PUBLISH_BODY"
  cws_request POST "${API_ROOT}/v2/publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}:publish" "$CWS_PUBLISH_BODY"
  local warnings
  case "$CWS_STATUS" in
    200|201) ;;
    401|403) fail "提审认证或权限失败（HTTP ${CWS_STATUS}）：$(api_error_summary)" ;;
    *)
      warnings="$(api_error_warnings)"
      fail "提审失败（HTTP ${CWS_STATUS}）：$(api_error_summary)${warnings:+；商店警告：${warnings}}"
      ;;
  esac
  require_json "提审接口"

  local publish_state
  publish_state="$(jq -r '.state // ""' "$CWS_BODY_FILE")"
  warnings="$(jq -r '(.warningInfo.warnings // [])[]? | "- " + ((.reason // "") + "：" + (.description // ""))' "$CWS_BODY_FILE")"
  case "$publish_state" in
    PENDING_REVIEW|STAGED|PUBLISHED) ;;
    REJECTED|CANCELLED) fail "商店拒绝了本次提审：$(item_state_label "$publish_state")" ;;
    *) fail "提审接口返回缺少可确认的状态（${publish_state:-<empty>}），不能确认已提交" ;;
  esac

  summary \
    "- 模式：submit" \
    "- 扩展 ID：${CWS_EXTENSION_ID}" \
    "- Release：${RELEASE_TAG}" \
    "- Chrome ZIP 校验：根目录 manifest.json，版本 ${zip_version}" \
    "- 商店原状态：已发布版本 ${PUBLISHED_VERSIONS_TEXT:-未发布}；提交状态 $(item_state_label "$SUBMITTED_STATE")${SUBMITTED_VERSIONS_TEXT:+（版本 ${SUBMITTED_VERSIONS_TEXT}）}" \
    "- 上传结果：${upload_result}" \
    "- 提审请求：STAGED_PUBLISH、skipReview=false、blockOnWarnings=true" \
    "- 提审结果：$(item_state_label "$publish_state")" \
    ${warnings:+"- 商店警告："$'\n'"${warnings}"} \
    "- 后续：CI 到此结束，不等待人工审核；审核通过后需在开发者后台手动点击上线"
  echo "CWS submit completed: ${RELEASE_TAG} -> ${publish_state}"
}

command="${1:-}"
case "$command" in
  preflight) preflight ;;
  check) check_mode ;;
  submit) submit_mode ;;
  *)
    echo "usage: $0 {preflight|check|submit}" >&2
    exit 2
    ;;
esac
