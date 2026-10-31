# Roadmap

Prioritized, non-binding. Grouped by horizon. Avoids rewrites; each item is incremental.

## Immediate (days) — low risk, high leverage

> ✅ **All four completed 2026-07-15.** Firefox rebuilt & version aligned to 2.2.7;
> stale v1.3 root files moved to `chrome/legacy/`; CI added
> (`.github/workflows/ci.yml`); zip/apk artifacts untracked + gitignored.
> Retained below for the record.

1. **Wire Firefox build parity & confirm versions.** Verify `firefox/prod/manifest.json`
   version and that `prod/dist` matches `src`. Align Chrome (2.2.7) and Firefox versions
   intentionally. *(Trade-off: none; pure hygiene.)*
2. **Decide the fate of stale root `chrome/` artifacts** (`manifest.json` v1.3,
   `chrome/dist/`, `popup.html`, `styles/`). Move to `chrome/legacy/` or delete.
   *(Trade-off: deleting loses nothing tracked; keeps repo honest.)*
3. **Add a minimal CI** (GitHub Actions): `npm ci && npm run typecheck && npm run build`
   on push, and `flutter analyze && flutter test` for the app. *(Catches the src↔dist
   drift that caused the original confusion.)*
4. **Stop committing `prod*.zip` and the 23 MB `.apk`.** Move release artifacts to
   GitHub Releases; gitignore them. *(Trade-off: history already carries the bloat —
   full cleanup needs history rewrite, deferred to long-term.)*

## Medium-term (weeks)

> ✅ **5、6、8 已由 WXT 迁移完成。** Chrome 与 Firefox 共用 `wxt/`，不再分两套源码；单元测试在 `wxt/entrypoints/**/*.test.ts`；非法数字不再被 `parseInt(...) ?? default` 放过，读写都走 `wxt/entrypoints/utils/settings.ts` 的范围校验。第 7 项仍未完成。

5. **De-duplicate Chrome/Firefox logic.** ✅ 完成：WXT 单代码库同时构建 Chrome MV3 与 Firefox MV2。
6. **Add a test suite.** ✅ 扩展侧已有 Vitest。移动应用的 `bloc_test` 不在本次范围。
7. **Harden the Bing DOM dependency.** The daily-set selectors are brittle. Add a
   fallback/logging path so a Microsoft markup change fails loudly, not silently.
8. **Fix or formally accept the `parseInt(x) ?? DEFAULT` bug.** ✅ 完成：非法或越界值使用该字段默认值，范围内的整数原样保留。

## Long-term (months)

9. **Single source of truth for the words list and settings schema** shared across all
   three clients (generate the Dart and TS from one file).
10. **Repo history cleanup** (remove large binaries via `git filter-repo`) — coordinate,
    since it rewrites history.
11. **Resilience/robustness pass on the mobile app** — notification scheduling, WebView
    error states, background execution limits on modern Android/iOS.
12. **ToS / compliance decision** documented as an ADR (see `architecture.md` risk note).

## Explicitly NOT recommended

- A full rewrite or a heavyweight framework (React/Svelte popup, native mobile). The
  current footprint is appropriate for the problem; complexity would be net-negative.
