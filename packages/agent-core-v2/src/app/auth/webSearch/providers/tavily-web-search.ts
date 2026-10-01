import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';

import { postSearchJson, requireApiKey } from './search-http';

export const TAVILY_WEB_SEARCH_DEFAULT_BASE_URL = 'https://api.tavily.com/search';

export interface TavilyWebSearchProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  n?: number;
  defaultHeaders?: Record<string, string>;
  customHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly n: number | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TavilyWebSearchProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? TAVILY_WEB_SEARCH_DEFAULT_BASE_URL;
    this.n = options.n;
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
    const accessToken = requireApiKey(this.apiKey, 'Tavily search');
    const body: Record<string, unknown> = { query, include_answer: false };
    if (this.n !== undefined) body['max_results'] = this.n;

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
      'Tavily search',
    )) as TavilySearchResponse;

    const raw = Array.isArray(json.results) ? json.results : [];
    return raw.map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
      };
      if (typeof r.published_date === 'string' && r.published_date.length > 0) {
        out.date = r.published_date;
      }
      return out;
    });
  }
}
