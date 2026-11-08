#!/usr/bin/env bash
# Publish the extension ZIPs produced by this workflow run.
#
# Stable releases use v${version} from the checked-out wxt/package.json.
# master pushes and manual runs create that tag and Release only when the
# Release does not already exist. Existing v* tag pushes keep their checks:
# a stable tag must match the package version, and a hyphenated tag stays a
# prerelease. Nothing here moves an existing tag or replaces a Release.
#
# The Release body groups the commits between the previous stable tag and
# this build into 升级与改进 / 问题修复 / 文档与维护 sections, keeps the
# install and verification notes after them, and reaches gh release create
# through --notes-file in both the tag-create and tag-reuse paths.
set -euo pipefail

# A stable Release for this exact master commit can trigger store submission,
# including a rerun after Release creation succeeded but store submission failed.
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

# Each ZIP must carry its manifest at the root with its own target's design:
# Chrome is MV3, Firefox is MV2. One is never normalized to the other; a
# mismatch means the wrong target was packaged.
read_zip_manifest() {
  # Prints manifest_version, then version. Fails when the root manifest.json
  # is missing or unparseable. manifest_version must be a JSON number; a
  # look-alike string ("3") prints as empty so the caller rejects the ZIP.
  python - "$1" <<'PY'
import json, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as archive:
    if "manifest.json" not in archive.namelist():
        raise SystemExit(1)
    try:
        manifest = json.load(archive.open("manifest.json"))
    except ValueError:
        raise SystemExit(1)
manifest_version = manifest.get("manifest_version", "")
if isinstance(manifest_version, bool) or not isinstance(manifest_version, int):
    manifest_version = ""
print(manifest_version)
print(manifest.get("version", ""))
PY
}

if ! chrome_manifest="$(read_zip_manifest "$chrome_zip")"; then
  fail "无法读取 Chrome ZIP 根目录的 manifest.json"
fi
chrome_manifest_version="$(printf '%s\n' "$chrome_manifest" | sed -n '1p')"
chrome_version="$(printf '%s\n' "$chrome_manifest" | sed -n '2p')"
[[ "$chrome_manifest_version" == "3" ]] || fail "Chrome ZIP 的 manifest_version 应为 3，实际 ${chrome_manifest_version:-<empty>}"
[[ "$chrome_version" == "$package_version" ]] || fail "Chrome ZIP 版本 $chrome_version 与 wxt/package.json 的 $package_version 不一致"

if ! firefox_manifest="$(read_zip_manifest "$firefox_zip")"; then
  fail "无法读取 Firefox ZIP 根目录的 manifest.json"
fi
firefox_manifest_version="$(printf '%s\n' "$firefox_manifest" | sed -n '1p')"
firefox_version="$(printf '%s\n' "$firefox_manifest" | sed -n '2p')"
[[ "$firefox_manifest_version" == "2" ]] || fail "Firefox ZIP 的 manifest_version 应为 2，实际 ${firefox_manifest_version:-<empty>}"
[[ "$firefox_version" == "$package_version" ]] || fail "Firefox ZIP 版本 $firefox_version 与 wxt/package.json 的 $package_version 不一致"

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

if [[ "$prerelease" == "0" ]]; then
  [[ "$chrome_version" == "${release_tag#v}" ]] || fail "Chrome ZIP 版本 $chrome_version 与正式发布版本 ${release_tag#v} 不一致"
  [[ "$firefox_version" == "${release_tag#v}" ]] || fail "Firefox ZIP 版本 $firefox_version 与正式发布版本 ${release_tag#v} 不一致"
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
  local release_url store_note="不触发（仅处理 master 的正式版本）"
  release_url="$(gh api "repos/${GH_REPO}/releases/tags/${release_tag}" --jq '.html_url')"
  [[ -n "$release_url" && "$release_url" != "null" ]] || fail "Release $release_tag 已存在，但没有返回地址"
  if [[ "$prerelease" == "0" && "${GITHUB_REF:-}" == "refs/heads/master" ]]; then
    api_status "repos/${GH_REPO}/git/ref/tags/${release_tag}"
    require_status "$API_STATUS" "200" "无法确认已有 Release 的标签 $release_tag"
    local tag_commit
    tag_commit="$(resolve_tag_commit "$release_tag")"
    if [[ "$tag_commit" == "$BUILD_SHA" ]]; then
      printf 'store_release_tag=%s\n' "$release_tag" >> "$GITHUB_OUTPUT"
      store_note="继续检查并上传或提审 ${release_tag}（已有 Release 指向本次提交）"
    else
      store_note="不触发（${release_tag} 指向其他提交；同版本普通提交不重复提审）"
    fi
  fi
  summary \
    "- 构建版本：${package_version}" \
    "- 提交 SHA：${BUILD_SHA}" \
    "- 是否创建标签：否" \
    "- Release：${release_url}" \
    "- 跳过原因：${reason}" \
    "- 商店衔接：${store_note}"
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

# SHA-256 manifest for the artifacts this run is about to publish. The
# checksums are computed from the exact ZIP files uploaded below, so the
# SHA256SUMS asset always matches the Release assets it ships with.
chrome_zip_name="${chrome_zip##*/}"
firefox_zip_name="${firefox_zip##*/}"
chrome_sha256="$(sha256sum "$chrome_zip" | awk '{print $1}')"
firefox_sha256="$(sha256sum "$firefox_zip" | awk '{print $1}')"
checksums_file="artifacts/SHA256SUMS"
{
  printf '%s  %s\n' "$chrome_sha256" "$chrome_zip_name"
  printf '%s  %s\n' "$firefox_sha256" "$firefox_zip_name"
} > "$checksums_file"

# The newest stable tag below this release's base version (the tag without
# any prerelease suffix). Without one (first release ever, or a backfilled
# prerelease with no earlier stable tag) there is no honest range, so the
# notes carry no change sections at all instead of invented entries. A
# backfilled prerelease — v3.1.3-beta.2 published after v3.1.5 — must not
# compare from the repository-wide maximum: v3.1.5 would describe the wrong
# range, so candidates at or above the base version are dropped first.
previous_stable_tag() {
  local base_tag refs
  base_tag="${release_tag%%-*}"
  refs="$(git ls-remote --tags origin)" || fail "无法列出远端版本标签"
  {
    printf '%s\n' "$refs" | sed -n 's/^[0-9a-f]*[[:space:]]refs\/tags\/\(.*\)$/\1/p' \
      | grep -E '^v[0-9]+([.][0-9]+)+$' \
      | grep -v -x -F -- "$release_tag"
    printf '%s\n' "$base_tag"
  } | sort -V | awk -v base="$base_tag" '$0 == base { exit } { print }' | tail -n 1 || true
}

# CHANGE_SECTIONS holds the grouped change entries for the Release body:
# every entry comes from an actual commit in the release range, merged PRs
# are matched by their merge commit, and version-bump noise, merge commits
# and duplicate subjects are dropped. Empty groups are omitted, never
# fabricated.
change_sections() {
  CHANGE_SECTIONS=""
  local prev_tag commits_json prs_json
  prev_tag="$(previous_stable_tag)"
  [[ -n "$prev_tag" ]] || return 0
  commits_json="$(mktemp)"
  prs_json="$(mktemp)"
  # per_page=100 lifts the compare endpoint's default 30-commit page; more
  # than one page cannot be followed here, so a still-truncated response is
  # warned about below instead of silently passing as complete.
  gh api "repos/${GH_REPO}/compare/${prev_tag}...${BUILD_SHA}?per_page=100" > "$commits_json" \
    || fail "无法读取 ${prev_tag} 到 ${BUILD_SHA} 之间的提交"
  gh pr list --state merged --limit 100 --json number,url,author,mergeCommit > "$prs_json" \
    || fail "无法读取已合并 PR 列表"
  CHANGE_SECTIONS="$(python - "$commits_json" "$prs_json" <<'PY'
# -*- coding: utf-8 -*-
"""Group the release-range commits into note sections. Prints nothing when
no reportable change remains, so empty groups never reach the Release."""
import json
import re
import sys

for stream in (sys.stdout, sys.stderr):
    if stream.encoding and stream.encoding.lower() not in ("utf-8", "utf8"):
        stream.reconfigure(encoding="utf-8")

with open(sys.argv[1], encoding="utf-8") as source:
    compare = json.load(source)
with open(sys.argv[2], encoding="utf-8") as source:
    pulls = json.load(source)

# A compare response can be truncated (one page only); warn on stderr so the
# gap is visible in the log without leaking into CHANGE_SECTIONS on stdout.
returned = len(compare.get("commits") or [])
if compare.get("total_commits", returned) > returned:
    print(
        "::warning::compare 只返回 %d/%s 个提交，更新说明可能不完整"
        % (returned, compare.get("total_commits")),
        file=sys.stderr,
    )

merged_pulls = {}
for pull in pulls if isinstance(pulls, list) else []:
    oid = (pull.get("mergeCommit") or {}).get("oid")
    if oid:
        merged_pulls[oid] = pull

FIX = re.compile(r"^(?:fix|bugfix|hotfix)(?:\([^)]*\))?[:：]\s*|^修复[:：]\s*", re.IGNORECASE)
MAINTAIN = re.compile(r"^(?:docs?|ci|chore|build)(?:\([^)]*\))?[:：]\s*|^文档[:：]\s*", re.IGNORECASE)
FEATURE = re.compile(r"^(?:feat|feature|perf|performance|refactor)(?:\([^)]*\))?[:：]\s*", re.IGNORECASE)
VERSION_BUMP = re.compile(r"^(?:升级版本|版本升级|bump|release)[:：\s至到为]*v?[0-9]", re.IGNORECASE)
VERSION_ONLY = re.compile(r"^v?[0-9]+(?:[.][0-9]+)+$")
MERGE_COMMIT = re.compile(r"^Merge (?:pull request|branch|remote-tracking branch)")


def commit_author_name(commit):
    return ((commit.get("commit") or {}).get("author") or {}).get("name") or ""


def author_credit(login, fallback_name):
    if login:
        return "[@%s](https://github.com/%s)" % (login, login)
    return fallback_name


groups = {"improve": [], "fix": [], "maintain": []}
seen = set()
for commit in compare.get("commits") or []:
    message = (commit.get("commit") or {}).get("message") or ""
    subject = message.splitlines()[0].strip() if message else ""
    if not subject or MERGE_COMMIT.match(subject):
        continue
    fix_match, maintain_match = FIX.match(subject), MAINTAIN.match(subject)
    if fix_match:
        kind, prefix = "fix", fix_match
    elif subject.startswith("修复"):
        # This repository also writes fix subjects without a separator, e.g.
        # "修复商店自动提审重跑…". Classify them as fixes but keep the whole
        # sentence as the description.
        kind, prefix = "fix", None
    elif maintain_match:
        kind, prefix = "maintain", maintain_match
    else:
        kind, prefix = "improve", FEATURE.match(subject)
    description = subject[prefix.end():].strip() if prefix else subject
    if not description or VERSION_BUMP.match(description) or VERSION_ONLY.fullmatch(description):
        continue
    if description in seen:
        continue
    seen.add(description)
    if not description.endswith(("。", "！", "？", ".", "!", "?")):
        description += "。"
    sha = commit.get("sha") or ""
    commit_url = commit.get("html_url") or ""
    pull = merged_pulls.get(sha)
    if pull:
        credit = author_credit((pull.get("author") or {}).get("login"), commit_author_name(commit))
        link = "[#%s](%s)" % (pull.get("number", ""), pull.get("url", ""))
    else:
        credit = author_credit((commit.get("author") or {}).get("login"), commit_author_name(commit))
        link = "[%s](%s)" % (sha[:7], commit_url) if commit_url else ""
    attribution = " · ".join(part for part in (credit, link) if part)
    groups[kind].append(description + attribution if attribution else description)

section_titles = (("improve", "升级与改进"), ("fix", "问题修复"), ("maintain", "文档与维护"))
blocks = []
for key, title in section_titles:
    if groups[key]:
        blocks.append("## %s\n\n%s" % (title, "\n".join("- %s" % line for line in groups[key])))
if blocks:
    print("\n\n".join(blocks))
PY
)" || fail "无法根据 ${prev_tag} 到 ${BUILD_SHA} 的提交生成分栏更新说明"
}

change_sections

# One notes file serves both consumers: the annotated tag message when this
# run creates the tag, and the Release body via --notes-file. Change sections
# come first; the fixed install, checksum and store-policy text stays after.
notes_file="$(mktemp)"
{
  printf 'Rewards 助手 %s\n' "$package_version"
  if [[ -n "$CHANGE_SECTIONS" ]]; then
    printf '\n%s\n\n' "$CHANGE_SECTIONS"
  else
    printf '\n'
  fi
  cat <<EOF
由提交 ${BUILD_SHA} 的检查、测试和 Chrome／Firefox 打包成功后自动发布。

- Chrome / Edge：下载文件名含 chrome 的 ZIP，解压后在扩展管理页加载已解压的扩展程序。
- Firefox：下载文件名含 firefox 的 ZIP，按 README 临时载入或安装。
- GitHub 自动附带的 Source code 归档是源码，请使用上面两份扩展 ZIP。
- 产物 SHA-256：
  - ${chrome_zip_name}：${chrome_sha256}
  - ${firefox_zip_name}：${firefox_sha256}
- 完整校验清单见同一 Release 的 SHA256SUMS 附件；产物由提交 ${BUILD_SHA} 构建并通过全部检查。

master 发布流程会上传 Chrome ZIP 并提交商店审核；同一提交重跑时可复用已有 Release 继续商店步骤。审核通过后由商店自动上线，无需手动发布。创建 Release 不代表扩展已经在商店上线。使用前请查看仓库 README 的已知问题与验证范围。
EOF
} > "$notes_file"

created_tag="否"
if [[ "$tag_status" == "404" ]]; then
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
  # Shallow checkout does not include existing tags. Keep the exact tag
  # locally so this retry publishes against the same object it resolved
  # above; the Release body itself comes from --notes-file.
  git fetch --no-tags origin "refs/tags/${release_tag}:refs/tags/${release_tag}"
fi

# Creating the tag can itself start another run. Look once more before
# publishing, and leave the tag in place when that run already published.
release_state
[[ "$RELEASE_STATE" == "exists" ]] && skip_existing "创建或确认标签后，${release_tag} 的 Release 已存在，不重复创建或覆盖"

release_args=(--verify-tag --target "$BUILD_SHA" --title "Rewards 助手 ${release_tag}" --notes-file "$notes_file")
if [[ "$prerelease" == "1" ]]; then
  release_args+=(--prerelease --latest=false)
fi
gh release create "$release_tag" \
  "$chrome_zip" \
  "$firefox_zip" \
  "$checksums_file" \
  "${release_args[@]}"

release_url="$(gh api "repos/${GH_REPO}/releases/tags/${release_tag}" --jq '.html_url')"
[[ -n "$release_url" && "$release_url" != "null" ]] || fail "Release 已创建，但没有返回地址"
summary \
  "- 构建版本：${package_version}" \
  "- 提交 SHA：${BUILD_SHA}" \
  "- 是否创建标签：${created_tag}" \
  "- Release：${release_url}" \
  "- 产物校验：${chrome_zip_name}（SHA-256 ${chrome_sha256}）" \
  "- 产物校验：${firefox_zip_name}（SHA-256 ${firefox_sha256}）" \
  "- 跳过原因：无"
echo "Published $release_url"
if [[ "$prerelease" == "0" && "${GITHUB_REF:-}" == "refs/heads/master" ]]; then
  printf 'store_release_tag=%s\n' "$release_tag" >> "$GITHUB_OUTPUT"
fi
