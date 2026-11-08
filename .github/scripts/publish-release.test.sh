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
  local manifest_version="$1"
  local version="$2"
  local zip="$3"
  "$PYTHON" - "$manifest_version" "$version" "$zip" <<'PY'
import json, sys, zipfile
manifest_version, version, path = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr(
        "manifest.json",
        json.dumps({"manifest_version": int(manifest_version), "version": version, "name": "fixture"}),
    )
PY
}

make_zip 3 "3.1.3" "$work/repo/artifacts/extension-chrome/rewards-3.1.3-chrome.zip"
make_zip 2 "3.1.3" "$work/repo/artifacts/extension-firefox/rewards-3.1.3-firefox.zip"

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

if [[ "$1" == "pr" && "$2" == "list" ]]; then
  [[ " ${*} " == *" --state merged "* && " ${*} " == *" --json "* ]] || exit 1
  if [[ -f "$state/prs.json" ]]; then
    cat "$state/prs.json"
  else
    printf '[]\n'
  fi
  exit 0
fi

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
  elif [[ "$path" == *"/compare/"*"..."* ]]; then
    # The commit range behind the change notes. A missing fixture file means
    # "no commits in range"; entries are never invented here.
    code=200
    if [[ -f "$state/compare.json" ]]; then
      body="$(cat "$state/compare.json")"
    else
      body='{"commits":[]}'
    fi
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
  all="$*"
  shift 3
  notes_file=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--notes-file" ]]; then
      notes_file="$2"
      shift 2
    else
      shift
    fi
  done
  [[ " $all " == *" --verify-tag "* && " $all " == *" --target ${BUILD_SHA} "* ]] || exit 1
  # The Release body must be the generated notes file itself, never
  # --notes-from-tag or a template nothing consumes.
  [[ " $all " != *" --notes-from-tag "* ]] || exit 1
  [[ -n "$notes_file" && -f "$notes_file" ]] || exit 1
  cp "$notes_file" "${FIXTURE_DIR}/release-body"
  [[ " $all " == *" artifacts/extension-chrome/"*"-chrome.zip "* && " $all " == *" artifacts/extension-firefox/"*"-firefox.zip "* ]] || exit 1
  # The Release must also carry the run's SHA-256 manifest for its ZIPs.
  [[ " $all " == *" artifacts/SHA256SUMS "* ]] || exit 1
  cp artifacts/SHA256SUMS "${FIXTURE_DIR}/sha256sums"
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
if [[ "$1" == "ls-remote" && "$2" == "--tags" && "$3" == "origin" ]]; then
  # Remote tags for the change-notes range, one ref per line. No file means
  # the repository has no version tags yet, so no range can be derived.
  if [[ -f "${FIXTURE_DIR}/state/remote-tags" ]]; then
    while IFS= read -r ref; do
      [[ -n "$ref" ]] && printf '%s\t%s\n' '0000000000000000000000000000000000000000' "$ref"
    done < "${FIXTURE_DIR}/state/remote-tags"
  fi
  exit 0
fi
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

# The published SHA256SUMS asset must match the exact ZIPs the case shipped,
# and the checksum values must reach the step summary and, when a tag message
# was written, the Release body source.
expect_checksums() {
  local case_name="$1"
  local case_dir="$work/cases/$case_name"
  # GNU sha256sum marks binary-mode digests with a "*" between the hash and the
  # file name (MSYS does this for globbed ZIP inputs); normalize both sides to
  # the text-mode "hash  name" form the script writes.
  local normalize='s/^([0-9a-f]{64})[[:space:]]+\*?/\1  /'
  local expected
  expected="$( { cd "$case_dir/repo/artifacts/extension-chrome" && sha256sum *-chrome.zip
    cd "$case_dir/repo/artifacts/extension-firefox" && sha256sum *-firefox.zip; } | sed -E "$normalize")"
  [[ -f "$case_dir/sha256sums" ]] || { echo "FAIL $case_name: no SHA256SUMS uploaded"; exit 1; }
  [[ "$(sed -E "$normalize" "$case_dir/sha256sums")" == "$expected" ]] || {
    echo "FAIL $case_name: SHA256SUMS does not match the shipped ZIPs"
    echo "--- expected ---"; printf '%s\n' "$expected"
    echo "--- actual ---"; cat "$case_dir/sha256sums"
    exit 1
  }
  local chrome_sha firefox_sha
  chrome_sha="$(sed -n '1p' "$case_dir/sha256sums" | awk '{print $1}')"
  firefox_sha="$(sed -n '2p' "$case_dir/sha256sums" | awk '{print $1}')"
  grep -q "$chrome_sha" "$case_dir/accepted-summary" || { echo "FAIL $case_name: Chrome SHA-256 missing from summary"; exit 1; }
  grep -q "$firefox_sha" "$case_dir/accepted-summary" || { echo "FAIL $case_name: Firefox SHA-256 missing from summary"; exit 1; }
  if [[ -f "$case_dir/tag-message" ]]; then
    grep -q "$chrome_sha" "$case_dir/tag-message" || { echo "FAIL $case_name: Chrome SHA-256 missing from tag message"; exit 1; }
    grep -q "$firefox_sha" "$case_dir/tag-message" || { echo "FAIL $case_name: Firefox SHA-256 missing from tag message"; exit 1; }
  fi
  echo "PASS $case_name-checksums"
}

# The generated change notes must be the actual Release body: the range
# starts at the previous stable tag (not the release's own tag), every entry
# maps back to a fixture commit (PR link when a merged PR matches the
# commit, author plus commit link otherwise), noise stays out, and the
# install/verification tail sits after the sections.
expect_notes() {
  local case_name="$1"
  local case_dir="$work/cases/$case_name"
  local body="$case_dir/release-body"
  [[ -s "$body" ]] || { echo "FAIL $case_name: no Release body captured"; exit 1; }
  grep -qF 'compare/v3.1.2...' "$case_dir/gh.log" \
    || { echo "FAIL $case_name: change range does not start at the previous stable tag"; exit 1; }
  local improve fix maintain tail_line
  improve="$(grep -n '^## 升级与改进$' "$body" | cut -d: -f1)"
  fix="$(grep -n '^## 问题修复$' "$body" | cut -d: -f1)"
  maintain="$(grep -n '^## 文档与维护$' "$body" | cut -d: -f1)"
  [[ -n "$improve" && -n "$fix" && -n "$maintain" && "$improve" -lt "$fix" && "$fix" -lt "$maintain" ]] \
    || { echo "FAIL $case_name: sections missing or out of order"; exit 1; }
  tail_line="$(grep -n '^由提交 ' "$body" | head -n 1 | cut -d: -f1)"
  [[ -n "$tail_line" && "$tail_line" -gt "$maintain" ]] \
    || { echo "FAIL $case_name: install notes must come after the change sections"; exit 1; }
  local bullets expected forbidden
  bullets="$(awk -v start="$improve" -v stop="$tail_line" 'NR > start && NR < stop && sub(/^- /, "")' "$body" | sort)"
  expected="$(printf '%s\n' \
    '新增诊断信息导出。[@alice](https://github.com/alice) · [1111111](https://example.test/commit/1111)' \
    '单项重试绕过设置加载与保存状态限制。[@bob](https://github.com/bob) · [#12](https://example.test/pull/12)' \
    '合并构建与发布工作流。[@dan](https://github.com/dan) · [6666666](https://example.test/commit/6666)' | sort)"
  [[ "$bullets" == "$expected" ]] || {
    echo "FAIL $case_name: change entries differ from the fixture commits"
    echo "--- expected ---"; printf '%s\n' "$expected"
    echo "--- actual ---"; printf '%s\n' "$bullets"
    exit 1
  }
  for forbidden in '升级版本' 'Merge pull request' '#99' 'carol' 'Carol'; do
    if grep -qF "$forbidden" "$body"; then
      echo "FAIL $case_name: noise or unlinked PR leaked into the body: $forbidden"
      exit 1
    fi
  done
  grep -qF '审核通过后由商店自动上线' "$body" \
    || { echo "FAIL $case_name: store auto-publish policy missing from the body"; exit 1; }
  grep -qF 'SHA256SUMS' "$body" \
    || { echo "FAIL $case_name: verification notes missing from the body"; exit 1; }
  if [[ -f "$case_dir/tag-message" ]]; then
    diff -q "$case_dir/tag-message" "$body" >/dev/null \
      || { echo "FAIL $case_name: tag message differs from the Release body"; exit 1; }
  fi
  echo "PASS $case_name-notes"
}

# A fix-only range: the other two groups stay empty and must be omitted, and
# a commit whose author has no GitHub login still gets the author name and
# the commit link, with no invented PR reference.
expect_notes_fix_only() {
  local case_name="$1"
  local case_dir="$work/cases/$case_name"
  local body="$case_dir/release-body"
  [[ -s "$body" ]] || { echo "FAIL $case_name: no Release body captured"; exit 1; }
  grep -q '^## 问题修复$' "$body" || { echo "FAIL $case_name: fix section missing"; exit 1; }
  if grep -qE '^## (升级与改进|文档与维护)$' "$body"; then
    echo "FAIL $case_name: empty sections must be omitted"
    exit 1
  fi
  grep -qxF -- '- 修复停止后仍会跳转首个搜索结果。Eve · [9999999](https://example.test/commit/9999)' "$body" \
    || { echo "FAIL $case_name: direct-commit entry with author and commit link missing"; exit 1; }
  grep -qxF -- '- 修复商店自动提审重跑与重复版本处理。[@ming](https://github.com/ming) · [1212121](https://example.test/commit/1212)' "$body" \
    || { echo "FAIL $case_name: separator-less 修复 subject not classified as a fix"; exit 1; }
  grep -qF '审核通过后由商店自动上线' "$body" \
    || { echo "FAIL $case_name: store auto-publish policy missing from the body"; exit 1; }
  echo "PASS $case_name-notes"
}

set_state() {
  local case_name="$1"
  local key="$2"
  local value="$3"
  mkdir -p "$work/saved/$case_name"
  printf '%s\n' "$value" > "$work/saved/$case_name/$key"
}

# Remote version tags for the change-notes range, one ref per line. The
# current tag v3.1.3 is included where the script must prefer v3.1.2.
set_remote_tags() {
  local case_name="$1"
  shift
  mkdir -p "$work/saved/$case_name"
  printf '%s\n' "$@" > "$work/saved/$case_name/remote-tags"
}

put_fixture() {
  local case_name="$1"
  local name="$2"
  local file="$3"
  mkdir -p "$work/saved/$case_name"
  cp "$file" "$work/saved/$case_name/$name"
}

prepare_absent() {
  set_state "$1" "tag-v3.1.3" "absent"
  set_state "$1" "release-v3.1.3" "absent"
}

# Change-notes fixtures. compare-mixed covers a PR-linked fix, a direct feat
# commit without any PR, a version-bump chore, a duplicate subject and a
# merge commit (all three must be dropped), plus a ci commit for the third
# group. PR #99 maps to a commit outside the range and must never appear.
fixtures="$work/fixtures"
mkdir -p "$fixtures"
cat > "$fixtures/compare-mixed.json" <<'EOF'
{
  "commits": [
    {"sha": "1111111111111111111111111111111111111111", "html_url": "https://example.test/commit/1111",
     "commit": {"message": "feat: 新增诊断信息导出\n\n导出内容不含敏感字段。", "author": {"name": "Alice Chen"}},
     "author": {"login": "alice"}},
    {"sha": "2222222222222222222222222222222222222222", "html_url": "https://example.test/commit/2222",
     "commit": {"message": "修复：单项重试绕过设置加载与保存状态限制", "author": {"name": "Bob Li"}},
     "author": {"login": "bob"}},
    {"sha": "3333333333333333333333333333333333333333", "html_url": "https://example.test/commit/3333",
     "commit": {"message": "chore: 升级版本至 3.1.3", "author": {"name": "Bob Li"}},
     "author": {"login": "bob"}},
    {"sha": "4444444444444444444444444444444444444444", "html_url": "https://example.test/commit/4444",
     "commit": {"message": "feat: 新增诊断信息导出", "author": {"name": "Carol Wu"}},
     "author": {"login": "carol"}},
    {"sha": "5555555555555555555555555555555555555555", "html_url": "https://example.test/commit/5555",
     "commit": {"message": "Merge pull request #7 from carol/feature", "author": {"name": "Carol Wu"}},
     "author": {"login": "carol"}},
    {"sha": "6666666666666666666666666666666666666666", "html_url": "https://example.test/commit/6666",
     "commit": {"message": "ci: 合并构建与发布工作流", "author": {"name": "Dan Zhou"}},
     "author": {"login": "dan"}}
  ]
}
EOF
cat > "$fixtures/prs-mixed.json" <<'EOF'
[
  {"number": 12, "url": "https://example.test/pull/12",
   "author": {"login": "bob", "name": "Bob Li"},
   "mergeCommit": {"oid": "2222222222222222222222222222222222222222"}},
  {"number": 99, "url": "https://example.test/pull/99",
   "author": {"login": "zoe"},
   "mergeCommit": {"oid": "abcdefabcdefabcdefabcdefabcdefabcdefabcd"}}
]
EOF
# A fix-only range: one conventional fix whose author has no GitHub login,
# and one real-history subject that leads with 修复 without any separator —
# both belong in 问题修复. The other two groups stay empty and must be
# omitted.
cat > "$fixtures/compare-fix-only.json" <<'EOF'
{
  "commits": [
    {"sha": "9999999999999999999999999999999999999999", "html_url": "https://example.test/commit/9999",
     "commit": {"message": "fix: 修复停止后仍会跳转首个搜索结果", "author": {"name": "Eve"}},
     "author": null},
    {"sha": "1212121212121212121212121212121212121212", "html_url": "https://example.test/commit/1212",
     "commit": {"message": "修复商店自动提审重跑与重复版本处理", "author": {"name": "Ming"}},
     "author": {"login": "ming"}}
  ]
}
EOF

prepare_absent new-version
run_case new-version create v3.1.3
expect_checksums new-version
# Without a previous version tag there is no honest range: the body keeps
# the install notes but must not invent change sections.
[[ -s "$work/cases/new-version/release-body" ]] || { echo "FAIL new-version: no Release body captured"; exit 1; }
if grep -q '^## ' "$work/cases/new-version/release-body"; then
  echo "FAIL new-version: change sections without a previous version tag"
  exit 1
fi

# The full notes pipeline: PR-linked and direct commits, noise dropping, and
# the generated notes as the Release body of a newly created tag.
prepare_absent notes-with-prs
set_remote_tags notes-with-prs "refs/tags/v3.1.2" "refs/tags/v3.1.3"
put_fixture notes-with-prs compare.json "$fixtures/compare-mixed.json"
put_fixture notes-with-prs prs.json "$fixtures/prs-mixed.json"
run_case notes-with-prs create v3.1.3
expect_checksums notes-with-prs
expect_notes notes-with-prs

# Reusing a tag that already points at this build must still publish the
# generated notes as the Release body, not the tag's own message.
prepare_absent notes-reuse
set_state notes-reuse tag-v3.1.3 same
set_remote_tags notes-reuse "refs/tags/v3.1.2" "refs/tags/v3.1.3"
put_fixture notes-reuse compare.json "$fixtures/compare-mixed.json"
put_fixture notes-reuse prs.json "$fixtures/prs-mixed.json"
run_case notes-reuse reuse v3.1.3
expect_notes notes-reuse

prepare_absent notes-fix-only
set_remote_tags notes-fix-only "refs/tags/v3.1.2"
put_fixture notes-fix-only compare.json "$fixtures/compare-fix-only.json"
run_case notes-fix-only create v3.1.3
expect_notes_fix_only notes-fix-only

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
expect_checksums same-tag

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

# A prerelease backfilled after a newer stable tag exists must derive its range
# from the stable tag below its base version, not the repository-wide maximum:
# publishing v3.1.3-beta.2 after v3.1.5 compares from v3.1.2, never v3.1.5.
prepare_absent backfilled-prerelease
set_state backfilled-prerelease tag-v3.1.3-beta.2 same
set_state backfilled-prerelease release-v3.1.3-beta.2 absent
set_remote_tags backfilled-prerelease "refs/tags/v3.1.2" "refs/tags/v3.1.3" "refs/tags/v3.1.5"
put_fixture backfilled-prerelease compare.json "$fixtures/compare-fix-only.json"
run_case backfilled-prerelease reuse '' \
  env GITHUB_REF="refs/tags/v3.1.3-beta.2" GITHUB_REF_NAME="v3.1.3-beta.2"
grep -qF 'compare/v3.1.2...' "$work/cases/backfilled-prerelease/gh.log" \
  || { echo "FAIL backfilled-prerelease: range must start below the prerelease base version"; exit 1; }
if grep -qF 'compare/v3.1.5...' "$work/cases/backfilled-prerelease/gh.log"; then
  echo "FAIL backfilled-prerelease: repo-maximum stable tag used as range start"
  exit 1
fi
expect_notes_fix_only backfilled-prerelease

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

# A wrong manifest version must fail before any tag or release is considered,
# for both packages.
prepare_absent bad-manifest
run_case bad-manifest fail '' \
  bash -c '"$PYTHON" - artifacts/extension-chrome/rewards-3.1.3-chrome.zip '"'"'{"manifest_version":3,"version":"9.9.9","name":"fixture"}'"'"' <<'"'"'PY'"'"'
import json, sys, zipfile
path, payload = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", payload)
PY'

prepare_absent bad-manifest-firefox
run_case bad-manifest-firefox fail '' \
  bash -c '"$PYTHON" - artifacts/extension-firefox/rewards-3.1.3-firefox.zip '"'"'{"manifest_version":2,"version":"9.9.9","name":"fixture"}'"'"' <<'"'"'PY'"'"'
import json, sys, zipfile
path, payload = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", payload)
PY'

# Each target must keep its own manifest_version: Chrome MV3, Firefox MV2.
prepare_absent wrong-manifest-version-chrome
run_case wrong-manifest-version-chrome fail '' \
  bash -c '"$PYTHON" - artifacts/extension-chrome/rewards-3.1.3-chrome.zip '"'"'{"manifest_version":2,"version":"3.1.3","name":"fixture"}'"'"' <<'"'"'PY'"'"'
import json, sys, zipfile
path, payload = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", payload)
PY'

prepare_absent wrong-manifest-version-firefox
run_case wrong-manifest-version-firefox fail '' \
  bash -c '"$PYTHON" - artifacts/extension-firefox/rewards-3.1.3-firefox.zip '"'"'{"manifest_version":3,"version":"3.1.3","name":"fixture"}'"'"' <<'"'"'PY'"'"'
import json, sys, zipfile
path, payload = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", payload)
PY'

# A string-typed manifest_version ("3") must not pass as MV3.
prepare_absent string-manifest-version-chrome
run_case string-manifest-version-chrome fail '' \
  bash -c '"$PYTHON" - artifacts/extension-chrome/rewards-3.1.3-chrome.zip '"'"'{"manifest_version":"3","version":"3.1.3","name":"fixture"}'"'"' <<'"'"'PY'"'"'
import json, sys, zipfile
path, payload = sys.argv[1:]
with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("manifest.json", payload)
PY'

# A ZIP without a root manifest.json fails for either package.
prepare_absent missing-manifest-chrome
run_case missing-manifest-chrome fail '' \
  bash -c '"$PYTHON" - artifacts/extension-chrome/rewards-3.1.3-chrome.zip <<'"'"'PY'"'"'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("not-manifest.txt", "fixture")
PY'

prepare_absent missing-manifest-firefox
run_case missing-manifest-firefox fail '' \
  bash -c '"$PYTHON" - artifacts/extension-firefox/rewards-3.1.3-firefox.zip <<'"'"'PY'"'"'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("not-manifest.txt", "fixture")
PY'

echo "ALL LOCAL SCENARIOS PASSED"
echo "--- new version summary ---"
cat "$work/cases/new-version/accepted-summary"
echo "--- tag message ---"
cat "$work/cases/new-version/tag-message"
echo "--- release body with change sections ---"
cat "$work/cases/notes-with-prs/release-body"
