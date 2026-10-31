# Onboarding — Microsoft Automatic Rewards

> 历史背景：这篇是 WXT 迁移前的入门说明，其中 `chrome/src`、`firefox/src` 和根目录 `npm run build` 已不是现行路径。现在只改 `wxt/`，命令是 `npm --prefix wxt run compile|test|build|build:firefox`。本地加载方式和间隔 0、关闭时间 0 的含义见仓库根目录 [README.md](../../README.md)。

> For a new engineer joining this project. Read this first, then `architecture.md` and `tech_stack.md`.

## What this project is

A **personal-automation tool that farms Microsoft Rewards points** by running Bing
searches (and clicking the daily "sets") on the user's behalf. Microsoft grants points
for daily Bing activity; this project automates it so the user hits the daily maximum
with no manual effort.

It ships as **three independent clients** in one repo:

| Client | Path | What it is |
|--------|------|-----------|
| Chrome extension | `chrome/prod/` | Manifest V3, service worker. Published on the Chrome Web Store. |
| Firefox extension | `firefox/prod/` | Manifest V2, background scripts. Published on Mozilla Add-ons. |
| Mobile app | `microsoft_rewards_app/` | Flutter (Android/iOS), drives Bing inside an in-app WebView. |

There is **no backend, no database, and no authentication we own**. Each client relies
on the user already being signed into their Microsoft account in that browser/WebView.
"Earning points" is a side effect of loading `bing.com/search` URLs.

> ⚠️ The repo name says "Website" but there is no web app here. The "website"
> (`svitspindler.com/microsoft-automatic-rewards`) is an external help/landing page the
> clients link to.

## Critical thing to know before you touch anything

**Shipped code lives in `<ext>/prod/`, not at the top level.**

- Real Chrome extension: `chrome/prod/` (`manifest.json` v2.2.7).
- Real Firefox extension: `firefox/prod/`.
- **Stale/legacy:** the root-level `chrome/manifest.json` (v1.3.0), `chrome/dist/`,
  `chrome/popup.html`, `chrome/styles/`, and `chrome/legacy/` are old v1.x artifacts.
  Ignore them.

## How the build works (set up 2026-07-15)

TypeScript source now compiles to the shipped JS:

- `chrome/src/{background,content,popup}.ts` → `chrome/prod/dist/*.js`
- `firefox/src/{background,content,popup}.ts` → `firefox/prod/dist/*.js`

Commands (from repo root):

```bash
npm install          # dev deps: typescript, @types/chrome, @types/firefox-webext-browser
npm run build        # build:chrome + build:firefox → emits into each prod/dist
npm run typecheck    # tsc --noEmit for both extensions
```

Flutter app:

```bash
cd microsoft_rewards_app
flutter pub get
flutter run          # or: flutter build apk
```

## Deployment (all manual)

- Chrome Web Store, Firefox Add-ons: zip the `prod/` folder and upload
  (see the many `chrome/prod/prod*.zip` files — one per version, versioned by hand).
- Mobile: `.apk` attached to a GitHub Release. Play Store listing referenced in the
  popup — **Needs Verification** whether it is live.

## Where to look

| I want to… | Look at… |
|---|---|
| Change Chrome behavior | `chrome/src/{background,content,popup}.ts` → `npm run build:chrome` |
| Change Firefox behavior | `firefox/src/{background,content,popup}.ts` → `npm run build:firefox` |
| Change the mobile search logic | `microsoft_rewards_app/lib/features/search/` |
| Change the search word list | `words[]` in each ext `background.ts`; mobile `.../data/dataSources/search_words.dart` |
| Adjust defaults / limits | `DEFAULT_*` consts (extensions); `core/constants/app_constants.dart` (mobile) |

## Contact / links

- Help page: `https://svitspindler.com/microsoft-automatic-rewards`
- GitHub: `https://github.com/spin311/MicrosoftRewardsWebsite`
