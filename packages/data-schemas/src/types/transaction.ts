export interface TransactionData {
  user: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
  /** Where the request was actually sent. See `ITransaction.routedVia`. */
  routedVia?: {
    endpoint?: string;
    baseURL?: string;
  };
}
