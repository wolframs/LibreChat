import { repairStreamUsage } from './usage';
import type { UsageMetadata } from '@librechat/agents';
import type { ObservedStreamUsage } from '~/endpoints/anthropic/streamUsage';

/** What the parser produces for a gateway that reports usage on message_delta. */
function broken(outputTokens: number): UsageMetadata {
  return {
    input_tokens: 0,
    output_tokens: outputTokens,
    total_tokens: outputTokens,
  } as UsageMetadata;
}

function observed(partial: Partial<ObservedStreamUsage>): ObservedStreamUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...partial,
  };
}

describe('repairStreamUsage', () => {
  it('fills in input and cache counts for a record that arrived with none', () => {
    const collected = [broken(5)];
    const count = repairStreamUsage(collected, [
      observed({ inputTokens: 15, outputTokens: 5, cacheCreationInputTokens: 36183 }),
    ]);

    expect(count).toBe(1);
    /**
     * Written the way Anthropic reports it — `input_tokens` inclusive of the
     * cached portion — because `splitUsage` subtracts the details back out for
     * this provider. Recording the gateway's net input would drop the cached
     * tokens from the bill entirely.
     */
    expect(collected[0].input_tokens).toBe(15 + 36183);
    expect(collected[0].total_tokens).toBe(15 + 36183 + 5);
    expect(collected[0].input_token_details).toEqual({
      cache_creation: 36183,
      cache_read: 0,
    });
  });

  it('leaves a record the parser already filled completely alone', () => {
    /** The load-bearing guarantee: this can only ever add a number that was
     *  missing, never replace one that was there. */
    const healthy = {
      input_tokens: 4321,
      output_tokens: 250,
      total_tokens: 4571,
      input_token_details: { cache_read: 900, cache_creation: 0 },
    } as UsageMetadata;
    const collected = [healthy];

    const count = repairStreamUsage(collected, [
      observed({ inputTokens: 999999, outputTokens: 250, cacheCreationInputTokens: 999999 }),
    ]);

    expect(count).toBe(0);
    expect(collected[0]).toEqual(healthy);
  });

  it('leaves a zero-input record alone when it already has cache detail', () => {
    const collected = [
      {
        input_tokens: 0,
        output_tokens: 5,
        total_tokens: 5,
        input_token_details: { cache_read: 6214, cache_creation: 0 },
      } as UsageMetadata,
    ];
    expect(repairStreamUsage(collected, [observed({ inputTokens: 77, outputTokens: 5 })])).toBe(0);
    expect(collected[0].input_tokens).toBe(0);
  });

  it('refuses to repair when no observation matches on output tokens', () => {
    /** Better a missing number than a number belonging to another call. */
    const collected = [broken(5)];
    const count = repairStreamUsage(collected, [
      observed({ inputTokens: 15, outputTokens: 999, cacheCreationInputTokens: 100 }),
    ]);
    expect(count).toBe(0);
    expect(collected[0].input_tokens).toBe(0);
  });

  it('matches concurrent calls by output tokens, not by position', () => {
    const collected = [broken(11), broken(22)];
    /** Deliberately out of order relative to `collected`. */
    const count = repairStreamUsage(collected, [
      observed({ inputTokens: 2, outputTokens: 22, cacheReadInputTokens: 2000 }),
      observed({ inputTokens: 1, outputTokens: 11, cacheReadInputTokens: 1000 }),
    ]);

    expect(count).toBe(2);
    expect(collected[0].input_tokens).toBe(1 + 1000);
    expect(collected[1].input_tokens).toBe(2 + 2000);
  });

  it('consumes each observation once, so a tie does not double-apply', () => {
    const collected = [broken(5), broken(5)];
    const count = repairStreamUsage(collected, [
      observed({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100 }),
    ]);
    expect(count).toBe(1);
    expect(collected[0].input_tokens).toBe(110);
    expect(collected[1].input_tokens).toBe(0);
  });

  it('is a no-op with nothing to do', () => {
    expect(repairStreamUsage([], [observed({ inputTokens: 1, outputTokens: 1 })])).toBe(0);
    expect(repairStreamUsage([broken(5)], [])).toBe(0);
    expect(
      repairStreamUsage(
        undefined as unknown as UsageMetadata[],
        undefined as unknown as ObservedStreamUsage[],
      ),
    ).toBe(0);
  });

  it('skips null entries without throwing', () => {
    const collected = [null as unknown as UsageMetadata, broken(5)];
    expect(
      repairStreamUsage(collected, [observed({ inputTokens: 3, outputTokens: 5 })]),
    ).toBe(1);
    expect(collected[1].input_tokens).toBe(3);
  });

  it('preserves unrelated input_token_details already present', () => {
    const collected = [
      { input_tokens: 0, output_tokens: 5, total_tokens: 5, input_token_details: { audio: 12 } },
    ] as unknown as UsageMetadata[];
    repairStreamUsage(collected, [
      observed({ inputTokens: 7, outputTokens: 5, cacheReadInputTokens: 70 }),
    ]);
    expect(collected[0].input_token_details).toEqual({
      audio: 12,
      cache_creation: 0,
      cache_read: 70,
    });
  });
});

describe('repairStreamUsage — draining across passes', () => {
  /**
   * One HTTP request bills twice: the reply under `context: 'message'` and the
   * auto-generated title under `context: 'title'`, each with its own
   * `collectedUsage` but both reading `req.observedStreamUsage`. A claimed
   * observation must not survive into the second pass, or the title can be
   * billed the reply's input tokens whenever their output counts coincide.
   */
  it('removes claimed observations from the shared list', () => {
    const shared: ObservedStreamUsage[] = [
      observed({ inputTokens: 6000, outputTokens: 16, cacheReadInputTokens: 28498 }),
      observed({ inputTokens: 70, outputTokens: 41 }),
    ];

    const messagePass = [broken(16)];
    expect(repairStreamUsage(messagePass, shared)).toBe(1);
    expect(messagePass[0].input_tokens).toBe(6000 + 28498);
    expect(shared).toHaveLength(1);

    const titlePass = [broken(41)];
    expect(repairStreamUsage(titlePass, shared)).toBe(1);
    expect(titlePass[0].input_tokens).toBe(70);
    expect(shared).toHaveLength(0);
  });

  it('does not let a later pass reuse an already-claimed observation', () => {
    const shared: ObservedStreamUsage[] = [
      observed({ inputTokens: 9999, outputTokens: 5, cacheReadInputTokens: 1 }),
    ];
    expect(repairStreamUsage([broken(5)], shared)).toBe(1);
    /** Same output count, but the observation is spent — leave the record be. */
    const second = [broken(5)];
    expect(repairStreamUsage(second, shared)).toBe(0);
    expect(second[0].input_tokens).toBe(0);
  });
});
