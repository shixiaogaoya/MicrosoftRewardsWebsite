# Coding Standards

> 历史背景：本篇观察的是迁移前「无打包器、全局脚本」的旧代码。现行扩展在 `wxt/`，是 WXT + React + TypeScript 的 ESM 模块（有 `import`/`export`，由 WXT 打包），测试用 Vitest。下文仅供了解旧约束的来历，不再约束新代码。

Conventions observed in the codebase (descriptive, not prescriptive). Where the repo is
inconsistent, that is noted.

## Browser extensions (TypeScript)

- **Module style:** plain global scripts — no `import`/`export`. Files are loaded
  directly by the manifest (service worker / background / content / popup). Keep it this
  way unless you introduce a bundler; top-level function/const names must stay unique
  across the files compiled together in one `tsconfig`.
- **Naming:** `camelCase` functions/vars, `UPPER_SNAKE_CASE` module constants
  (`DEFAULT_SEARCHES`), `PascalCase` types.
- **Typing:** `strict` is on. Precise DOM types via `as HTMLButtonElement` etc.;
  non-null assertions (`!`) where the original logic already assumes presence (e.g.
  `tab.id`, `document.body`, `getElementById`). Chrome uses precise `chrome.*` types;
  Firefox listener params use minimal structural types (`{ action: string }`,
  `{ status?: string }`) because of `firefox-webext-browser` naming.
- **Async:** `async/await` in Firefox (promise APIs); Chrome mixes callbacks
  (`chrome.storage.sync.get(keys, cb)`) with `await` where the API returns a promise.
- **Settings access:** all persistent state goes through `storage.sync` (or
  `storage.local` for referral). Do not add ad-hoc globals for state.
- **Do NOT reformat the emitted `prod/dist/*.js` by hand** — it is generated. Edit
  `src/*.ts` and rebuild.

## Known preserved quirks (intentional — do not "fix" silently)

- `parseInt(x) ?? DEFAULT` never falls back (parseInt returns `NaN`, not nullish). This
  is a latent bug preserved verbatim from the shipped code. Changing it is a **behavior
  change** — do it deliberately, with a test.
- Chrome vs Firefox diverge in small ways on purpose-by-accident: `innerHTML` (Chrome)
  vs `textContent` (Firefox) for button text; `substring(2,3)` vs `charAt(2)` for the
  random lead char; `Math.max(delay, 0.1)` alarm floor exists only on Firefox. Treat
  these as per-file logic until a decision is made to reconcile them.

## Mobile app (Dart / Flutter)

- **Architecture:** Clean Architecture — `data` / `domain` / `presentation` per feature;
  `core/` for cross-cutting concerns. Respect the dependency direction (presentation →
  domain → data; nothing points back up).
- **State:** `flutter_bloc`; events/states are `Equatable`, immutable.
- **DI:** register in `core/di/injection_container.dart` (`sl`). BLoCs as factories,
  services/repos/use-cases as lazy singletons.
- **Constants/strings:** centralize in `core/constants/` (`AppConstants`, `Strings`);
  avoid magic numbers and inline literals.
- **Naming:** `snake_case.dart` filenames (with one exception:
  `SearchCancellationToken.dart` is PascalCase — inconsistent, prefer snake_case going
  forward). Classes/types `PascalCase`.
- **Errors:** funnel through `core/utils/error_handler.dart`
  (`ErrorHandler.getErrorMessage` / `logError`); surface user-friendly messages via
  BLoC failure states.

## Git conventions

- Short, imperative commit subjects (`"Firefox version fix"`, `"logout for mobile app"`).
  No conventional-commit prefixes historically — the team convention going forward
  (per project rules) is `type: description` (feat/fix/refactor/…).
- Single `master` branch; no PR history in the repo.

## Testing

- Effectively none today (one default Flutter widget test). See `feature_status.md` and
  `roadmap.md`. Target per project rules: 80% coverage, TDD for new work.
