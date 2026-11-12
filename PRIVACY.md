# Klickbait Killa Privacy Policy

Last updated: [date of AMO submission]
Contact: open an issue at https://github.com/jkremb/klickbait-killa/issues

Klickbait Killa doesn't run any servers and has no analytics, telemetry or ads. The developer never receives your data, so the developer doesn't hold or process any personal data about you.

## What the addon sends, and when

The addon sends data only after you click Summarize.

| Recipient | What is sent | Why |
|---|---|---|
| The AI provider you chose (Anthropic, OpenAI or Google) | The video's title, channel, duration and transcript, your summary preferences, and your API key | To generate the summary |
| YouTube | Requests for the video's page and transcript, made through your normal browser session, including your YouTube login if you have one | To get the transcript |

Your API key is sent only to the provider it belongs to, to authenticate your requests. Firefox shows this as "authentication information" and the video content as "website content" when you install the addon.

Your chosen provider handles this data under its own terms, using your account. Outside the EEA, Switzerland and the UK, Google says it may use content sent on Gemini's free tier to improve its products. On the paid tier, and on free use in those regions, it says it doesn't.

## What is stored on your device

| Data | Protection |
|---|---|
| API keys | Encrypted with your passphrase (AES-256-GCM, with a key derived using PBKDF2). While unlocked, the decrypted keys stay in Firefox's memory until you close it or choose Lock now |
| Summaries, with each video's title and channel | Not encrypted. Kept for 30 days by default, and at most 500 are kept |
| Settings | Not encrypted |

Transcripts aren't saved. Nothing is synced between devices. Someone with access to your Firefox profile could see which videos you summarized.

Encryption doesn't protect your key from malware running while the addon is unlocked, or if your passphrase is weak.

## Your choices

In settings you can clear saved summaries, lock the addon, turn off feed features, or delete everything with a full reset. Uninstalling the addon also removes its stored data. To remove data held by your AI provider, contact that provider.

## Not affiliated

Klickbait Killa is not affiliated with YouTube, Google, Anthropic or OpenAI.
