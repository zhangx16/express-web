import type { ApiError } from '@ea/shared';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

function readCookie(name: string): string {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** 会话失效时通知上层跳转登录页 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

/** 调用 `/api` 下的接口；写请求自动带 CSRF 双提交头 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers(options.headers);

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      body = options.body;
    } else {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.body);
    }
  }

  if (method !== 'GET') {
    const csrf = readCookie('ea_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body,
    signal: options.signal,
    credentials: 'same-origin',
  });

  if (res.status === 401 && path !== '/auth/login') notifyUnauthorized();

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const err = payload as Partial<ApiError> | null;
    throw new ApiClientError(
      res.status,
      err?.error ?? 'request_failed',
      err?.message ?? `请求失败（${res.status}）`,
    );
  }

  return payload as T;
}

/** 拼查询串，自动跳过空值 */
export function qs(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** 免鉴权健康检查（不走 /api 前缀） */
export async function fetchHealth(): Promise<import('@ea/shared').HealthResponse> {
  const res = await fetch('/health', { credentials: 'same-origin' });
  if (!res.ok) throw new ApiClientError(res.status, 'health_failed', '健康检查失败');
  return (await res.json()) as import('@ea/shared').HealthResponse;
}
