import { CursorNativeChatProvider, type CursorProviderSnapshot } from '@moonshot-ai/kosong';

import type { ChatProvider, GenerateOptions, StreamedMessage } from '#/kosong/contract/provider';
import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

import { registerProtocolBase } from '#/kosong/protocol/protocolBase';

import { cursorHydrateProvider } from './cursorBridge';

class CursorProtocolAdapter implements ChatProvider {
  readonly name: string = 'cursor';
  readonly modelName: string;
  readonly thinkingEffort = null;

  private readonly _inner: CursorNativeChatProvider;

  constructor(inner: CursorNativeChatProvider, modelName: string) {
    this._inner = inner;
    this.modelName = modelName;
  }

  snapshotState(): CursorProviderSnapshot {
    return this._inner.snapshotState();
  }

  restoreState(snapshot: CursorProviderSnapshot): void {
    this._inner.restoreState(snapshot);
  }

  generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    return this._inner.generate(systemPrompt, tools, history, options);
  }
}

registerProtocolBase({
  id: 'cursor',
  createChatProvider({ config }) {
    const inner = new CursorNativeChatProvider({
      model: config.modelName,
      apiKey: config.apiKey,
      gatewayUrl: config.baseUrl,
      modelParams: config.providerOptions?.modelParams,
    });
    const adapter = new CursorProtocolAdapter(inner, config.modelName);
    cursorHydrateProvider(adapter);
    config.hydrate?.(adapter);
    return adapter;
  },
});
