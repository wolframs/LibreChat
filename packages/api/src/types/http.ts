import type {
  CodeApprovalMode,
  CodeEnvironmentMode,
  CodeWorkspaceSelection,
  TEndpointOption,
  Agents,
} from 'librechat-data-provider';
import type { IUser, AppConfig, IConversation } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { ObservedStreamUsage } from '~/endpoints/anthropic/streamUsage';

/**
 * LibreChat-specific request body type that extends Express Request body
 * (have to use type alias because you can't extend indexed access types like Request['body'])
 */
export type RequestBody = {
  cacheTTL?: '5m' | '1h';
  messageId?: string;
  fileTokenLimit?: number;
  conversationId?: string;
  parentMessageId?: string;
  endpoint?: string;
  endpointType?: string;
  model?: string;
  imageDetail?: Agents.ImageDetail;
  key?: string;
  endpointOption?: Partial<TEndpointOption>;
  /** Browser IANA timezone used to resolve local-time prompt variables (e.g. `{{current_datetime}}`). */
  timezone?: string;
  codeApprovalMode?: CodeApprovalMode;
  codeEnvironmentMode?: CodeEnvironmentMode;
  codeWorkspaces?: CodeWorkspaceSelection[];
};

export type ServerRequest = Request<unknown, unknown, RequestBody> & {
  user?: IUser;
  config?: AppConfig;
  /** Server-captured generation start time used to anchor dynamic prompt variables. */
  turnStartedAt?: number;
  /** Server-captured conversation creation time used when inserting conversation metadata. */
  conversationCreatedAt?: string;
  /** Conversation read by request middleware (`null` = looked up, absent), reused by the
   *  subagent guard, agent initialization, and the first save instead of re-reading it. */
  resolvedConversation?: Partial<IConversation> | null;
  /** Passport strategy that populated req.user for this request. */
  authStrategy?: string;
  /**
   * Where this request was actually sent, set by the endpoint initializer once
   * the base URL is resolved. Absent when the provider's own default was used.
   *
   * Request-scoped rather than threaded through the client options because the
   * spend path is far downstream of initialization and already carries `req`.
   * Recorded onto every resulting transaction as `routedVia` — see
   * `ITransaction.routedVia`.
   */
  routedVia?: {
    endpoint?: string;
    baseURL?: string;
  };
  /**
   * Token counts read off the raw streamed response body, for destinations that
   * report input and cache counts in a frame the stream parser does not read.
   * Filled during the request by `attachStreamUsageSink`, drained by
   * `recordCollectedUsage`. Request-scoped for the same reason as `routedVia`:
   * it is known at request time and needed at spend time, with nothing else
   * spanning the two.
   */
  observedStreamUsage?: ObservedStreamUsage[];
};
