# 当前功能与验证状态

> 本表描述**现行**扩展（`wxt/`，Chrome MV3 / Firefox MV2 同源构建）与移动端的实际状态，随交付更新。`docs/ecc/` 下的各篇是 WXT 迁移前的历史设计记录，其表内说法以本篇为准。使用说明见仓库根目录 [README.md](../README.md)。
>
> 状态记录日期：2026-11-07 · 扩展版本 3.1.5。

## 验证基线

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 类型检查 | ✅ 通过 | `npm --prefix wxt run compile`（tsc --noEmit）。 |
| 扩展单元测试 | ✅ 通过 | `npm --prefix wxt run test`（Vitest，2026-11-07 为 25 个文件 296 项，覆盖后台任务、调度、识别、弹窗与工具函数；测试文件只放在 `entrypoints/` 子目录，避免被 wxt 当作入口）。 |
| 发布脚本夹具测试 | ✅ 通过 | 仓库根 `bash .github/scripts/publish-release.test.sh` 与 `publish-cws.test.sh`，全程用桩，不访问真实发布端点；CI 的扩展作业也会执行。 |
| CI（`ci.yml`） | ✅ 扩展作业阻塞 / ⚠️ 移动作业不阻塞 | 扩展作业**仅在 pull request 触发**，执行夹具测试 + compile + test + 双端 build；master 推送由 `build.yml` 验证（夹具测试 + compile + test + 双端打包），`ci.yml` 绿不代表 master 检查通过。移动作业的 `flutter analyze` 与 `flutter test` 均带 `continue-on-error` 且近期实际失败，**CI 绿不能当作移动端通过**。 |
| 真实浏览器验收 | ⚠️ 部分未做 | 弹窗保存提示、停止/重试真机流程、后台与电脑休眠唤醒、125%/150% 缩放与键盘可达性尚未完成实机验收；真实 Rewards 账号的页面兼容性与积分到账未验证。明细见 README「已知问题与验证范围」。 |

## 扩展功能（wxt/）

| 功能 | 状态 | 验证方式 |
| --- | --- | --- |
| 一键执行搜索 / 每日活动 / 领取积分，可任意组合 | ✅ | `background/`、`utils/` 单测；轮次冻结配置（`runState.ts`）。 |
| 停止本轮（含延迟导航与页面归属判定） | ✅ | `background/taskRun.test.ts`、`utils/oncePerPageRun` 相关单测；真机验收未做。 |
| 单项重试，保留其他任务的最近结果并标注轮次/时间 | ✅ | `background/taskRun.test.ts`、`popup/App.test.tsx`（最近结果与轮次标注）。 |
| 结果模型带 `runId`/`at`/结构化 `cause`/`recognizerVersion` | ✅ | `utils/runState.ts` 与 `utils/rewardsRecognition.test.ts`；识别器当前版本 v1，cause 为封闭枚举。 |
| 每日活动 / 领取识别（未登录、无待领取、结构未知等判读） | ✅ 代码内样本 | 两类夹具来源不同：真实脱敏样本仅覆盖**未登录页**（`utils/fixtures/rewards-signed-out.html`）；每日活动网格与领取弹层用**测试中构造的合成 DOM**（`utils/rewardsRecognition.test.ts`、`utils/claimFlow.test.ts`），登录后页面的识别证据以合成夹具为准，未经真实页面验证；页面改版后需补样本。 |
| 设置读写门控（读取失败禁改、保存中不接受启动、失败可重试） | ✅ | `hooks/useStorage`、`popup/App.test.tsx`；真实浏览器保存提示未核对。 |
| 每日自动执行（启动检查 + 约 6 小时闹钟 + 当日去重） | ✅ | `background/dailySchedule.test.ts`。 |
| 脱敏诊断导出（预览后本地下载 JSON） | ✅ | `popup/diagnostics.test.ts`（白名单字段、敏感内容不导出）、`popup/App.test.tsx`（入口在高级设置、预览即导出内容）。字段：扩展版本、浏览器 User-Agent（含操作系统版本等环境信息）、轮次与调度时间、任务状态、结构化原因、识别器版本。 |

## 发布管线

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| 构建 + Release（`build.yml`） | ✅ 在用 | 同一提交完成类型检查、单测、Chrome/Firefox 打包与发布脚本夹具测试；正式版本取 `wxt/package.json` 的 `version`。 |
| Chrome 商店提审（`publish-cws.yml`） | ✅ 在用 | **触发条件：`master` 分支构建（含在 `master` 上勾选确认的手动运行）且 `release` 作业输出有效正式版本**（`store_release_tag` 非空）时自动上传 Chrome ZIP 并提审；标签推送创建的 Release、未勾选确认或不在 `master` 的手动运行**不会**触发提审。请求体固定 `{"publishType":"DEFAULT_PUBLISH","skipReview":false,"blockOnWarnings":true}`，**审核通过后由商店自动上线**，无需人工在后台点发布。README「发布到 Chrome 网上应用店」一节是现行发布指南。 |
| 上线记录 | 🔎 | README 记录 2026-11-04 `v3.1.4` 在 Actions 验证过 WIF 认证、读取状态、上传与提审（返回 `PENDING_REVIEW`）；自动调用链与同提交重跑的恢复路径仍需在真实 Actions 中观察。 |

## 移动端（microsoft_rewards_app/）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 分析与测试 | ⚠️ 本地/CI 均未通过 | CI 中 `flutter analyze`、`flutter test` 带 `continue-on-error` 且近期失败；未完成移动端维护基线（A12：取消不变成功、常亮资源释放、业务测试真实通过）。 |
| 发布 | ⛔ 未发布 | 无商店渠道；`.apk` 随 GitHub Release 附带的旧流程未恢复。 |
