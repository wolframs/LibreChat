import type { TConversation, TEndpointOption } from 'librechat-data-provider';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { Request } from 'express';

/**
 * LibreChat-specific request body type that extends Express Request body
 * (have to use type alias because you can't extend indexed access types like Request['body'])
 */
export type RequestBody = {
  messageId?: string;
  fileTokenLimit?: number;
  conversationId?: string;
  parentMessageId?: string;
  endpoint?: string;
  endpointType?: string;
  model?: string;
  key?: string;
  endpointOption?: Partial<TEndpointOption>;
  /** Browser IANA timezone used to resolve local-time prompt variables (e.g. `{{current_datetime}}`). */
  timezone?: string;
};

export type ServerRequest = Request<unknown, unknown, RequestBody> & {
  user?: IUser;
  config?: AppConfig;
  /** Server-captured conversation creation time used to anchor dynamic prompt variables. */
  conversationCreatedAt?: string;
  /** Conversation loaded while resolving the prompt timestamp anchor, reused by save logic. */
  resolvedConversation?: Partial<TConversation> | null;
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
};
