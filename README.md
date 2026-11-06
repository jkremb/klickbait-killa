# Klickbait Killa

A Firefox addon that helps you decide what's worth watching on YouTube. Click **Summarize** on a video or thumbnail to get a short AI summary of its transcript, using your own Anthropic, OpenAI or Gemini API key.

See [SPEC.md](SPEC.md) for the full design and [PRIVACY.md](PRIVACY.md) for what data goes where.

## Development

Requires Node.js 20 or newer and Firefox 140 or newer.

```sh
npm install
npm run check    # type check, tests, build and addon lint
npm run build    # build into dist/
npm run start    # run in a temporary Firefox profile
npm run package  # create a store-ready zip in artifacts/
```

To load it in your own Firefox, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `dist/manifest.json`.

## Build for reviewers

`npm ci && npm run build` reproduces `dist/` from source. The output isn't minified.

## Before publishing

- Replace the placeholder addon ID in `static/manifest.json`.
- Set `ISSUES_URL` and `DONATE_URL` in `src/shared/config.ts`.
- Add the contact details and date to `PRIVACY.md`.
- Recheck prices in `src/background/pricing.ts`.
