import { Error2, ErrorCodes } from '#/errors';

export async function postSearchJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status === 401) {
    const detail = await safeReadText(response);
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `${label} request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
      { details: { status: response.status } },
    );
  }

  if (response.status !== 200) {
    const detail = await safeReadText(response);
    throw new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      `${label} request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      { details: { status: response.status } },
    );
  }

  return response.json();
}

export function requireApiKey(apiKey: string | undefined, label: string): string {
  if (apiKey !== undefined && apiKey.length > 0) return apiKey;
  throw new Error2(ErrorCodes.AUTH_TOKEN_MISSING, `${label} is not configured: missing API key.`);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
