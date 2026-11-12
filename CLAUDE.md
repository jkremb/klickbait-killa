# CLAUDE.md

Klickbait Killa is a Firefox (desktop, MV3, min 140) addon that summarizes YouTube videos from their transcripts using the user's own API key (Gemini, Anthropic or OpenAI). TypeScript, esbuild, no UI framework, no runtime dependencies.

[SPEC.md](SPEC.md) is the source of truth for product behavior, security rules and error messages. Read the relevant section before changing behavior, and update it when a decision changes. [PRIVACY.md](PRIVACY.md) must stay accurate about what data is sent where.

## Commands

```sh
npm run check       # typecheck + tests + build + web-ext lint (run before committing)
npm run typecheck   # tsc --noEmit (covers src/ and test/)
npm test            # vitest run
npx vitest run test/jobs.test.ts        # single file
npx vitest run -t "name of test"        # single test
npm run build       # esbuild -> dist/ (wipes dist/, copies static/)
npm run watch       # rebuild on change
npm run start       # web-ext run in a temp Firefox profile on youtube.com
npm run package     # zip into artifacts/
```

There's no vitest config file; tests default to the Node environment. DOM tests opt in with `// @vitest-environment happy-dom` at the top of the file (see [test/render.test.ts](test/render.test.ts)).

## Architecture

Three bundles, built by [build.mjs](build.mjs) as IIFEs (unminified on purpose, for AMO reviewers):

- **Background** ([src/background/index.ts](src/background/index.ts)): owns the encrypted key vault, provider calls, the job queue and the summary cache. Wires browser APIs into `JobManager`.
- **Content script** ([src/content/index.ts](src/content/index.ts)): runs on youtube.com. Injects the watch-page panel ([watch.ts](src/content/watch.ts)) and the feed hover button + popover ([feed.ts](src/content/feed.ts)), both rendering through `SummaryView` ([view.ts](src/content/view.ts)). It also **fetches transcripts**, because that needs YouTube's same-origin context.
- **Extension pages** ([src/pages/](src/pages/), HTML in [static/pages/](static/pages/)): welcome wizard, options, and the unlock frame (embedded in the YouTube page as a web-accessible iframe, or opened as a popup window).

### Messaging

All message types are in [src/shared/types.ts](src/shared/types.ts).

- Content ↔ background: one long-lived `runtime.Port` named `"klickbait"` per tab (`ToBackground` / `ToContent`). [src/content/client.ts](src/content/client.ts) wraps it, reconnects lazily, and marks in-flight jobs `BACKGROUND_RESTARTED` if the port drops.
- Extension pages → background: one-shot `runtime.sendMessage` (`PageRequest` / `PageResponse`). The background rejects these unless `sender.url` is an extension URL, so content scripts can never unlock the vault or read keys.

### Job flow ([src/background/jobs.ts](src/background/jobs.ts))

`request` → cache hit returns immediately; otherwise the job is `queued` → `fetching` (background sends `fetch_transcript` to the *owner* tab, which replies with `transcript` or `transcript_error`) → `needs_unlock` / `needs_confirmation` (cost preflight) → `queued` again → `streaming` → `done` (cached) / `failed` / `cancelled`.

- Jobs are keyed by video ID; a second request for the same video joins the existing job as a viewer.
- At most `MAX_CONCURRENT_JOBS` (3) are `fetching`/`streaming`; the rest queue FIFO via `pump()`.
- Closing a view (`detach`) doesn't cancel a running job. Jobs waiting on unlock/confirmation with no viewers are dropped (no money spent yet). If the owner tab disconnects before the transcript arrives, the job is dropped.
- One automatic retry on `RATE_LIMITED`, only before any text has streamed and only if `Retry-After` ≤ 30s.
- Partial text from a failed stream is shown but never cached.
- The background keeps itself alive with a periodic API call only while jobs are active (Firefox unloads idle event pages).
- `JobManager` takes all browser access through `JobDeps`, which is how [test/jobs.test.ts](test/jobs.test.ts) tests it without a browser.

### Other modules

- [src/youtube/](src/youtube/): **all YouTube-specific knowledge lives here** (DOM selectors in [page.ts](src/youtube/page.ts), undocumented data formats in [transcript.ts](src/youtube/transcript.ts)). Transcript routes in order: `get_panel` request → plain caption URL → reading the transcript panel in the page (watch page only). Cues are merged into ~30s `[mm:ss] text` blocks. `pageFetch` uses Firefox's `content.fetch` so requests are same-origin page requests.
- [src/providers/](src/providers/): one `Provider` per API (`stream` yields text deltas, `testKey`). Shared SSE parser, HTTP-error → `ErrorCode` mapping (`errorFromResponse`, which sniffs error bodies for credits/context-length) and `providerFetch` are in [types.ts](src/providers/types.ts). Gemini's key goes in a header, never the URL.
- [src/background/prompt.ts](src/background/prompt.ts): fixed system prompt + delimited user message (`<video_metadata>`, `<transcript>`, escaped). **Bump `PROMPT_VERSION`** when a prompt change should invalidate cached summaries (it's part of the cache key).
- [src/background/pricing.ts](src/background/pricing.ts): curated model table (prices, context limits, `PRICES_CHECKED` date) and `preflight()` (chars ÷ 4 token estimate; confirm above cost limit; refuse above context limit).
- [src/background/cache.ts](src/background/cache.ts): `storage.local`, keyed by prompt version + video + provider + model + language + detail + hash of custom instructions. Expires by age, capped at 500 entries.
- [src/background/vault.ts](src/background/vault.ts): PBKDF2 (600k) → AES-256-GCM in `storage.local`; decrypted keys only in `storage.session`.
- [src/content/render.ts](src/content/render.ts): parses model output into a fixed set of blocks and builds DOM with `textContent`.
- [src/shared/](src/shared/): types, settings (`storage.local` key `"settings"`, merged over `DEFAULT_SETTINGS`), `describeError` (user-facing message + actions for every `ErrorCode`), and constants in [config.ts](src/shared/config.ts) (`ISSUES_URL` / `DONATE_URL` are blank until publishing).

## Rules that must not be broken

These come from SPEC.md sections 4, 5, 6, 8 and 12:

- **API keys and the passphrase never reach the content script or the YouTube page.** Passphrase entry happens only in extension-origin pages (unlock iframe/popup, options, wizard).
- **Never use `innerHTML` with model output.** Model output never becomes a link or image. Only timestamps are clickable, and only after they're validated against the video's length.
- **YouTube access limits:** no attestation tokens, no imitating YouTube's apps, no proxies or developer servers, nothing fetched before a user click, never play a video to get a transcript.
- Injected UI lives only in the addon's own closed Shadow DOM hosts (`<klickbait-killa>`, via [ui.ts](src/content/ui.ts)). Never remove, hide or alter YouTube's elements or ads.
- YouTube reuses card elements: read the video ID from the card at interaction time (`readCard`), never store it on the element, and use delegated listeners.
- No telemetry, no remote code, no minification. Data goes only to YouTube and the user's chosen provider.
- Every failure becomes a typed `AddonFailure` / `ErrorCode` with a message in `describeError`. Raw errors must never reach the user. `step` fields are for issue reports and must never contain keys or transcript text.
- Transcripts are not cached and are never silently truncated.

## Conventions

- Strict TypeScript with `noUncheckedIndexedAccess` and `noUnusedLocals`. Firefox APIs come from the global `browser` (`@types/firefox-webext-browser`), not `chrome`.
- The content stylesheet is imported as a string (`.css` text loader, declared in [css.d.ts](src/content/css.d.ts)) and injected into each shadow root.
- Tests use synthetic data shaped like real YouTube/provider responses. Don't commit real captions.
- Comments explain *why* (constraints, YouTube quirks), not what. User-facing text is plain, specific English.
- Only Gemini has been verified against the real API. The Anthropic and OpenAI request and stream formats are tested only against mocks, so check provider docs when changing them.
- `private/` and `LEGAL_NOTES.md` are gitignored local notes; don't commit them.
