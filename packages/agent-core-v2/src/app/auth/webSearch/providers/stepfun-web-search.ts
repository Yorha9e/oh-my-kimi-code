import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';

import { postSearchJson, requireApiKey } from './search-http';

export const STEPFUN_WEB_SEARCH_DEFAULT_BASE_URL = 'https://api.stepfun.com/v1/search';

export interface StepFunWebSearchProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  n?: number;
  category?: string;
  defaultHeaders?: Record<string, string>;
  customHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface StepFunSearchResult {
  url?: string;
  position?: number;
  title?: string;
  time?: string;
  snippet?: string;
  content?: string;
}

interface StepFunSearchResponse {
  results?: StepFunSearchResult[];
}

export class StepFunWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly n: number | undefined;
  private readonly category: string | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StepFunWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? STEPFUN_WEB_SEARCH_DEFAULT_BASE_URL;
    this.n = options.n;
    this.category = options.category;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: {
      toolCallId?: string;
      signal?: AbortSignal;
    },
  ): Promise<WebSearchResult[]> {
    const accessToken = requireApiKey(this.apiKey, 'StepFun search');
    const body: Record<string, unknown> = { query };
    if (this.n !== undefined) body['n'] = this.n;
    if (this.category !== undefined && this.category.length > 0) body['category'] = this.category;

    const json = (await postSearchJson(
      this.fetchImpl,
      this.baseUrl,
      body,
      {
        ...this.defaultHeaders,
        Authorization: `Bearer ${accessToken}`,
        ...this.customHeaders,
      },
      options?.signal,
      'StepFun search',
    )) as StepFunSearchResponse;

    const raw = Array.isArray(json.results) ? json.results : [];
    return raw.map((r): WebSearchResult => {
      const snippet =
        typeof r.snippet === 'string' && r.snippet.length > 0
          ? r.snippet
          : typeof r.content === 'string'
            ? r.content
            : '';
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet,
      };
      if (typeof r.time === 'string' && r.time.length > 0) out.date = r.time;
      return out;
    });
  }
}
