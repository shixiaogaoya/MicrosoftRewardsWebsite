# Feature Status

> 历史背景：下表描述的是迁移前的 Chrome、Firefox 分目录和移动应用（含 2.2.x 版本与分目录构建记录）。现行扩展的中文界面、无推广布局、折叠高级设置、停止本轮、每日自动总开关和设置校验，见仓库根目录 [README.md](../../README.md)；**当前的功能与验证状态（含自动化测试实际情况）以 [docs/feature-status.md](../feature-status.md) 为准**，本表不再更新。

Legend: ✅ implemented · 🟡 partial / unclear · ⛔ absent · 🔎 Needs Verification

## Browser extensions (Chrome + Firefox)

| Feature | Status | Notes |
|---------|--------|-------|
| Manual "Get rewards" run | ✅ | Popup button → background opens N Bing tabs. |
| Auto daily run on browser startup | ✅ | `onStartup` + `lastOpened` date gate, `active` setting. |
| Open daily-set tasks automatically | ✅ | `content.ts` on `rewards.bing.com`, `autoDaily` setting. |
| Configurable # searches / delay / close-time | ✅ | Popup inputs → `storage.sync`. |
| Words vs random-string queries | ✅ | `useWords` toggle. |
| Start/stop mid-run | ✅ | Stop button → `sendStopSearch` clears alarms. |
| Randomized query + jittered timing | ✅ | Human-like intent; effectiveness 🔎. |
| Referral link handling | 🟡 | `setupRewardsLink` implemented but **commented out** in popup. |
| TypeScript source ↔ shipped parity | ✅ | Rebuilt 2026-07-15; `src/` now generates `prod/dist/`. |
| Chrome/Firefox version alignment | ✅ | Both source manifests now 2.2.7 (aligned 2026-07-15). ⚠️ store uploads must keep versions monotonic. |
| Automated tests | ⛔ | None.（迁移前记录；现行 `wxt/` 已有 Vitest 套件并在 CI 执行，见 [docs/feature-status.md](../feature-status.md)） |

## Mobile app (Flutter)

| Feature | Status | Notes |
|---------|--------|-------|
| Microsoft login via in-app WebView | ✅ | `login_screen.dart`; session in WebView cookies. |
| Logout | ✅ | Recent commit "logout for mobile app". Details 🔎. |
| Run N automated searches with delay | ✅ | `SearchBloc` → `PerformSearch` → repo → WebView. |
| Progress reporting | ✅ | `onProgress` → `SearchInProgress(current,total)`. |
| Cancel a run | ✅ | `SearchCancellationToken` + `CancelSearchEvent`. |
| Random sentence generation | ✅ | `word_generator` via `search_words.dart`. |
| Local notifications | 🟡 | `NotificationService.init()` wired; cadence/triggers 🔎. |
| Keep-awake during run | ✅ | `wakelock_plus` dependency present; usage 🔎. |
| Daily-set automation (like the extensions) | 🔎 | Not confirmed in mobile; may be search-only. |
| Play Store distribution | 🔎 | Popup links a Play Store id; live status unconfirmed. |
| Automated tests | ⛔ | Only the default `widget_test.dart`.（迁移前记录；现移动端有 `test/search_bloc_test.dart`，CI 已于 2026-11-08 转阻塞且 analyze/test 通过，见 [docs/feature-status.md](../feature-status.md)） |

## Cross-cutting

| Item | Status |
|------|--------|
| Backend / DB / owned auth | ⛔ (by design) |
| CI/CD | ✅ GitHub Actions (extensions gate strict; mobile non-blocking) |
| Telemetry | 🔎 (external help/uninstall page hits only, assumed) |
| Build reproducibility (extensions) | ✅ (npm run build) |
| Build reproducibility (mobile) | ✅ (standard Flutter) |
