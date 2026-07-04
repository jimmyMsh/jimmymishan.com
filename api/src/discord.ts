const TIMEOUT_MS = 5000;

export async function sendContactEmbed(
  webhookUrl: string,
  payload: { message: string; from: string | null },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const body = {
    embeds: [
      {
        title: "Contact message",
        description: payload.message,
        fields: [{ name: "From", value: payload.from ?? "(not given)" }],
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // fetchFn isn't guaranteed to honor the abort signal (e.g. an injected test
  // double that never resolves), so the timeout is enforced independently
  // here rather than relying solely on the fetch call rejecting.
  const timedOut = new Promise<false>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(false), {
      once: true,
    });
  });

  const attempt = (async () => {
    try {
      const res = await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    }
  })();

  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
