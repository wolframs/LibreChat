import { EModelEndpoint, AuthKeys } from 'librechat-data-provider';
import type { BaseInitializeParams, InitializeResultBase, AnthropicConfigOptions } from '~/types';
import { loadAnthropicVertexCredentials, getVertexCredentialOptions } from './vertex';
import { getUserKeyValuesSafe, resolveUserEndpoint, markRequestRouting } from '~/endpoints/profiles';
import { checkUserKeyExpiry, isEnabled, mergeHeaders } from '~/utils';
import { getLLMConfig } from './llm';

/**
 * Initializes Anthropic endpoint configuration.
 * Supports both direct API key authentication and Google Cloud Vertex AI.
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to Anthropic configuration options
 * @throws Error if API key is not provided (when not using Vertex AI)
 */
export async function initializeAnthropic({
  req,
  endpoint,
  model_parameters,
  db,
}: BaseInitializeParams): Promise<InitializeResultBase> {
  void endpoint;
  const appConfig = req.config;
  const { ANTHROPIC_API_KEY, ANTHROPIC_REVERSE_PROXY, PROXY } = process.env;
  const { key: expiresAt } = req.body;

  /**
   * One-shot per-message prompt-cache TTL armed from the client. Rides the
   * request body (like other per-turn fields), NOT the persisted conversation
   * `model_parameters`, so it applies to exactly one message. Validated to the
   * two values Anthropic supports; anything else falls back to the 5m default.
   */
  const rawCacheTTL = (req.body as { cacheTTL?: unknown }).cacheTTL;
  const cacheTTL: '5m' | '1h' | undefined =
    rawCacheTTL === '1h' ? '1h' : rawCacheTTL === '5m' ? '5m' : undefined;

  let credentials: Record<string, unknown> = {};
  let vertexOptions: { region?: string; projectId?: string } | undefined;
  /** Resolved base URL for this request; the env reverse proxy unless a user
   *  endpoint profile overrides it. Stays undefined on the Vertex path, which
   *  carries its own endpoint and auth. */
  let resolvedBaseURL: string | undefined = ANTHROPIC_REVERSE_PROXY ?? undefined;
  let baseURLIsUserProvided = false;

  /** @type {undefined | import('librechat-data-provider').TVertexAIConfig} */
  const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;

  // Check for Vertex AI configuration: YAML config takes priority over env var
  // When vertexConfig exists and enabled is not explicitly false, Vertex AI is enabled
  const useVertexAI =
    (vertexConfig && vertexConfig.enabled !== false) || isEnabled(process.env.ANTHROPIC_USE_VERTEX);

  if (useVertexAI) {
    // Load credentials with optional YAML config overrides
    const credentialOptions = vertexConfig ? getVertexCredentialOptions(vertexConfig) : undefined;
    credentials = await loadAnthropicVertexCredentials(credentialOptions);

    // Store vertex options for client creation
    if (vertexConfig) {
      vertexOptions = {
        region: vertexConfig.region,
        projectId: vertexConfig.projectId,
      };
    }
  } else {
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';

    /**
     * Read unconditionally rather than only when the key is user-provided: an
     * endpoint profile may point at a gateway even on a deployment where the
     * admin supplies `ANTHROPIC_API_KEY`. Returns null when no key is stored,
     * and tolerates the bare-string blobs this endpoint historically wrote.
     */
    const userValues = await getUserKeyValuesSafe({
      db,
      userId: req.user?.id ?? '',
      name: EModelEndpoint.anthropic,
    });

    const resolved = await resolveUserEndpoint({
      userValues,
      fallbackApiKey: isUserProvided ? userValues?.apiKey : ANTHROPIC_API_KEY,
      fallbackBaseURL: ANTHROPIC_REVERSE_PROXY,
      endpoint: EModelEndpoint.anthropic,
      allowedAddresses: appConfig?.endpoints?.allowedAddresses,
    });

    if (!resolved.apiKey) {
      throw new Error('Anthropic API key not provided. Please provide it again.');
    }

    if (expiresAt && isUserProvided) {
      checkUserKeyExpiry(expiresAt, EModelEndpoint.anthropic);
    }

    credentials[AuthKeys.ANTHROPIC_API_KEY] = resolved.apiKey;
    resolvedBaseURL = resolved.baseURL;
    baseURLIsUserProvided = resolved.baseURLIsUserProvided;
    markRequestRouting(req, resolved);
  }

  const anthropicConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic];
  const allConfig = appConfig?.endpoints?.all;

  /**
   * Withhold configured headers when the destination is user-chosen — they may
   * carry `${SECRET}` gateway values or user/OpenID token placeholders resolved
   * later by `resolveConfigHeaders`, which must not reach a user-controlled
   * endpoint. Mirrors the same guard in `initializeOpenAI`.
   */
  const headers = baseURLIsUserProvided
    ? undefined
    : mergeHeaders(allConfig?.headers, anthropicConfig?.headers);

  const clientOptions: AnthropicConfigOptions = {
    proxy: PROXY ?? undefined,
    reverseProxyUrl: resolvedBaseURL,
    baseURLIsUserProvided,
    allowedAddresses: appConfig?.endpoints?.allowedAddresses,
    modelOptions: {
      ...(model_parameters ?? {}),
      user: req.user?.id,
    },
    ...(headers && { headers }),
    ...(cacheTTL && { cacheTTL }),
    // Pass Vertex AI options if configured
    ...(vertexOptions && { vertexOptions }),
    // Pass full Vertex AI config including model mappings
    ...(vertexConfig && { vertexConfig }),
  };

  const result = getLLMConfig(credentials, clientOptions);

  if (anthropicConfig?.streamRate) {
    (result.llmConfig as Record<string, unknown>)._lc_stream_delay = anthropicConfig.streamRate;
  }

  if (allConfig?.streamRate) {
    (result.llmConfig as Record<string, unknown>)._lc_stream_delay = allConfig.streamRate;
  }

  return result;
}
