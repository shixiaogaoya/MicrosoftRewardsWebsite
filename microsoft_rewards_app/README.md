# microsoft_automatic_rewards（移动端）

Microsoft Rewards 自动搜索的实验性 Flutter 应用，与 `wxt/` 目录下的浏览器扩展同仓库存放，但**单独组织、独立维护**：它不随扩展一起交付，不参与扩展的版本发布，也没有对外发布的 Android/iOS 安装包。对应优化计划的 A12/F10（移动端维护基线）。

## 当前支持与维护范围

- **实验模块**：可以运行基本流程，但没有承诺的维护等级；功能或平台行为变化时可能随时失效。
- **验证状态**：仓库维护环境在 2026-11 的改动时没有可用的 Flutter 工具链，`flutter pub get`、`flutter analyze` 与 `flutter test` 均未在本地运行过；新增的 `flutter_lints` dev 依赖只改了 `pubspec.yaml`，`pubspec.lock` 尚未重新生成，以 lockfile 为准的环境（`--enforce-lockfile` / `--offline`）会解析失败，需先在有工具链的环境运行 `flutter pub get` 同步 lock。CI（`.github/workflows/ci.yml` 的 `mobile` job）中这两步仍带 `continue-on-error: true`，整体 CI 绿色**不代表**移动端通过；请查看该 job 自身的步骤状态。
- **未固定 Flutter 版本**：CI 使用 stable channel 的最新版，工具链差异可能引入新的分析或测试失败。

## 功能（以代码为准）

- 内嵌 WebView 打开 Bing 登录页，登录状态记录在本机 `shared_preferences`（`loggedIn`）。
- 设置搜索次数与搜索间隔（默认 22 次 / 20 秒），自动在 WebView 中逐条执行 Bing 搜索并显示进度。
- 搜索进行中可取消；取消、失败与完成都会释放屏幕常亮（`wakelock_plus`），页面退出时兜底释放。
- 可选"搜索期间保持屏幕常亮"与每日提醒通知（本地通知，需通知权限）。
- 登出时删除本机 WebView 的 Cookie 与 WebStorage 数据。

## 构建与测试

```bash
cd microsoft_rewards_app
flutter pub get
flutter analyze
flutter test
flutter build apk --release   # 仅本地构建，本仓库不发布安装包
```

## 测试

- `test/login_status_test.dart`：Bing 登录回调 URL 的判定。
- `test/search_bloc_test.dart`：`SearchBloc` 的取消（取消后不得被 `SearchSuccess` 覆盖）、正常完成与失败路径。

## 隐私说明的边界

仓库根 `docs/PRIVACY.md` 是**浏览器扩展**的隐私政策，描述的是扩展的存储与网络行为，**不适用于本应用**，请不要把它当作移动端的隐私说明。

就代码可见的范围：本应用通过内嵌 WebView 在设备上直接访问 `bing.com` / `rewards.bing.com` 并处理 Microsoft 登录会话，登录 Cookie 与 WebView 数据保存在设备上，登出时清除；搜索次数、间隔、提醒设置保存在本机 `shared_preferences`。应用内未包含遥测或数据上传代码；界面的 "Help" 链接会在 WebView 中打开外部站点 `svitspindler.com`。本段是对源码的静态说明，不构成已通过安全或隐私审计的结论；正式发布前需要单独编写移动端隐私政策。

## 许可

与仓库根目录一致：MIT License，Copyright (c) 2024 spin311。
