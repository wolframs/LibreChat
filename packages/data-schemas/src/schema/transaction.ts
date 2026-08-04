import mongoose, { Schema, Document, Types } from 'mongoose';

// @ts-ignore
export interface ITransaction extends Document {
  user: Types.ObjectId;
  conversationId?: string;
  tokenType: 'prompt' | 'completion' | 'credits';
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
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  /**
   * Where this request actually went: the endpoint that served it and the base
   * URL it was sent to. Recorded whenever the destination is not the provider's
   * own default — a yaml `endpoints.custom` row, or an env reverse proxy.
   *
   * This is provenance, not a verdict. Whether `rate` and `tokenValue` can be
   * trusted depends on the *host*: some destinations (OpenRouter) report exact
   * per-request pricing, while a marketplace gateway re-routes to whichever
   * seller is cheapest and is invisible to the model-name rate table. The
   * dashboard decides which is which from `baseURL`, so adding a gateway does
   * not mean changing this schema.
   */
  routedVia?: {
    endpoint?: string;
    baseURL?: string;
  };
}

const transactionSchema: Schema<ITransaction> = new Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      required: true,
    },
    conversationId: {
      type: String,
      ref: 'Conversation',
      index: true,
    },
    tokenType: {
      type: String,
      enum: ['prompt', 'completion', 'credits'],
      required: true,
    },
    model: {
      type: String,
      index: true,
    },
    context: {
      type: String,
    },
    valueKey: {
      type: String,
    },
    rate: Number,
    rawAmount: Number,
    tokenValue: Number,
    inputTokens: { type: Number },
    writeTokens: { type: Number },
    readTokens: { type: Number },
    messageId: { type: String },
    tenantId: {
      type: String,
      index: true,
    },
    /** Absent on direct-to-provider calls; see ITransaction.routedVia. */
    routedVia: {
      type: {
        endpoint: { type: String },
        baseURL: { type: String },
      },
      required: false,
      _id: false,
    },
  },
  {
    timestamps: true,
  },
);

export default transactionSchema;
