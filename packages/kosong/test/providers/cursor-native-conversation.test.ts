import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  type Message,
  type ToolCall,
} from '#/message';
import {
  buildConversationState,
  buildRunRequest,
  mapTurnEndedUsage,
  toUiTurns,
  type CursorUiMessage,
} from '#/providers/cursor-native/conversation';
import { describe, expect, it, vi } from 'vitest';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runRequestOf(frame: Record<string, unknown>): Record<string, unknown> {
  return frame['runRequest'] as Record<string, unknown>;
}

function userMessageOf(runRequest: Record<string, unknown>): Record<string, unknown> {
  const action = runRequest['action'] as Record<string, unknown>;
  const userMessageAction = action['userMessageAction'] as Record<string, unknown>;
  return userMessageAction['userMessage'] as Record<string, unknown>;
}

function decodeBlobValue(value: string): CursorUiMessage {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as CursorUiMessage;
}

function readToolCall(): ToolCall {
  return { type: 'function', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' };
}

describe('buildRunRequest first round', () => {
  it('sends an empty conversation state with user text and uuids', () => {
    const frame = buildRunRequest({ modelId: 'default', history: [createUserMessage('hello')] });
    const runRequest = runRequestOf(frame);
    expect(runRequest['conversationState']).toEqual({});
    expect(runRequest['preFetchedBlobs']).toBeUndefined();
    expect(userMessageOf(runRequest)['text']).toBe('hello');
    expect(String(runRequest['runId'])).toMatch(UUID_PATTERN);
    expect(String(userMessageOf(runRequest)['messageId'])).toMatch(UUID_PATTERN);
  });

  it('maps the requested model, parameters, and folds the system prompt into the user text', () => {
    const frame = buildRunRequest({
      modelId: 'default',
      history: [createUserMessage('hi')],
      systemPrompt: 'be brief',
      modelParams: { effort: 'high' },
    });
    const runRequest = runRequestOf(frame);
    expect(runRequest['requestedModel']).toEqual({
      modelId: 'default',
      parameters: [{ id: 'effort', value: 'high' }],
    });
    expect(runRequest['customSystemPrompt']).toBeUndefined();
    expect(userMessageOf(runRequest)['text']).toBe('be brief\n\nhi');
  });

  it('omits optional wire fields when they are empty', () => {
    const frame = buildRunRequest({ modelId: 'default', history: [createUserMessage('hi')], systemPrompt: '' });
    const runRequest = runRequestOf(frame);
    expect(runRequest['customSystemPrompt']).toBeUndefined();
    expect(runRequest['conversationId']).toBeUndefined();
    expect((runRequest['requestedModel'] as Record<string, unknown>)['parameters']).toBeUndefined();
  });

  it('replays a server-issued checkpoint verbatim as conversationState', () => {
    const checkpoint = {
      turns: ['AAAA', 'BBBB'],
      tokenDetails: { usedTokens: '100', maxTokens: '200000' },
      previousWorkspaceUris: ['file:///C:/work'],
    };
    const frame = buildRunRequest({
      modelId: 'default',
      history: [createUserMessage('follow-up')],
      checkpoint,
    });
    const runRequest = runRequestOf(frame);
    expect(runRequest['conversationState']).toEqual(checkpoint);
    expect(runRequest['preFetchedBlobs']).toBeUndefined();
  });

  it('sends continuation turns and persists back blob payloads via preFetchedBlobs', () => {
    const blobs = [
      { id: 'AAAA', value: 'eyJyb2xlIjoidXNlciJ9' },
      { id: 'BBBB', value: 'eyJyb2xlIjoiYXNzaXN0YW50In0=' },
    ];
    const frame = buildRunRequest({
      modelId: 'default',
      history: [createUserMessage('follow-up')],
      turns: ['AAAA', 'BBBB'],
      blobs,
    });
    const runRequest = runRequestOf(frame);
    expect(runRequest['conversationState']).toEqual({ turns: ['AAAA', 'BBBB'] });
    expect(runRequest['preFetchedBlobs']).toEqual(blobs);
  });

  it('folds fresh-run workspace context into an otherwise empty conversationState', () => {
    const frame = buildRunRequest({
      modelId: 'default',
      history: [createUserMessage('hi')],
      workspace: {
        cwd: 'C:\\work\\repo',
        branch: 'main',
        agentType: 'ide',
        timestampMs: 1788000000000,
        timeZone: 'Asia/Shanghai',
      },
    });
    const state = runRequestOf(frame)['conversationState'] as Record<string, unknown>;
    expect(state['previousWorkspaceUris']).toEqual(['file:///C:/work/repo']);
    expect(state['activeBranchName']).toBe('main');
    expect(state['agentType']).toBe('ide');
    expect(state['conversationStartedTimestampMs']).toBe('1788000000000');
    expect(state['conversationStartedTimeZone']).toBe('Asia/Shanghai');
  });
});

describe('buildConversationState continuation', () => {
  it('carries prior turns as blobs with matching turn ids', () => {
    const history: Message[] = [
      createUserMessage('first question'),
      createAssistantMessage([{ type: 'text', text: 'first answer' }]),
      createUserMessage('follow-up'),
    ];
    const { conversationState, preFetchedBlobs } = buildConversationState(history);
    expect(preFetchedBlobs).toHaveLength(2);
    const blobs = preFetchedBlobs!;
    expect(conversationState['turns']).toEqual(blobs.map((blob) => blob.id));
    const turns = blobs.map((blob) => decodeBlobValue(blob.value));
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'first question' }],
    });
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer' }],
    });
    for (const blob of blobs) {
      expect(typeof blob.id).toBe('string');
      expect(blob.id.length).toBeGreaterThan(0);
    }
  });

  it('tolerates an assistant message whose toolCalls field is absent (undefined)', () => {
    const history: Message[] = [
      createUserMessage('q'),
      // Real-world messages may omit the toolCalls key entirely (plain-text
      // assistant replies from other providers or hand-built histories).
      { role: 'assistant', content: [{ type: 'text', text: 'plain answer' }] } as unknown as Message,
      createUserMessage('next'),
    ];
    const { preFetchedBlobs } = buildConversationState(history);
    const assistant = decodeBlobValue(preFetchedBlobs![1]!.value);
    expect(assistant.content).toEqual([{ type: 'text', text: 'plain answer' }]);
  });

  it('maps think parts onto reasoning content with the signature', () => {
    const history: Message[] = [
      createUserMessage('q'),
      createAssistantMessage([{ type: 'think', think: 'let me think', encrypted: 'sig-1' }]),
      createUserMessage('next'),
    ];
    const { preFetchedBlobs } = buildConversationState(history);
    const assistant = decodeBlobValue(preFetchedBlobs![1]!.value);
    expect(assistant.content).toEqual([{ type: 'reasoning', text: 'let me think', signature: 'sig-1' }]);
  });
});

describe('tool history', () => {
  it('pairs tool-call content with the tool result in the assistant turn', () => {
    const history: Message[] = [
      createUserMessage('list the file'),
      createAssistantMessage([{ type: 'text', text: 'reading now' }], [readToolCall()]),
      createToolMessage('call-1', 'file contents here'),
      createUserMessage('thanks'),
    ];
    const { conversationState, preFetchedBlobs } = buildConversationState(history);
    const blobs = preFetchedBlobs!;
    expect(blobs).toHaveLength(2);
    expect(conversationState['turns']).toEqual(blobs.map((blob) => blob.id));
    const assistant = decodeBlobValue(blobs[1]!.value);
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toEqual([
      { type: 'text', text: 'reading now' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', args: '{"path":"a.txt"}' },
      { type: 'text', text: 'file contents here' },
    ]);
  });
});

describe('mapTurnEndedUsage', () => {
  it('maps complete per-turn fields onto TokenUsage', () => {
    expect(
      mapTurnEndedUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, reasoning: 20 }),
    ).toEqual({
      inputOther: 100,
      output: 50,
      inputCacheRead: 10,
      inputCacheCreation: 5,
    });
  });

  it('treats missing and non-numeric fields as zero without NaN', () => {
    expect(mapTurnEndedUsage({})).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(mapTurnEndedUsage({ input: 12 })).toEqual({
      inputOther: 12,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    const guarded = mapTurnEndedUsage({ input: Number.NaN, output: undefined, cacheRead: 'x', cacheWrite: null });
    expect(guarded).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    for (const value of Object.values(guarded)) {
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('maps an all-zero event onto zeros', () => {
    expect(mapTurnEndedUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });
});

describe('multimodal parts', () => {
  it('skips media parts with a warning instead of crashing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', imageUrl: { url: 'https://example.test/shot.png' } },
            { type: 'audio_url', audioUrl: { url: 'https://example.test/clip.mp3' } },
          ],
          toolCalls: [],
        },
      ];
      const turns = toUiTurns(history);
      expect(turns).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'look at this' }], providerOptions: undefined },
      ]);
      const frame = buildRunRequest({ modelId: 'default', history });
      expect(runRequestOf(frame)['conversationState']).toEqual({});
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
