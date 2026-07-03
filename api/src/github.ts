export interface Repo {
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  pushed_at: string;
  url: string;
  fork: boolean;
}

export interface GithubData {
  fetched_at: number | null;
  repos: Repo[];
}

interface GithubCacheOptions {
  user: string;
  intervalMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface GithubApiRepo {
  name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  pushed_at: string;
  html_url: string;
  fork: boolean;
}

const DEFAULT_INTERVAL_MS = 900000;

function toRepo(raw: GithubApiRepo): Repo {
  return {
    name: raw.name,
    description: raw.description,
    stars: raw.stargazers_count,
    language: raw.language,
    pushed_at: raw.pushed_at,
    url: raw.html_url,
    fork: raw.fork,
  };
}

export class GithubCache {
  private readonly user: string;
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private etag: string | undefined;
  private repos: Repo[] = [];
  private fetchedAt: number | null = null;
  private failureStreak = 0;

  constructor(opts: GithubCacheOptions) {
    this.user = opts.user;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  current(): GithubData {
    return { fetched_at: this.fetchedAt, repos: this.repos };
  }

  cacheAgeSeconds(): number | null {
    if (this.fetchedAt === null) return null;
    return Math.max(0, Math.round((this.now() - this.fetchedAt) / 1000));
  }

  private async tick(): Promise<void> {
    const url = `https://api.github.com/users/${this.user}/repos?per_page=100&sort=pushed`;
    const headers: Record<string, string> = {};
    if (this.etag !== undefined) headers["If-None-Match"] = this.etag;

    try {
      const res = await this.fetchFn(url, { headers });

      if (res.status === 304) {
        this.fetchedAt = this.now();
        this.failureStreak = 0;
        return;
      }

      if (!res.ok) {
        this.recordFailure(`github repos request failed: ${res.status}`);
        return;
      }

      const body = (await res.json()) as GithubApiRepo[];
      this.repos = body
        .filter((repo) => !repo.fork)
        .map(toRepo)
        .sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at));
      this.etag = res.headers.get("etag") ?? undefined;
      this.fetchedAt = this.now();
      this.failureStreak = 0;
    } catch (err) {
      this.recordFailure(err instanceof Error ? err.message : String(err));
    }
  }

  private recordFailure(message: string): void {
    this.failureStreak += 1;
    // First failure in a streak logs; later ones stay silent to avoid
    // spamming logs while the cache continues serving stale data.
    if (this.failureStreak === 1) {
      console.error(`github poll failed: ${message}`);
    }
  }
}
