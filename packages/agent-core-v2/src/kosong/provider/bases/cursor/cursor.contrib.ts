import { CursorChatProvider } from '@moonshot-ai/kosong';

import type { ChatProvider, GenerateOptions, StreamedMessage } from '#/kosong/contract/provider';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

import { registerProtocolBase } from '#/kosong/protocol/protocolBase';

class CursorProtocolAdapter implements ChatProvider {
  readonly name: string = 'cursor';
  readonly modelName: string;
  readonly thinkingEffort = null;

  readonly #inner: CursorChatProvider;

  constructor(inner: CursorChatProvider, modelName: string) {
    this.#inner = inner;
    this.modelName = modelName;
  }

  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return this.#inner.generate(systemPrompt, tools, history, options);
  }
}

registerProtocolBase({
  id: 'cursor',
  createChatProvider({ config }) {
    const inner = new CursorChatProvider({
      model: config.modelName,
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    return new CursorProtocolAdapter(inner, config.modelName);
  },
});
