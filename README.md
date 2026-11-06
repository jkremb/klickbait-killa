# Klickbait Killa

A Firefox addon that helps you decide what's worth watching on YouTube. Click **Summarize** on a video or thumbnail to get a short AI summary of its transcript and an honest verdict on whether it deserves your time. It uses your own API key from Gemini (which has a free tier), Anthropic or OpenAI.

See [SPEC.md](SPEC.md) for the full design and [PRIVACY.md](PRIVACY.md) for what data goes where.

Not affiliated with YouTube or Google.

## Status

- Not yet available in the Firefox store, and the addon ID is still a placeholder.
- Works on live YouTube with a real Gemini key. The Anthropic and OpenAI integrations are only tested against mocks.
- Testing consists of the unit tests in this repo, plus manual testing on live YouTube.

Built with [Claude Code](https://claude.com/claude-code).

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

## Licence

[MIT](LICENSE)
