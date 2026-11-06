import { MAX_CONCURRENT_JOBS } from "../shared/config";
import { AddonFailure } from "../shared/errors";
import { resolveLanguage, type Settings } from "../shared/settings";
import type { Provider, SummaryRequest } from "../providers/types";
import type { CacheEntry, CacheIdentity } from "./cache";
import { findModel, OUTPUT_TOKENS, preflight } from "./pricing";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import type {
  AddonError,
  CostConfirmation,
  JobStatus,
  JobView,
  ProviderId,
  ToBackground,
  ToContent,
  TranscriptResult,
} from "../shared/types";

/** A tab's connection. `send` must not throw if the tab has gone away. */
export interface Client {
  send(message: ToContent): void;
}

export interface JobDeps {
  loadSettings(): Promise<Settings>;
  browserLanguage(): string;
  unlockedKeys(): Promise<Partial<Record<ProviderId, string>> | undefined>;
  hasPermission(provider: ProviderId): Promise<boolean>;
  provider(id: ProviderId): Provider;
  cacheKey(identity: CacheIdentity): Promise<string>;
  cacheGet(key: string, cacheDays: number): Promise<CacheEntry | undefined>;
  cachePut(key: string, entry: CacheEntry, cacheDays: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Called with the number of running jobs whenever it changes. */
  onActiveChange?(active: number): void;
}

interface Job {
  videoId: string;
  key: string;
  settings: Settings;
  language: string;
  status: JobStatus;
  text: string;
  owner: Client;
  viewers: Set<Client>;
  result?: TranscriptResult;
  confirmed: boolean;
  confirm?: CostConfirmation;
  abort?: AbortController;
}

const MAX_AUTO_RETRY_SECONDS = 30;
const DEFAULT_RETRY_SECONDS = 5;

function toAddonError(error: unknown, provider: ProviderId): AddonError {
  return error instanceof AddonFailure ? error.detail : { code: "PROVIDER_ERROR", provider, step: "unexpected" };
}

export class JobManager {
  /** Keyed by video ID, since a tab shows one summary per video at a time. */
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: JobDeps) {}

  async handle(client: Client, message: ToBackground): Promise<void> {
    switch (message.t) {
      case "request":
        return this.request(client, message.videoId, message.regenerate ?? false);
      case "status":
        return this.status(client, message.videoId);
      case "transcript":
        return this.receiveTranscript(message.videoId, message.result);
      case "transcript_error":
        return this.fail(message.videoId, message.error);
      case "confirm": {
        const job = this.jobs.get(message.videoId);
        if (job?.status === "needs_confirmation") {
          job.confirmed = true;
          await this.advance(job);
        }
        return;
      }
      case "stop":
        return this.stop(message.videoId);
      case "detach":
        return this.detach(client, message.videoId);
    }
  }

  /** Called when a tab closes or navigates away. */
  disconnect(client: Client): void {
    for (const job of [...this.jobs.values()]) {
      job.viewers.delete(client);
      // Paid work hasn't started in these states, so nothing is lost by dropping them.
      const ownerNeededNext = job.owner === client && !job.result && (job.status === "queued" || job.status === "fetching");
      if (ownerNeededNext || this.isWaitingAbandoned(job)) this.remove(job);
    }
    this.pump();
  }

  /** Re-checks jobs waiting for the passphrase after an unlock. */
  async onUnlocked(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (job.status === "needs_unlock") await this.advance(job);
    }
  }

  private isWaitingAbandoned(job: Job): boolean {
    return job.viewers.size === 0 && (job.status === "needs_unlock" || job.status === "needs_confirmation");
  }

  private async identity(videoId: string, settings: Settings): Promise<{ key: string; language: string }> {
    const language = resolveLanguage(settings.language, this.deps.browserLanguage());
    const key = await this.deps.cacheKey({
      videoId,
      provider: settings.provider,
      model: settings.models[settings.provider],
      language,
      detail: settings.detail,
      customInstructions: settings.customInstructions,
    });
    return { key, language };
  }

  private async request(client: Client, videoId: string, regenerate: boolean): Promise<void> {
    const settings = await this.deps.loadSettings();
    if (!settings.setupComplete) {
      client.send({ t: "update", view: { videoId, status: "failed", text: "", error: { code: "NEEDS_SETUP" } } });
      return;
    }
    const { key, language } = await this.identity(videoId, settings);

    const existing = this.jobs.get(videoId);
    if (existing) {
      existing.viewers.add(client);
      client.send({ t: "update", view: this.view(existing) });
      return;
    }

    if (!regenerate) {
      const cached = await this.deps.cacheGet(key, settings.cacheDays);
      if (cached) {
        client.send({ t: "update", view: cachedView(cached) });
        return;
      }
    }

    const job: Job = {
      videoId,
      key,
      settings,
      language,
      status: "queued",
      text: "",
      owner: client,
      viewers: new Set([client]),
      confirmed: false,
    };
    this.jobs.set(videoId, job);
    this.publish(job);
    this.pump();
  }

  private async status(client: Client, videoId: string): Promise<void> {
    const job = this.jobs.get(videoId);
    if (job) {
      client.send({ t: "update", view: this.view(job) });
      return;
    }
    const settings = await this.deps.loadSettings();
    const { key } = await this.identity(videoId, settings);
    const cached = await this.deps.cacheGet(key, settings.cacheDays);
    client.send({ t: "update", view: cached ? cachedView(cached) : { videoId, status: "idle", text: "" } });
  }

  private detach(client: Client, videoId: string): void {
    const job = this.jobs.get(videoId);
    if (!job) return;
    job.viewers.delete(client);
    if (this.isWaitingAbandoned(job)) this.remove(job);
  }

  private stop(videoId: string): void {
    const job = this.jobs.get(videoId);
    if (!job) return;
    job.abort?.abort();
    job.status = "cancelled";
    this.publish(job);
    this.remove(job);
    this.pump();
  }

  private fail(videoId: string, error: AddonError): void {
    const job = this.jobs.get(videoId);
    if (!job) return;
    job.status = "failed";
    this.publish(job, error);
    this.remove(job);
    this.pump();
  }

  private remove(job: Job): void {
    if (this.jobs.get(job.videoId) === job) this.jobs.delete(job.videoId);
    this.reportActive();
  }

  private activeCount(): number {
    let active = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "fetching" || job.status === "streaming") active++;
    }
    return active;
  }

  private reportActive(): void {
    this.deps.onActiveChange?.(this.activeCount());
  }

  /** Starts queued jobs, first in first out, up to the concurrency limit. */
  private pump(): void {
    for (const job of this.jobs.values()) {
      if (this.activeCount() >= MAX_CONCURRENT_JOBS) break;
      if (job.status !== "queued") continue;
      if (job.result) {
        void this.runStream(job);
      } else {
        job.status = "fetching";
        this.publish(job);
        job.owner.send({ t: "fetch_transcript", videoId: job.videoId, summaryLanguage: job.language });
      }
    }
    this.reportActive();
  }

  private async receiveTranscript(videoId: string, result: TranscriptResult): Promise<void> {
    const job = this.jobs.get(videoId);
    if (!job || job.status !== "fetching") return;
    job.result = result;
    await this.advance(job);
  }

  /** Moves a job with a transcript on to its next required step. */
  private async advance(job: Job): Promise<void> {
    const { settings, result } = job;
    if (!result) return;

    const keys = await this.deps.unlockedKeys();
    if (!keys) {
      job.status = "needs_unlock";
      this.publish(job);
      this.pump();
      return;
    }

    if (!job.confirmed) {
      const prompt = this.buildRequest(job);
      const check = preflight(prompt.model, prompt.system + prompt.user, settings.detail, settings.costLimit);
      if (check.action === "too_long") {
        this.fail(job.videoId, { code: "TOO_LONG", provider: settings.provider });
        return;
      }
      if (check.action === "confirm") {
        job.status = "needs_confirmation";
        job.confirm = check.confirm;
        this.publish(job);
        this.pump();
        return;
      }
    }

    job.status = "queued";
    job.confirm = undefined;
    this.publish(job);
    this.pump();
  }

  private buildRequest(job: Job): SummaryRequest {
    const { settings, result, language } = job;
    const model = settings.models[settings.provider];
    return {
      model,
      system: buildSystemPrompt(settings.detail, language, settings.customInstructions),
      user: buildUserMessage(result!),
      // Generous, because reasoning models count their reasoning toward this limit.
      maxOutputTokens: Math.max(OUTPUT_TOKENS[settings.detail] * 4, 8000),
      lowEffort: findModel(model)?.lowEffort ?? false,
    };
  }

  private async runStream(job: Job): Promise<void> {
    const { settings } = job;
    const providerId = settings.provider;
    job.status = "streaming";
    job.abort = new AbortController();
    this.publish(job);
    this.reportActive();

    try {
      const key = (await this.deps.unlockedKeys())?.[providerId];
      if (!key) throw new AddonFailure({ code: "INVALID_KEY", provider: providerId, step: "no_stored_key" });
      if (!(await this.deps.hasPermission(providerId))) {
        throw new AddonFailure({ code: "PERMISSION_MISSING", provider: providerId });
      }
      await this.streamWithRetry(job, key);
      if (this.jobs.get(job.videoId) !== job) return;

      const entry: CacheEntry = {
        videoId: job.videoId,
        text: job.text,
        title: job.result!.video.title,
        channel: job.result!.video.channel,
        durationSeconds: job.result!.video.durationSeconds,
        createdAt: Date.now(),
      };
      await this.deps.cachePut(job.key, entry, settings.cacheDays);
      job.status = "done";
      this.publish(job);
      this.remove(job);
      this.pump();
    } catch (error) {
      if (job.abort.signal.aborted) return;
      // Any partial text stays on screen, marked incomplete by the view, and isn't cached.
      this.fail(job.videoId, toAddonError(error, providerId));
    }
  }

  /** Retries once when the provider is busy, but only before any text has been shown. */
  private async streamWithRetry(job: Job, key: string): Promise<void> {
    const provider = this.deps.provider(job.settings.provider);
    const request = this.buildRequest(job);
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const text of provider.stream(request, key, job.abort!.signal)) {
          job.text += text;
          for (const viewer of job.viewers) viewer.send({ t: "delta", videoId: job.videoId, text });
        }
        return;
      } catch (error) {
        const detail = error instanceof AddonFailure ? error.detail : undefined;
        const wait = detail?.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
        const canRetry = attempt === 0 && detail?.code === "RATE_LIMITED" && job.text === "" && wait <= MAX_AUTO_RETRY_SECONDS;
        if (!canRetry) throw error;
        await this.deps.sleep(wait * 1000);
        if (job.abort!.signal.aborted) throw error;
      }
    }
  }

  private view(job: Job, error?: AddonError): JobView {
    return {
      videoId: job.videoId,
      status: job.status,
      text: job.text,
      title: job.result?.video.title,
      durationSeconds: job.result?.video.durationSeconds,
      error,
      confirm: job.confirm,
    };
  }

  private publish(job: Job, error?: AddonError): void {
    const view = this.view(job, error);
    for (const viewer of job.viewers) viewer.send({ t: "update", view });
    this.reportActive();
  }
}

function cachedView(entry: CacheEntry): JobView {
  return {
    videoId: entry.videoId,
    status: "done",
    text: entry.text,
    title: entry.title,
    durationSeconds: entry.durationSeconds,
    summarizedAt: entry.createdAt,
  };
}
