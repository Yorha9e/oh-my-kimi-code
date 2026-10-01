import { z } from 'zod';

import {
  type ConfigEffectiveOverlay,
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  snakeToCamel,
  transformPlainObject,
} from '#/app/config/toml';
import { type AssertExact, type Equal } from '#/_base/utils/typeEquality';
import type { OAuthRef } from '#/kosong/provider/provider';

export const SERVICES_SECTION = 'services';

const StringRecordSchema = z.record(z.string(), z.string());

const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

type _AssertOAuthRef = AssertExact<Equal<z.infer<typeof OAuthRefSchema>, OAuthRef>>;

export const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

export type MoonshotServiceConfig = z.infer<typeof MoonshotServiceConfigSchema>;

export const WEB_SEARCH_TYPES = ['moonshot', 'stepfun', 'tavily'] as const;

export type WebSearchType = (typeof WEB_SEARCH_TYPES)[number];

export const WebSearchConfigSchema = z.object({
  type: z.enum(WEB_SEARCH_TYPES),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  n: z.number().int().min(1).max(20).optional(),
  category: z.string().optional(),
});

export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

export const ServicesConfigSchema = z
  .object({
    moonshotSearch: MoonshotServiceConfigSchema.optional(),
    moonshotFetch: MoonshotServiceConfigSchema.optional(),
    webSearch: WebSearchConfigSchema.optional(),
  })
  .passthrough();

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

export const WEB_SEARCH_BASE_URL_ENV = 'KIMI_WEB_SEARCH_BASE_URL';
export const WEB_SEARCH_API_KEY_ENV = 'KIMI_WEB_SEARCH_API_KEY';
export const WEB_SEARCH_TYPE_ENV = 'KIMI_WEB_SEARCH_TYPE';
export const TAVILY_API_KEY_ENV = 'TAVILY_API_KEY';
export const STEPFUN_API_KEY_ENV = 'STEPFUN_API_KEY';
export const WEB_FETCH_BASE_URL_ENV = 'KIMI_WEB_FETCH_BASE_URL';
export const WEB_FETCH_API_KEY_ENV = 'KIMI_WEB_FETCH_API_KEY';

const nonBlankEnv = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseWebSearchType = (raw: string): WebSearchType | undefined => {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'moonshot' || trimmed === 'stepfun' || trimmed === 'tavily') {
    return trimmed;
  }
  return undefined;
};

const moonshotSearchEnvBindings = envBindings(MoonshotServiceConfigSchema, {
  baseUrl: { env: WEB_SEARCH_BASE_URL_ENV, parse: nonBlankEnv },
  apiKey: { env: WEB_SEARCH_API_KEY_ENV, parse: nonBlankEnv },
});

const moonshotFetchEnvBindings = envBindings(MoonshotServiceConfigSchema, {
  baseUrl: { env: WEB_FETCH_BASE_URL_ENV, parse: nonBlankEnv },
  apiKey: { env: WEB_FETCH_API_KEY_ENV, parse: nonBlankEnv },
});

const webSearchEnvBindings = envBindings(WebSearchConfigSchema, {
  type: { env: WEB_SEARCH_TYPE_ENV, parse: parseWebSearchType },
});

export const servicesEnvBindings: EnvBindings<ServicesConfig> = envBindings(
  ServicesConfigSchema,
  {
    moonshotSearch: moonshotSearchEnvBindings,
    moonshotFetch: moonshotFetchEnvBindings,
    webSearch: webSearchEnvBindings,
  },
);

const servicesCredentialEnvOverlay: ConfigEffectiveOverlay = {
  apply(effective, getEnv, validate) {
    const services = effective[SERVICES_SECTION];
    const current = isPlainObject(services) ? services : undefined;
    const moonshotSearch = isolateEnvServiceCredentials(
      current?.['moonshotSearch'],
      getEnv,
      WEB_SEARCH_BASE_URL_ENV,
      WEB_SEARCH_API_KEY_ENV,
    );
    const moonshotFetch = isolateEnvServiceCredentials(
      current?.['moonshotFetch'],
      getEnv,
      WEB_FETCH_BASE_URL_ENV,
      WEB_FETCH_API_KEY_ENV,
    );
    const webSearch = overlayWebSearchCredentials(current?.['webSearch'], getEnv);
    if (
      current !== undefined &&
      moonshotSearch === current['moonshotSearch'] &&
      moonshotFetch === current['moonshotFetch'] &&
      webSearch === current['webSearch']
    ) {
      return [];
    }
    if (
      current === undefined &&
      moonshotSearch === undefined &&
      moonshotFetch === undefined &&
      webSearch === undefined
    ) {
      return [];
    }
    effective[SERVICES_SECTION] = validate(SERVICES_SECTION, {
      ...(current ?? {}),
      moonshotSearch,
      moonshotFetch,
      webSearch,
    });
    return [SERVICES_SECTION];
  },
};

function isolateEnvServiceCredentials(
  service: unknown,
  getEnv: (name: string) => string | undefined,
  baseUrlEnv: string,
  apiKeyEnv: string,
): unknown {
  const baseUrl = nonBlankEnv(getEnv(baseUrlEnv) ?? '');
  const apiKey = nonBlankEnv(getEnv(apiKeyEnv) ?? '');
  if (baseUrl !== undefined) return { baseUrl, apiKey };
  if (apiKey === undefined) return service;
  if (!isPlainObject(service)) return { apiKey };
  const { apiKey: _apiKey, oauth: _oauth, ...rest } = service;
  return { ...rest, apiKey };
}

function overlayWebSearchCredentials(
  service: unknown,
  getEnv: (name: string) => string | undefined,
): unknown {
  const typeFromEnv = parseWebSearchType(getEnv(WEB_SEARCH_TYPE_ENV) ?? '');
  const existing = isPlainObject(service) ? service : undefined;
  const type =
    typeFromEnv ??
    (typeof existing?.['type'] === 'string' ? parseWebSearchType(String(existing['type'])) : undefined);
  if (type === undefined) return service;

  const vendorEnv =
    type === 'tavily' ? TAVILY_API_KEY_ENV : type === 'stepfun' ? STEPFUN_API_KEY_ENV : undefined;
  const vendorKey = vendorEnv === undefined ? undefined : nonBlankEnv(getEnv(vendorEnv) ?? '');
  const genericKey = nonBlankEnv(getEnv(WEB_SEARCH_API_KEY_ENV) ?? '');
  const apiKey = vendorKey ?? genericKey;
  const moonshotBaseUrl =
    type === 'moonshot' ? nonBlankEnv(getEnv(WEB_SEARCH_BASE_URL_ENV) ?? '') : undefined;

  if (apiKey === undefined && moonshotBaseUrl === undefined && typeFromEnv === undefined) {
    return service;
  }

  const base: Record<string, unknown> = existing === undefined ? { type } : { ...existing, type };
  if (moonshotBaseUrl !== undefined) {
    return { type, baseUrl: moonshotBaseUrl, apiKey };
  }
  if (apiKey !== undefined) {
    delete base['oauth'];
    return { ...base, apiKey };
  }
  return base;
}

const stripMoonshotSearchEnv = stripEnvBoundFields(moonshotSearchEnvBindings);
const stripMoonshotFetchEnv = stripEnvBoundFields(moonshotFetchEnvBindings);
const stripWebSearchTypeEnv = stripEnvBoundFields(webSearchEnvBindings);

export const stripServicesEnv: ConfigStripEnv<ServicesConfig> = (value, raw, getEnv) => {
  if (!isPlainObject(value)) return value;
  let out: ServicesConfig | undefined;
  for (const [key, strip] of [
    ['moonshotSearch', stripMoonshotSearchEnv],
    ['moonshotFetch', stripMoonshotFetchEnv],
  ] as const) {
    const entry = value[key];
    if (entry === undefined) continue;
    const stripped = strip(entry, isPlainObject(raw) ? raw[key] : undefined, getEnv);
    if (stripped === entry) continue;
    out ??= { ...value };
    if (stripped === undefined) {
      delete out[key];
    } else {
      out[key] = stripped;
    }
  }
  const webSearch = value.webSearch;
  if (webSearch !== undefined && getEnv !== undefined) {
    const stripped = stripWebSearchEnv(webSearch, isPlainObject(raw) ? raw['webSearch'] : undefined, getEnv);
    if (stripped !== webSearch) {
      out ??= { ...value };
      if (stripped === undefined) {
        delete out.webSearch;
      } else {
        out.webSearch = stripped;
      }
    }
  }
  return out ?? value;
};

function stripWebSearchEnv(
  value: WebSearchConfig,
  raw: unknown,
  getEnv: (name: string) => string | undefined,
): WebSearchConfig | undefined {
  let next = stripWebSearchTypeEnv(value, raw, getEnv) as WebSearchConfig | undefined;
  if (next === undefined) return undefined;
  const type = next.type ?? value.type;
  const vendorEnv =
    type === 'tavily' ? TAVILY_API_KEY_ENV : type === 'stepfun' ? STEPFUN_API_KEY_ENV : undefined;
  const vendorSet = vendorEnv !== undefined && nonBlankEnv(getEnv(vendorEnv) ?? '') !== undefined;
  const genericSet = nonBlankEnv(getEnv(WEB_SEARCH_API_KEY_ENV) ?? '') !== undefined;
  const moonshotBaseSet =
    type === 'moonshot' && nonBlankEnv(getEnv(WEB_SEARCH_BASE_URL_ENV) ?? '') !== undefined;
  if (!vendorSet && !genericSet && !moonshotBaseSet) return next;

  const base = isPlainObject(raw) ? raw : {};
  const out: Record<string, unknown> = { ...next };
  if (vendorSet || genericSet) {
    if (base['apiKey'] !== undefined) {
      out['apiKey'] = base['apiKey'];
    } else {
      delete out['apiKey'];
    }
  }
  if (moonshotBaseSet) {
    if (base['baseUrl'] !== undefined) {
      out['baseUrl'] = base['baseUrl'];
    } else {
      delete out['baseUrl'];
    }
  }
  if (Object.keys(out).length === 0) return undefined;
  if (out['type'] === undefined) return undefined;
  return out as WebSearchConfig;
}

export const servicesFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(rawSnake)) {
    out[snakeToCamel(name)] = isPlainObject(entry) ? serviceEntryFromToml(entry) : entry;
  }
  return out;
};

function serviceEntryFromToml(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      out[targetKey] = isPlainObject(value) ? cloneRecord(value) : value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

export const servicesToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  writeService(out, 'moonshot_search', value['moonshotSearch']);
  writeService(out, 'moonshot_fetch', value['moonshotFetch']);
  writeService(out, 'web_search', value['webSearch']);
  return out;
};

function writeService(out: Record<string, unknown>, snakeKey: string, service: unknown): void {
  if (isPlainObject(service)) {
    out[snakeKey] = serviceEntryToToml(service);
  } else {
    delete out[snakeKey];
  }
}

function serviceEntryToToml(service: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service)) {
    if (key === 'oauth' && isPlainObject(value)) {
      out[camelToSnake(key)] = plainObjectToToml(value, undefined);
    } else if (key === 'customHeaders' && value !== undefined) {
      out[camelToSnake(key)] = cloneRecord(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

registerConfigSection(SERVICES_SECTION, ServicesConfigSchema, {
  fromToml: servicesFromToml,
  toToml: servicesToToml,
  env: servicesEnvBindings,
  stripEnv: stripServicesEnv,
});
registerConfigOverlay(servicesCredentialEnvOverlay);
