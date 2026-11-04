#!/usr/bin/env bash
# Publish the extension ZIPs produced by this workflow run.
#
# Stable releases use v${version} from the checked-out wxt/package.json.
# master pushes and manual runs create that tag and Release only when the
# Release does not already exist. Existing v* tag pushes keep their checks:
# a stable tag must match the package version, and a hyphenated tag stays a
# prerelease. Nothing here moves an existing tag or replaces a Release.
set -euo pipefail

# Only a newly published stable Release on master can trigger store submission.
printf 'store_release_tag=\n' >> "$GITHUB_OUTPUT"

summary() {
  {
    echo "### Release"
    printf '%s\n' "$@"
  } >> "$GITHUB_STEP_SUMMARY"
}

fail() {
  echo "::error::$1" >&2
  summary "- 结果：发布失败" "- 原因：$1"
  exit 1
}

# Set API_STATUS. gh exits on 4xx/5xx and sends the status line to stderr,
# so capture both streams before inspecting it. Transport, authentication,
# and malformed responses are failures: they must never be treated as
# "not found". The status is stored globally because a failing lookup calls
# fail(), which would otherwise be swallowed by command substitution.
api_status() {
  local path="$1"
  local response
  response="$(gh api --silent -i "$path" 2>&1 || true)"
  API_STATUS="$(printf '%s\n' "$response" | tr -d '\r' | awk 'BEGIN { code = "" } /^HTTP\// { code = $2 } END { print code }')"
  if [[ ! "$API_STATUS" =~ ^[0-9]{3}$ ]]; then
    fail "GitHub API 查询失败，不能判断目标是否存在：$path"
  fi
}

require_status() {
  local actual="$1"
  local expected="$2"
  local description="$3"
  [[ "$actual" == "$expected" ]] || fail "${description}：期望 HTTP ${expected}，实际 HTTP ${actual}"
}

if [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" && "${CONFIRM_RELEASE:-}" != "true" ]]; then
  fail "手动运行必须勾选确认：本次可能为 master 当前版本创建标签和 Release"
fi

package_version="$(jq -er '.version' wxt/package.json)" || fail "无法读取 wxt/package.json 的 version"
[[ "$package_version" =~ ^[0-9]+([.][0-9]+){0,3}$ ]] || fail "wxt/package.json 的 version 不是正式版本号：$package_version"
stable_tag="v${package_version}"

mapfile -t chrome_zips < <(find artifacts/extension-chrome -name '*-chrome.zip' -type f | sort)
mapfile -t firefox_zips < <(find artifacts/extension-firefox -name '*-firefox.zip' -type f | sort)
[[ "${#chrome_zips[@]}" == "1" ]] || fail "本次构建应恰好有一个 Chrome ZIP，实际 ${#chrome_zips[@]} 个"
[[ "${#firefox_zips[@]}" == "1" ]] || fail "本次构建应恰好有一个 Firefox ZIP，实际 ${#firefox_zips[@]} 个"
chrome_zip="${chrome_zips[0]}"
firefox_zip="${firefox_zips[0]}"
chrome_version="$(python - "$chrome_zip" <<'PY'
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    if "manifest.json" not in archive.namelist():
        raise SystemExit(1)
    print(json.load(archive.open("manifest.json"))["version"])
PY
)" || fail "无法读取 Chrome ZIP 根目录的 manifest.json"
[[ "$chrome_version" == "$package_version" ]] || fail "Chrome ZIP 版本 $chrome_version 与 wxt/package.json 的 $package_version 不一致"

prerelease=0
if [[ "${GITHUB_REF:-}" == refs/tags/v* ]]; then
  release_tag="${GITHUB_REF_NAME}"
  if [[ "$release_tag" == *-* ]]; then
    prerelease=1
  elif [[ "$release_tag" != "$stable_tag" ]]; then
    fail "正式标签 $release_tag 与包版本 $stable_tag 不一致"
  fi
elif [[ "${GITHUB_REF:-}" == "refs/heads/master" || "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]]; then
  release_tag="$stable_tag"
else
  fail "不支持的发布触发：${GITHUB_REF:-<empty>}"
fi

if [[ "$prerelease" == "0" && "$chrome_version" != "${release_tag#v}" ]]; then
  fail "Chrome ZIP 版本 $chrome_version 与正式发布版本 ${release_tag#v} 不一致"
fi

# Resolve an existing tag to the commit it points at. Annotated tags need a
# second lookup. A mismatch is fatal and the tag is left untouched.
resolve_tag_commit() {
  local tag="$1"
  local object_sha object_type
  object_sha="$(gh api "repos/${GH_REPO}/git/ref/tags/${tag}" --jq '.object.sha')"
  object_type="$(gh api "repos/${GH_REPO}/git/ref/tags/${tag}" --jq '.object.type')"
  if [[ "$object_type" == "tag" ]]; then
    gh api "repos/${GH_REPO}/git/tags/${object_sha}" --jq '.object.sha'
  elif [[ "$object_type" == "commit" ]]; then
    printf '%s' "$object_sha"
  else
    fail "标签 $tag 的对象类型无法识别：$object_type"
  fi
}

release_state() {
  api_status "repos/${GH_REPO}/releases/tags/${release_tag}"
  case "$API_STATUS" in
    200) RELEASE_STATE="exists" ;;
    404) RELEASE_STATE="absent" ;;
    *) fail "查询 Release $release_tag 返回 HTTP $API_STATUS，不能把它当作不存在" ;;
  esac
}

skip_existing() {
  local reason="$1"
  local release_url
  release_url="$(gh api "repos/${GH_REPO}/releases/tags/${release_tag}" --jq '.html_url')"
  [[ -n "$release_url" && "$release_url" != "null" ]] || fail "Release $release_tag 已存在，但没有返回地址"
  summary \
    "- 构建版本：${package_version}" \
    "- 提交 SHA：${BUILD_SHA}" \
    "- 是否创建标签：否" \
    "- Release：${release_url}" \
    "- 跳过原因：${reason}"
  echo "Skipped release: $reason"
  exit 0
}

release_state
[[ "$RELEASE_STATE" == "exists" ]] && skip_existing "${release_tag} 的 Release 已存在，保留本次 CI 与 Artifacts，不重复创建或覆盖"

api_status "repos/${GH_REPO}/git/ref/tags/${release_tag}"
tag_status="$API_STATUS"
tag_action="未创建"
case "$tag_status" in
  200)
    tag_commit="$(resolve_tag_commit "$release_tag")"
    [[ "$tag_commit" == "$BUILD_SHA" ]] || fail "标签 $release_tag 指向 $tag_commit，与本次构建 $BUILD_SHA 不一致，不会移动或覆盖"
    tag_action="未创建（复用已指向 ${BUILD_SHA} 的 ${release_tag}）"
    ;;
  404)
    if [[ "$prerelease" == "1" ]]; then
      fail "预发布标签 $release_tag 在远端不存在，不会从当前提交另建标签"
    fi
    tag_action="将创建 ${release_tag}"
    ;;
  *)
    fail "查询标签 $release_tag 返回 HTTP $tag_status，不能继续发布"
    ;;
esac

# A release for the same version may have been created while this run waited.
release_state
[[ "$RELEASE_STATE" == "exists" ]] && skip_existing "发布前再次检查时 ${release_tag} 已存在，本次不重复创建或覆盖"

created_tag="否"
if [[ "$tag_status" == "404" ]]; then
  notes_file="$(mktemp)"
  cat > "$notes_file" <<EOF
Rewards 助手 ${package_version}

由提交 ${BUILD_SHA} 的检查、测试和 Chrome／Firefox 打包成功后自动发布。

- Chrome / Edge：下载文件名含 chrome 的 ZIP，解压后在扩展管理页加载已解压的扩展程序。
- Firefox：下载文件名含 firefox 的 ZIP，按 README 临时载入或安装。
- GitHub 自动附带的 Source code 归档是源码，请使用上面两份扩展 ZIP。

master 发布流程会在新建正式 Release 后上传 Chrome ZIP 并提交商店审核；审核通过后仍需手动上线。创建 Release 不代表扩展已经在商店上线。使用前请查看仓库 README 的已知问题与验证范围。
EOF
  # An annotated tag records a tagger, and the runner has no git identity.
  # Pass one explicitly instead of relying on repository or global config.
  GIT_AUTHOR_NAME="github-actions[bot]" \
  GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
  GIT_COMMITTER_NAME="github-actions[bot]" \
  GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
    git tag -a "$release_tag" "$BUILD_SHA" -F "$notes_file"
  git push origin "refs/tags/${release_tag}"
  api_status "repos/${GH_REPO}/git/ref/tags/${release_tag}"
  require_status "$API_STATUS" "200" "创建标签后未能在远端确认 $release_tag"
  pushed_commit="$(resolve_tag_commit "$release_tag")"
  [[ "$pushed_commit" == "$BUILD_SHA" ]] || fail "远端标签 $release_tag 指向 $pushed_commit，不是本次构建 $BUILD_SHA"
  created_tag="是（${release_tag} → ${BUILD_SHA}）"
else
  # Shallow checkout does not include existing tags. --notes-from-tag needs
  # the exact tag locally when retrying after a tag was already pushed.
  git fetch --no-tags origin "refs/tags/${release_tag}:refs/tags/${release_tag}"
fi

# Creating the tag can itself start another run. Look once more before
# publishing, and leave the tag in place when that run already published.
release_state
[[ "$RELEASE_STATE" == "exists" ]] && skip_existing "创建或确认标签后，${release_tag} 的 Release 已存在，不重复创建或覆盖"

release_args=(--verify-tag --target "$BUILD_SHA" --title "Rewards 助手 ${release_tag}" --notes-from-tag)
if [[ "$prerelease" == "1" ]]; then
  release_args+=(--prerelease --latest=false)
fi
gh release create "$release_tag" \
  "$chrome_zip" \
  "$firefox_zip" \
  "${release_args[@]}"

release_url="$(gh api "repos/${GH_REPO}/releases/tags/${release_tag}" --jq '.html_url')"
[[ -n "$release_url" && "$release_url" != "null" ]] || fail "Release 已创建，但没有返回地址"
summary \
  "- 构建版本：${package_version}" \
  "- 提交 SHA：${BUILD_SHA}" \
  "- 是否创建标签：${created_tag}" \
  "- Release：${release_url}" \
  "- 跳过原因：无"
echo "Published $release_url"
if [[ "$prerelease" == "0" && "${GITHUB_REF:-}" == "refs/heads/master" ]]; then
  printf 'store_release_tag=%s\n' "$release_tag" >> "$GITHUB_OUTPUT"
fi
