export type ProviderId = "anthropic" | "openai" | "gemini";
export type DetailLevel = "brief" | "standard" | "detailed";

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  durationSeconds: number;
}

export interface TranscriptResult {
  video: VideoInfo;
  /** Normalized `[mm:ss] text` lines. */
  transcript: string;
}

export type ErrorCode =
  // YouTube
  | "NO_CAPTIONS"
  | "NOT_AVAILABLE_YET"
  | "RESTRICTED"
  | "YOUTUBE_CHANGED"
  // Provider
  | "INVALID_KEY"
  | "NO_CREDITS"
  | "RATE_LIMITED"
  | "MODEL_NOT_FOUND"
  | "TOO_LONG"
  | "REFUSED"
  | "TRUNCATED"
  | "NETWORK"
  | "PROVIDER_ERROR"
  // Addon state
  | "PERMISSION_MISSING"
  | "NEEDS_SETUP"
  | "BACKGROUND_RESTARTED";

export interface AddonError {
  code: ErrorCode;
  provider?: ProviderId;
  /** Which transcript route or request failed. Used in issue reports; never contains keys or transcripts. */
  step?: string;
  retryAfterSeconds?: number;
}

export type JobStatus =
  | "queued"
  | "fetching"
  | "needs_unlock"
  | "needs_confirmation"
  | "streaming"
  | "done"
  | "failed"
  | "cancelled"
  | "idle";

export interface CostConfirmation {
  estimatedTokens: number;
  /** Absent when the model's price isn't known. */
  estimatedCost?: number;
}

/** Everything a view needs to display a video's summary state. */
export interface JobView {
  videoId: string;
  status: JobStatus;
  text: string;
  title?: string;
  durationSeconds?: number;
  error?: AddonError;
  confirm?: CostConfirmation;
  /** Set when this result came from the cache. */
  summarizedAt?: number;
}

/** Messages on the long-lived port between a tab's content script and the background script. */
export type ToBackground =
  | { t: "request"; videoId: string; regenerate?: boolean }
  | { t: "status"; videoId: string }
  | { t: "transcript"; videoId: string; result: TranscriptResult }
  | { t: "transcript_error"; videoId: string; error: AddonError }
  | { t: "confirm"; videoId: string }
  | { t: "stop"; videoId: string }
  | { t: "detach"; videoId: string }
  | { t: "open_page"; page: "options" | "welcome" | "unlock_window" };

export type ToContent =
  | { t: "update"; view: JobView }
  | { t: "delta"; videoId: string; text: string }
  | { t: "fetch_transcript"; videoId: string; summaryLanguage: string };

/** One-shot messages from the addon's own extension pages. Rejected from any other sender. */
export type PageRequest =
  | { t: "test_key"; provider: ProviderId; key: string; model: string }
  | { t: "create_vault"; keys: Partial<Record<ProviderId, string>>; passphrase: string }
  | { t: "save_key"; provider: ProviderId; key: string; passphrase: string }
  | { t: "unlock"; passphrase: string }
  | { t: "lock" }
  | { t: "lock_state" }
  | { t: "change_passphrase"; current: string; next: string }
  | { t: "full_reset" }
  | { t: "cache_stats" }
  | { t: "cache_clear" };

export type PageResponse =
  | { ok: true; unlocked?: boolean; entries?: number; bytes?: number; hasVault?: boolean }
  | { ok: false; error?: AddonError; reason?: string };
