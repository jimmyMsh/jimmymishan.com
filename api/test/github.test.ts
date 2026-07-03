import { describe, expect, it, vi } from "vitest";
import { GithubCache } from "../src/github.js";
import { githubRoute } from "../src/routes/github.js";

interface FixtureRepo {
  name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  pushed_at: string;
  html_url: string;
  fork: boolean;
}

const FIXTURE_REPOS: FixtureRepo[] = [
  {
    name: "alpha",
    description: "First repo",
    stargazers_count: 10,
    language: "TypeScript",
    pushed_at: "2026-06-01T00:00:00Z",
    html_url: "https://github.com/jimmyMsh/alpha",
    fork: false,
  },
  {
    name: "beta",
    description: null,
    stargazers_count: 3,
    language: null,
    pushed_at: "2026-06-15T00:00:00Z",
    html_url: "https://github.com/jimmyMsh/beta",
    fork: false,
  },
  {
    name: "a-fork",
    description: "someone else's work",
    stargazers_count: 99,
    language: "JavaScript",
    pushed_at: "2026-06-20T00:00:00Z",
    html_url: "https://github.com/jimmyMsh/a-fork",
    fork: true,
  },
];

function repoListResponse(repos: FixtureRepo[], init?: ResponseInit): Response {
  return new Response(JSON.stringify(repos), { status: 200, ...init });
}

describe("GithubCache", () => {
  it("returns empty data before the first successful poll", () => {
    const cache = new GithubCache({ user: "jimmyMsh", fetchFn: vi.fn() });

    expect(cache.current()).toEqual({ fetched_at: null, repos: [] });
    expect(cache.cacheAgeSeconds()).toBeNull();
  });

  it("maps a 200 response, excludes forks, and sorts by pushed_at desc", async () => {
    const fetchFn = vi.fn(async () => repoListResponse(FIXTURE_REPOS));
    vi.useFakeTimers();
    try {
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        now: () => 5000,
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(cache.current()).toEqual({
        fetched_at: 5000,
        repos: [
          {
            name: "beta",
            description: null,
            stars: 3,
            language: null,
            pushed_at: "2026-06-15T00:00:00Z",
            url: "https://github.com/jimmyMsh/beta",
            fork: false,
          },
          {
            name: "alpha",
            description: "First repo",
            stars: 10,
            language: "TypeScript",
            pushed_at: "2026-06-01T00:00:00Z",
            url: "https://github.com/jimmyMsh/alpha",
            fork: false,
          },
        ],
      });
      cache.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends If-None-Match with the stored etag on the second poll", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        repoListResponse(FIXTURE_REPOS, {
          headers: { etag: '"first-etag"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    vi.useFakeTimers();
    try {
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        intervalMs: 1000,
        now: () => 9000,
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      cache.stop();

      expect(fetchFn).toHaveBeenCalledTimes(2);
      const [, secondInit] = fetchFn.mock.calls[1] as [string, RequestInit];
      expect(new Headers(secondInit.headers).get("If-None-Match")).toBe(
        '"first-etag"',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cached repos on a 304 and updates fetched_at to the confirmation time", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        repoListResponse(FIXTURE_REPOS, { headers: { etag: '"v1"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    vi.useFakeTimers();
    try {
      let now = 1000;
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        intervalMs: 1000,
        now: () => now,
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = cache.current();

      now = 2000;
      await vi.advanceTimersByTimeAsync(1000);
      cache.stop();

      const afterSecond = cache.current();
      expect(afterSecond.repos).toEqual(afterFirst.repos);
      expect(afterSecond.fetched_at).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stale data when a poll fails over the network", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(repoListResponse(FIXTURE_REPOS))
      .mockRejectedValueOnce(new Error("connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      let now = 1000;
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        intervalMs: 1000,
        now: () => now,
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = cache.current();

      now = 2000;
      await vi.advanceTimersByTimeAsync(1000);
      cache.stop();

      expect(cache.current()).toEqual(afterFirst);
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });

  it("logs once per failure streak rather than once per failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        intervalMs: 1000,
        now: () => 1000,
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      cache.stop();

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });

  it("reports cache age in seconds since the last confirmation", async () => {
    const fetchFn = vi.fn(async () => repoListResponse(FIXTURE_REPOS));
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        now: () => now,
      });

      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      cache.stop();

      now = 15_000;
      expect(cache.cacheAgeSeconds()).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/github", () => {
  it("returns the cache's current data with a 5-minute cache-control header", async () => {
    const cache = new GithubCache({ user: "jimmyMsh", fetchFn: vi.fn() });
    const app = githubRoute({ cache });

    const res = await app.request("/api/github");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({ fetched_at: null, repos: [] });
  });

  it("reflects a populated cache", async () => {
    const fetchFn = vi.fn(async () => repoListResponse(FIXTURE_REPOS));
    vi.useFakeTimers();
    try {
      const cache = new GithubCache({
        user: "jimmyMsh",
        fetchFn,
        now: () => 4000,
      });
      cache.start();
      await vi.advanceTimersByTimeAsync(0);
      cache.stop();

      const app = githubRoute({ cache });
      const res = await app.request("/api/github");
      const body = await res.json();

      expect(body.fetched_at).toBe(4000);
      expect(body.repos).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
