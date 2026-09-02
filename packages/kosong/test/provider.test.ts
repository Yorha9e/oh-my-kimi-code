import type { StreamedMessagePart, TextPart } from '#/message';
import { CursorChatProvider } from '#/providers/cursor';
import { MockChatProvider } from './fixtures/mock-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  // Fixed catalog entries mirroring the real AvailableModels proto-JSON:
  // value sets nest under `parameterType.enumParameter.values` /
  // `booleanParameter.values` — there is no top-level `values` on the wire.
  // `claude-fable-5-1` deliberately places `effort` THIRD so a positional
  // lookup would hit the boolean `thinking` parameter instead.
  const catalog = [
    {
      name: 'grok-4.6',
      parameterDefinitions: [
        {
          id: 'effort',
          name: 'Effort',
          parameterType: {
            enumParameter: {
              values: [
                { value: 'low' },
                { value: 'medium' },
                { value: 'high' },
                { value: 'xhigh' },
              ],
            },
          },
        },
        {
          id: 'fast',
          parameterType: {
            booleanParameter: { values: [{ value: 'false' }, { value: 'true' }] },
          },
        },
      ],
    },
    {
      name: 'gpt-5.2',
      parameterDefinitions: [
        {
          id: 'reasoning',
          name: 'Reasoning',
          parameterType: {
            enumParameter: {
              values: [
                { value: 'low' },
                { value: 'medium' },
                { value: 'high' },
                { value: 'extra-high' },
              ],
            },
          },
        },
      ],
    },
    {
      name: 'claude-fable-5-1',
      parameterDefinitions: [
        {
          id: 'thinking',
          parameterType: {
            booleanParameter: { values: [{ value: 'false' }, { value: 'true' }] },
          },
        },
        {
          id: 'context',
          parameterType: {
            enumParameter: { values: [{ value: '300k' }, { value: '1m' }] },
          },
        },
        {
          id: 'effort',
          name: 'Effort',
          parameterType: {
            enumParameter: {
              values: [
                { value: 'low' },
                { value: 'medium' },
                { value: 'high' },
                { value: 'xhigh' },
                { value: 'max' },
              ],
            },
          },
        },
        {
          id: 'fast',
          parameterType: {
            booleanParameter: { values: [{ value: 'false' }, { value: 'true' }] },
          },
        },
      ],
    },
    {
      name: 'claude-opus-5',
      parameterDefinitions: [
        {
          id: 'thinking',
          parameterType: {
            booleanParameter: { values: [{ value: 'false' }, { value: 'true' }] },
          },
        },
        {
          id: 'context',
          parameterType: {
            enumParameter: { values: [{ value: '300k' }, { value: '1m' }] },
          },
        },
        {
          id: 'effort',
          name: 'Effort',
          parameterType: {
            enumParameter: {
              values: [
                { value: 'low' },
                { value: 'medium' },
                { value: 'high' },
                { value: 'xhigh' },
                { value: 'max' },
              ],
            },
          },
        },
      ],
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Serve the fixed catalog for the provider's AvailableModels fetch. */
  function stubCatalog(): void {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ models: catalog }), { status: 200 }),
    );
  }

  /** Resolve the wire model for the given effort against the stubbed catalog. */
  async function resolveWireModel(provider: CursorChatProvider, effort: string) {
    const wire = provider.withThinking(effort) as unknown as {
      resolveWireModel(): Promise<{ id: string; params?: Array<{ id: string; value: string }> }>;
    };
    return wire.resolveWireModel();
  }

  it('resolves grok-4.6 effort by parameter id and sends no thinking', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({ model: 'grok-4.6', apiKey: 'test-key' });
    await expect(resolveWireModel(provider, 'high')).resolves.toEqual({
      id: 'grok-4.6',
      params: [{ id: 'effort', value: 'high' }],
    });
  });

  it('sends grok-4.6 xhigh verbatim without mapping it to extra-high', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({ model: 'grok-4.6', apiKey: 'test-key' });
    await expect(resolveWireModel(provider, 'xhigh')).resolves.toEqual({
      id: 'grok-4.6',
      params: [{ id: 'effort', value: 'xhigh' }],
    });
  });

  it('maps gpt-5.2 xhigh to the reasoning value extra-high', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({ model: 'gpt-5.2', apiKey: 'test-key' });
    await expect(resolveWireModel(provider, 'xhigh')).resolves.toEqual({
      id: 'gpt-5.2',
      params: [{ id: 'reasoning', value: 'extra-high' }],
    });
  });

  it('finds the effort parameter declared third on claude-fable-5-1', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({ model: 'claude-fable-5-1', apiKey: 'test-key' });
    await expect(resolveWireModel(provider, 'high')).resolves.toEqual({
      id: 'claude-fable-5-1',
      params: [
        { id: 'effort', value: 'high' },
        { id: 'thinking', value: 'true' },
      ],
    });
  });

  it('falls back to the bare id when the effort is outside the declared values', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({ model: 'grok-4.6', apiKey: 'test-key' });
    // grok-4.6 declares low|medium|high|xhigh — `max` is not in range, so the
    // wire selection must NOT carry an effort param the catalog rejects.
    await expect(resolveWireModel(provider, 'max')).resolves.toEqual({ id: 'grok-4.6' });
  });

  it('attaches thinking=true when the model declares the parameter', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({ model: 'claude-opus-5', apiKey: 'test-key' });
    await expect(resolveWireModel(provider, 'high')).resolves.toEqual({
      id: 'claude-opus-5',
      params: [
        { id: 'effort', value: 'high' },
        { id: 'thinking', value: 'true' },
      ],
    });
  });

  it('lets modelParams override the resolved thinking value', async () => {
    stubCatalog();
    const provider = new CursorChatProvider({
      model: 'claude-opus-5',
      apiKey: 'test-key',
      modelParams: { thinking: 'false' },
    });
    await expect(resolveWireModel(provider, 'high')).resolves.toEqual({
      id: 'claude-opus-5',
      params: [
        { id: 'effort', value: 'high' },
        { id: 'thinking', value: 'false' },
      ],
    });
  });
});
