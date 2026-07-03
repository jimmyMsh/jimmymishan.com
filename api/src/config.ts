export interface Config {
  deployWebhookSecret: string | null;
  githubUser: string;
  sseMaxConnections: number;
  commit: string;
  dataDir: string;
  guestbookEnabled: boolean;
  contactDiscordWebhook: string | null;
  logTailEnabled: boolean;
  logTailAllowPrivate: boolean;
  writeSecret: string | null;
}

const DEFAULT_GITHUB_USER = "jimmyMsh";
const DEFAULT_SSE_MAX_CONNECTIONS = 100;
const DEFAULT_COMMIT = "dev";
const DEFAULT_DATA_DIR = "/data";
const SSE_MAX_CONNECTIONS_RANGE = { min: 1, max: 10000 };

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function parseBool(
  raw: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = nonEmpty(raw);
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

function parseSseMaxConnections(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (value === undefined) return DEFAULT_SSE_MAX_CONNECTIONS;

  const parsed = Number(value);
  const { min, max } = SSE_MAX_CONNECTIONS_RANGE;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `SSE_MAX_CONNECTIONS must be an integer between ${min} and ${max}, got "${raw}"`,
    );
  }
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    deployWebhookSecret: nonEmpty(env.DEPLOY_WEBHOOK_SECRET) ?? null,
    githubUser: nonEmpty(env.GITHUB_USER) ?? DEFAULT_GITHUB_USER,
    sseMaxConnections: parseSseMaxConnections(env.SSE_MAX_CONNECTIONS),
    commit: nonEmpty(env.COMMIT) ?? DEFAULT_COMMIT,
    dataDir: DEFAULT_DATA_DIR,
    guestbookEnabled: parseBool(
      env.GUESTBOOK_ENABLED,
      "GUESTBOOK_ENABLED",
      true,
    ),
    contactDiscordWebhook: nonEmpty(env.CONTACT_DISCORD_WEBHOOK) ?? null,
    logTailEnabled: parseBool(env.LOG_TAIL_ENABLED, "LOG_TAIL_ENABLED", true),
    logTailAllowPrivate: parseBool(
      env.LOG_TAIL_ALLOW_PRIVATE,
      "LOG_TAIL_ALLOW_PRIVATE",
      false,
    ),
    writeSecret: nonEmpty(env.WRITE_SECRET) ?? null,
  };
}
