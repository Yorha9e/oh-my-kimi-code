import type { StreamedMessagePart, TextPart } from '#/message';
import { CursorChatProvider } from '#/providers/cursor';
import { MockChatProvider } from './fixtures/mock-provider';
import { describe, it, expect } from 'vitest';

describe('MockChatProvider', () => {
  it('streams predefined parts', async () => {
    const inputParts: StreamedMessagePart[] = [
      { type: 'text', text: 'Hello, world!' } satisfies TextPart,
    ];

    const provider = new MockChatProvider(inputParts);
    const stream = await provider.generate('', [], []);

    const outputParts: StreamedMessagePart[] = [];
    for await (const part of stream) {
      outputParts.push(part);
    }

    expect(outputParts).toEqual(inputParts);
  });

  it('returns the same parts on multiple calls', async () => {
    const inputParts: StreamedMessagePart[] = [
      { type: 'text', text: 'Hello' } satisfies TextPart,
      { type: 'text', text: ', world!' } satisfies TextPart,
    ];

    const provider = new MockChatProvider(inputParts);

    // First call
    const parts1: StreamedMessagePart[] = [];
    for await (const part of await provider.generate('', [], [])) {
      parts1.push(part);
    }

    // Second call
    const parts2: StreamedMessagePart[] = [];
    for await (const part of await provider.generate('', [], [])) {
      parts2.push(part);
    }

    expect(parts1).toEqual(inputParts);
    expect(parts2).toEqual(inputParts);
  });

  it('has correct default properties', () => {
    const provider = new MockChatProvider([]);
    expect(provider.name).toBe('mock');
    expect(provider.modelName).toBe('mock');
    expect(provider.thinkingEffort).toBeNull();
  });

  it('returns correct id and usage from stream', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hi' }], {
      id: 'test-id',
      usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 0 },
    });

    const stream = await provider.generate('', [], []);
    // consume stream
    for await (const _ of stream) {
      void _;
    }

    expect(stream.id).toBe('test-id');
    expect(stream.usage).toEqual({
      inputOther: 10,
      output: 5,
      inputCacheRead: 3,
      inputCacheCreation: 0,
    });
  });

  it('withThinking returns a new provider', () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hi' }]);
    const newProvider = provider.withThinking('high');
    expect(newProvider).toBeInstanceOf(MockChatProvider);
    expect(newProvider).not.toBe(provider);
  });

  it('defaults finishReason to completed and rawFinishReason to stop', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hi' }]);
    const stream = await provider.generate('', [], []);
    for await (const _ of stream) {
      void _;
    }
    expect(stream.finishReason).toBe('completed');
    expect(stream.rawFinishReason).toBe('stop');
  });

  it('honors explicit finishReason and rawFinishReason options', async () => {
    const provider = new MockChatProvider([{ type: 'text', text: 'hi' }], {
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const stream = await provider.generate('', [], []);
    for await (const _ of stream) {
      void _;
    }
    expect(stream.finishReason).toBe('truncated');
    expect(stream.rawFinishReason).toBe('length');
  });
});

describe('CursorChatProvider', () => {
  it('keeps configured modelParams in the wire selection without a thinking effort', async () => {
    const provider = new CursorChatProvider({ model: 'gpt-4o', modelParams: { fast: 'true' } });
    // `_thinkingEffort` stays null — `withThinking` is never called — so the
    // early exit must still merge the configured params into the selection.
    const selection = await (provider as unknown as {
      resolveWireModel(): Promise<{ id: string; params?: Array<{ id: string; value: string }> }>;
    }).resolveWireModel();
    expect(selection).toEqual({ id: 'gpt-4o', params: [{ id: 'fast', value: 'true' }] });
  });
});
