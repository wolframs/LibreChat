import { z } from 'zod';
import { Dispatcher } from 'undici';
import { AuthKeys, anthropicSchema, TVertexAISchema } from 'librechat-data-provider';
import type { ThinkingDisplayWireValue } from 'librechat-data-provider';
import type { AnthropicClientOptions } from '@librechat/agents';
import type { GoogleServiceKey } from '../utils/key';
import type { LLMConfigResult } from './openai';
import type { StreamUsageSink } from '../endpoints/anthropic/streamUsage';

export type AnthropicParameters = z.infer<typeof anthropicSchema>;

export type AnthropicCredentials = {
  [AuthKeys.GOOGLE_SERVICE_KEY]?: GoogleServiceKey;
  [AuthKeys.ANTHROPIC_API_KEY]?: string;
};

/**
 * Vertex AI client options for configuring the Anthropic Vertex client.
 * These options are typically loaded from the YAML config or environment variables.
 */
export interface VertexAIClientOptions {
  /** Google Cloud region for Vertex AI (e.g., 'us-east5', 'europe-west1') */
  region?: string;
  /** Google Cloud Project ID */
  projectId?: string;
}

export interface ThinkingConfigDisabled {
  type: 'disabled';
}

export interface ThinkingConfigEnabled {
  /**
   * Determines how many tokens Claude can use for its internal reasoning process.
   * Larger budgets can enable more thorough analysis for complex problems, improving
   * response quality.
   *
   * Must be ≥1024 and less than `max_tokens`.
   *
   * See
   * [extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
   * for details.
   */
  budget_tokens: number;

  type: 'enabled';
}

export interface ThinkingConfigAdaptive {
  type: 'adaptive';
  display?: ThinkingDisplayWireValue;
}

/**
 * Configuration for enabling Claude's extended thinking.
 *
 * When enabled, responses include `thinking` content blocks showing Claude's
 * thinking process before the final answer. Requires a minimum budget of 1,024
 * tokens and counts towards your `max_tokens` limit.
 *
 * See
 * [extended thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
 * for details.
 */
export type ThinkingConfigParam =
  | ThinkingConfigEnabled
  | ThinkingConfigDisabled
  | ThinkingConfigAdaptive;

export type AnthropicModelOptions = Partial<Omit<AnthropicParameters, 'thinking'>> & {
  thinking?: AnthropicParameters['thinking'] | null;
  user?: string;
};

/**
 * Configuration options for the getLLMConfig function
 */
export interface AnthropicConfigOptions {
  modelOptions?: AnthropicModelOptions;
  /** Proxy server URL */
  proxy?: string | null;
  /** URL for a reverse proxy, if used */
  reverseProxyUrl?: string | null;
  /** Whether the reverse proxy URL came from a user-stored credential */
  baseURLIsUserProvided?: boolean;
  /** Admin-approved internal host:port exemptions for user-provided base URLs */
  allowedAddresses?: string[] | null;
  /** Default parameters to apply only if fields are undefined */
  defaultParams?: Record<string, unknown>;
  /** Additional parameters to add to the configuration */
  addParams?: Record<string, unknown>;
  /** Parameters to drop/exclude from the configuration */
  dropParams?: string[];
  /**
   * Admin-configured custom request headers (with unresolved placeholders).
   * Merged beneath provider-managed headers and resolved at request time.
   */
  headers?: Record<string, string>;
  /** Vertex AI specific options for Google Cloud configuration */
  vertexOptions?: VertexAIClientOptions;
  /** Full Vertex AI configuration including model mappings from YAML config */
  vertexConfig?: TVertexAISchema;
  /**
   * One-shot Anthropic prompt-cache TTL for this request, armed per-message from
   * the client ('1h' extends the ephemeral cache window from the 5m default to
   * 1h at 2× cache-write cost). Only honored when the model supports prompt
   * caching; overrides the conversation-level `promptCacheTtl` model parameter
   * for this request via the agents SDK's native `promptCacheTtl` option.
   */
  cacheTTL?: '5m' | '1h';
  /**
   * Receives token usage read straight off the streamed response body, for
   * gateways that report input and cache counts on `message_delta` rather than
   * `message_start`. The stream parser only looks at `message_start` for those,
   * so without this they are lost before billing sees them — see
   * `~/endpoints/anthropic/streamUsage`. Absent for the common case; supplying
   * it costs one `ReadableStream.tee()` per streamed request.
   */
  streamUsageSink?: StreamUsageSink;
}

/**
 * Return type for getLLMConfig function
 */
export type AnthropicLLMConfigResult = LLMConfigResult<
  AnthropicClientOptions & {
    clientOptions?: {
      fetchOptions?: { dispatcher?: Dispatcher; redirect?: RequestRedirect };
    };
    stream?: boolean;
  }
>;
