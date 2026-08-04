export const envVarRegex = /^\${(.+)}$/;

/**
 * Infrastructure env vars that must never be resolved via placeholder expansion.
 * These are internal secrets whose exposure would compromise the system —
 * they have no legitimate reason to appear in outbound headers, MCP env/args, or OAuth config.
 *
 * Intentionally excludes API keys (operators reference them in config) and
 * OAuth/session secrets (referenced in MCP OAuth config via processMCPEnv).
 */
const SENSITIVE_ENV_VARS = new Set([
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CREDS_KEY',
  'CREDS_IV',
  'MEILI_MASTER_KEY',
  'MONGO_URI',
  'REDIS_URI',
  'REDIS_PASSWORD',
]);

/** Returns true when `varName` refers to an infrastructure secret that must not leak. */
export function isSensitiveEnvVar(varName: string): boolean {
  return SENSITIVE_ENV_VARS.has(varName);
}

/** Extracts the environment variable name from a template literal string */
export function extractVariableName(value: string): string | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(envVarRegex);
  return match ? match[1] : null;
}

/** Extracts the value of an environment variable from a string. */
export function extractEnvVariable(value: string) {
  if (!value) {
    return value;
  }

  const trimmed = value.trim();

  const singleMatch = trimmed.match(envVarRegex);
  if (singleMatch) {
    const varName = singleMatch[1];
    if (isSensitiveEnvVar(varName)) {
      return trimmed;
    }
    return process.env[varName] || trimmed;
  }

  const regex = /\${([^}]+)}/g;
  let result = trimmed;

  const matches = [];
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    matches.push({
      fullMatch: match[0],
      varName: match[1],
      index: match.index,
    });
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, varName, index } = matches[i];
    if (isSensitiveEnvVar(varName)) {
      continue;
    }
    const envValue = process.env[varName] || fullMatch;
    result = result.substring(0, index) + envValue + result.substring(index + fullMatch.length);
  }

  return result;
}

/**
 * Normalize the endpoint name to system-expected value.
 * @param name
 */
export function normalizeEndpointName(name = ''): string {
  return name.toLowerCase() === 'ollama' ? 'ollama' : name;
}

/** Hosts that serve Anthropic's own Messages API, verbatim. */
const anthropicNativeHosts = new Set(['api.anthropic.com']);

/**
 * Whether a base URL speaks Anthropic's Messages API natively, and so honours
 * `cache_control` and its `ttl` field.
 *
 * Gateways that merely accept Anthropic-shaped requests do not qualify: they
 * normalize the payload for whichever seller they route to, so a prompt-cache
 * TTL sent to one is silently dropped rather than rejected. Features that only
 * work on the real API are gated on this.
 *
 * An absent URL means the endpoint's own default, which is Anthropic — callers
 * pass a URL only once the user has actively pointed the endpoint elsewhere.
 */
export function isAnthropicNativeURL(baseURL?: string | null): boolean {
  if (baseURL == null || baseURL.trim() === '') {
    return true;
  }
  try {
    return anthropicNativeHosts.has(new URL(baseURL.trim()).hostname.toLowerCase());
  } catch {
    /** An unparseable URL is not demonstrably Anthropic. */
    return false;
  }
}
