import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import * as esmConverter from '../node_modules/@langchain/openai/dist/converters/responses.js';

const require = createRequire(import.meta.url);
const cjsConverter = require('../node_modules/@langchain/openai/dist/converters/responses.cjs');
const { ModelEndHandler } = require('@librechat/agents');

const converters = [
  ['ESM', esmConverter],
  ['CJS', cjsConverter],
];

const usage = {
  input_tokens: 17,
  output_tokens: 4,
  total_tokens: 21,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 2 },
};

const terminalResponse = (overrides = {}) => ({
  id: 'resp_terminal',
  object: 'response',
  created_at: 1,
  model: 'test-model',
  status: 'completed',
  usage,
  ...overrides,
});

for (const [format, converter] of converters) {
  test(`${format}: missing terminal output retains valid usage`, () => {
    const chunk = converter.convertResponsesDeltaToChatGenerationChunk({
      type: 'response.completed',
      response: terminalResponse(),
    });

    assert.ok(chunk);
    assert.deepEqual(chunk.message.content, []);
    assert.deepEqual(chunk.message.response_metadata.output, undefined);
    assert.deepEqual(chunk.message.usage_metadata, {
      input_tokens: 17,
      output_tokens: 4,
      total_tokens: 21,
      input_token_details: { cache_read: 3 },
      output_token_details: { reasoning: 2 },
    });
  });

  test(`${format}: normal terminal output content is preserved`, () => {
    const output = [
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'normal content', annotations: [] }],
      },
    ];
    const message = converter.convertResponsesMessageToAIMessage(terminalResponse({ output }));

    assert.equal(message.text, 'normal content');
    assert.deepEqual(message.response_metadata.output, output);
    assert.deepEqual(message.usage_metadata, {
      input_tokens: 17,
      output_tokens: 4,
      total_tokens: 21,
      input_token_details: { cache_read: 3 },
      output_token_details: { reasoning: 2 },
    });
  });

  test(`${format}: streamed content survives a terminal event without output`, () => {
    const first = converter.convertResponsesDeltaToChatGenerationChunk({
      type: 'response.output_text.delta',
      delta: 'already ',
      content_index: 0,
    });
    const second = converter.convertResponsesDeltaToChatGenerationChunk({
      type: 'response.output_text.delta',
      delta: 'streamed',
      content_index: 0,
    });
    const terminal = converter.convertResponsesDeltaToChatGenerationChunk({
      type: 'response.completed',
      response: terminalResponse(),
    });

    const combined = first.concat(second).concat(terminal);

    assert.equal(combined.text, 'already streamed');
    assert.equal(combined.message.text, 'already streamed');
    assert.deepEqual(combined.message.usage_metadata, terminal.message.usage_metadata);
  });

  test(`${format}: malformed terminal metadata reaches the stream usage collector`, async () => {
    const text = converter.convertResponsesDeltaToChatGenerationChunk({
      type: 'response.output_text.delta',
      delta: 'saved answer',
      content_index: 0,
    });
    const terminal = converter.convertResponsesDeltaToChatGenerationChunk({
      type: 'response.completed',
      response: terminalResponse(),
    });
    const combined = text.concat(terminal);
    const collected = [];
    const handler = new ModelEndHandler(collected);

    await handler.handle('on_model_end', { output: combined.message }, { run_id: 'fixture' }, {});

    assert.equal(combined.message.text, 'saved answer');
    assert.deepEqual(collected, [terminal.message.usage_metadata]);
  });
}
