/** 抓取器统一错误类型（路由层据此映射账号状态） */

export class AuthExpiredError extends Error {
  constructor(message = '登录态已失效，请重新登录') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export class RiskChallengeError extends Error {
  constructor(message = '平台要求安全验证，请重新登录') {
    super(message);
    this.name = 'RiskChallengeError';
  }
}

export class RateLimitedError extends Error {
  constructor(message = '请求过于频繁，请稍后再试') {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export class ParseError extends Error {
  constructor(message = '页面结构变化，解析失败') {
    super(message);
    this.name = 'ParseError';
  }
}

export class TimeoutError extends Error {
  constructor(message = '抓取超时') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class NetworkError extends Error {
  constructor(message = '网络请求失败') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** 浏览器渠道错误 → 账号状态 */
export function accountStatusFor(err: unknown): 'needs_login' | 'challenge' | 'error' {
  if (err instanceof AuthExpiredError) return 'needs_login';
  if (err instanceof RiskChallengeError) return 'challenge';
  return 'error';
}

/** 面向用户的简短错误文案（绝不包含 URL 参数/凭据） */
export function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/([?&](?:token|passToken|pt_key|serviceToken|PDDAccessToken|_m_h5_tk)=)[^&\s]+/gi, '$1***')
    .slice(0, 300);
}
