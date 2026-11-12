# Klickbait Killa

A Firefox addon that helps you decide what's worth watching on YouTube. Click **Summarize** on a video or thumbnail to get a short AI summary of its transcript and an honest verdict on whether it deserves your time. It uses your own API key from Google Gemini, Anthropic or OpenAI.

See [SPEC.md](SPEC.md) for the full design and [PRIVACY.md](PRIVACY.md) for what data goes where.

Not affiliated with YouTube or Google.

## Status

- Not yet available in the Firefox store.
- Works on live YouTube with a real Gemini key. Anthropic and OpenAI are marked **experimental**: they're only tested against mocks.
- Testing consists of the unit tests in this repo, plus manual testing on live YouTube.

Built with [Claude Code](https://claude.com/claude-code).

## Development

Requires Node.js 20 or newer and Firefox 140 or newer.

```sh
npm install
npm run check    # type check, tests, build and addon lint
npm run build    # build into dist/
npm run start    # run in a temporary Firefox profile
npm run package         # create a store-ready zip in artifacts/
npm run package:source  # zip the committed source (git HEAD) for store reviewers
```

To load it in your own Firefox, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `dist/manifest.json`.

## Build for reviewers

The addon is TypeScript bundled with esbuild. The output isn't minified or obfuscated, and there are no runtime dependencies.

Requirements: Node.js 20 or newer and npm 10 or newer, on any OS. The submitted build used Node.js 25.2.1 and npm 11.6.2, and CI checks every commit on Node.js 24. The output doesn't depend on the Node.js version, because esbuild does the bundling and its exact version is pinned.

```sh
npm ci
npm run build
```

This writes the addon to `dist/`, which is identical to the submitted package. `npm run package` produces the zip.

## Licence

[MIT](LICENSE)
