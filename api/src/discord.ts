const TIMEOUT_MS = 5000;

async function postEmbed(
  webhookUrl: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<boolean> {
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

export async function sendContactEmbed(
  webhookUrl: string,
  payload: { message: string; from: string | null },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  return postEmbed(
    webhookUrl,
    {
      embeds: [
        {
          title: "Contact message",
          description: payload.message,
          fields: [{ name: "From", value: payload.from ?? "(not given)" }],
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: { parse: [] as string[] },
    },
    fetchFn,
  );
}

// Mirrors the owner-CLI invocation documented for VPS moderation; the
// commands interpolate only the integer id and hex ip hash — never visitor
// text — so a crafted entry cannot alter what the owner pastes.
const MOD_CLI =
  "cd ~/jimmymishan.com && docker compose -f compose.prod.yaml exec api node api/dist/cli.js guestbook";

export async function sendGuestbookEmbed(
  webhookUrl: string,
  payload: { id: number; name: string; message: string; ipHash: string },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const moderate = [
    "```",
    `ssh vps '${MOD_CLI} delete ${payload.id}'`,
    `ssh vps '${MOD_CLI} block ${payload.ipHash}'`,
    "```",
  ].join("\n");
  return postEmbed(
    webhookUrl,
    {
      embeds: [
        {
          title: `Guestbook entry #${payload.id}`,
          description: payload.message,
          fields: [
            { name: "From", value: payload.name },
            { name: "Moderate", value: moderate },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: { parse: [] as string[] },
    },
    fetchFn,
  );
}
