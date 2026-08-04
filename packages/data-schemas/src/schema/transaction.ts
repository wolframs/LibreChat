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
   * Set when the request was served through a user endpoint profile rather than
   * the provider's own API.
   *
   * Its presence means **`rate` and `tokenValue` on this document are nominal**:
   * they come from the model-name rate table, which describes what the provider
   * would have charged, not what the gateway at `baseURL` actually did. A
   * gateway that re-routes to a cheaper or pricier upstream is invisible to that
   * table. Recorded so the real cost can be reconciled later, and so nominal
   * spend can be told apart from verified spend in the meantime.
   */
  routedVia?: {
    profileId?: string;
    profileName?: string;
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
        profileId: { type: String },
        profileName: { type: String },
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
