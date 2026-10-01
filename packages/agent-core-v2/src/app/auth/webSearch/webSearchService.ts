import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';

import {
  SERVICES_SECTION,
  type ServicesConfig,
  type WebSearchConfig,
} from '../configSection';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import { StepFunWebSearchProvider } from './providers/stepfun-web-search';
import { TavilyWebSearchProvider } from './providers/tavily-web-search';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    return this.fromWebSearchConfig() ?? this.fromServicesConfig() ?? this.fromManagedOAuth();
  }

  hasWebSearchProvider(): boolean {
    return (
      this.configuredTypedSearch() !== undefined ||
      this.configuredSearch() !== undefined ||
      this.managedTokenProvider() !== undefined
    );
  }

  private configuredTypedSearch(): WebSearchConfig | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.webSearch;
    if (search?.type === undefined) return undefined;
    if (search.type === 'stepfun' || search.type === 'tavily') {
      return nonEmptyString(search.apiKey) === undefined ? undefined : search;
    }
    if (
      nonEmptyString(search.apiKey) === undefined &&
      search.oauth === undefined &&
      search.baseUrl === undefined
    ) {
      return undefined;
    }
    return search;
  }

  private configuredSearch(): (ServicesConfig['moonshotSearch'] & { baseUrl: string }) | undefined {
    const search = this.config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch;
    if (search?.baseUrl === undefined) return undefined;
    return search as ServicesConfig['moonshotSearch'] & { baseUrl: string };
  }

  private managedTokenProvider():
    | { provider: ProviderConfig; tokenProvider: BearerTokenProvider }
    | undefined {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || provider.oauth === undefined) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) return undefined;
    return { provider, tokenProvider };
  }

  private fromWebSearchConfig(): WebSearchProvider | undefined {
    const search = this.configuredTypedSearch();
    if (search === undefined) return undefined;
    const defaultHeaders = { ...this.identity.current().requestHeaders };
    const apiKey = nonEmptyString(search.apiKey);
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);

    if (search.type === 'stepfun') {
      return new StepFunWebSearchProvider({
        baseUrl: search.baseUrl,
        apiKey,
        n: search.n,
        category: search.category,
        defaultHeaders,
        customHeaders: search.customHeaders,
      });
    }
    if (search.type === 'tavily') {
      return new TavilyWebSearchProvider({
        baseUrl: search.baseUrl,
        apiKey,
        n: search.n,
        defaultHeaders,
        customHeaders: search.customHeaders,
      });
    }
    const baseUrl = search.baseUrl ?? `${kimiCodeBaseUrl().replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      apiKey,
      defaultHeaders,
      customHeaders: search.customHeaders,
    });
  }

  private fromServicesConfig(): WebSearchProvider | undefined {
    const search = this.configuredSearch();
    if (search === undefined) return undefined;
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);
    return new MoonshotWebSearchProvider({
      baseUrl: search.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(search.apiKey),
      defaultHeaders: { ...this.identity.current().requestHeaders },
      customHeaders: search.customHeaders,
    });
  }

  private fromManagedOAuth(): WebSearchProvider | undefined {
    const managed = this.managedTokenProvider();
    if (managed === undefined) return undefined;
    const { provider, tokenProvider } = managed;
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.bootstrap.args.requestHeaders },
      customHeaders: provider.customHeaders,
    });
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  ScopeActivation.OnScopeCreated,
  'auth',
);
