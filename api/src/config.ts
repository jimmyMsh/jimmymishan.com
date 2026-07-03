export interface Config {
  deployWebhookSecret: string | null;
  githubUser: string;
  sseMaxConnections: number;
  commit: string;
  dataDir: string;
}

const DEFAULT_GITHUB_USER = "jimmyMsh";
const DEFAULT_SSE_MAX_CONNECTIONS = 100;
const DEFAULT_COMMIT = "dev";
const DEFAULT_DATA_DIR = "/data";
const SSE_MAX_CONNECTIONS_RANGE = { min: 1, max: 10000 };

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
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
  };
}
