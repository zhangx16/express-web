import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMe, useLogin } from '../api/queries.js';
import { ApiClientError } from '../api/client.js';
import { Button, ErrorBanner, Input, Label, Spinner } from '../components/ui.js';

/** 登录页：密码 + 会话 Cookie；已登录直接回跳 */
export default function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const me = useMe();
  const login = useLogin();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const next = safeNext(params.get('next'));

  useEffect(() => {
    if (me.data?.user) navigate(next, { replace: true });
  }, [me.data, navigate, next]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    login.mutate(
      { username: username.trim(), password },
      {
        onSuccess: () => navigate(next, { replace: true }),
      },
    );
  };

  if (me.isPending) {
    return (
      <div className="flex min-h-full items-center justify-center text-slate-400">
        <Spinner className="size-6" />
      </div>
    );
  }

  const error = login.error;
  const message =
    error instanceof ApiClientError
      ? error.status === 429
        ? '尝试次数过多，请 15 分钟后再试'
        : error.message
      : error
        ? '登录失败，请稍后重试'
        : null;

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/25">
            <svg viewBox="0 0 24 24" fill="none" className="size-9" aria-hidden="true">
              <path
                d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z M3.5 8.5 12 13l8.5-4.5 M12 13v7"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-slate-900">快递助手</h1>
          <p className="mt-1 text-xs text-slate-400">京东 · 淘宝 · 拼多多</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5">
          {message && <ErrorBanner message={message} />}

          <div>
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              disabled={login.isPending}
            />
          </div>

          <div>
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              disabled={login.isPending}
            />
          </div>

          <Button
            type="submit"
            block
            size="lg"
            loading={login.isPending}
            disabled={!username.trim() || !password}
          >
            登录
          </Button>
        </form>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-400">
          自托管服务，仅限本人使用。
          <br />
          登录凭据保存在本服务器，不会上传到第三方。
        </p>
      </div>
    </div>
  );
}

/** 只允许站内相对路径，避免开放重定向 */
function safeNext(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}
