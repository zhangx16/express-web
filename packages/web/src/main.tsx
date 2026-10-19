import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ApiClientError, onUnauthorized } from './api/client.js';
import App from './App.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // 4xx 不重试（尤其是 401/403）
        if (error instanceof ApiClientError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

// 会话失效：跳转登录页（保留当前路径，登录后返回）。
// 这里不能调用 queryClient.clear()：notifyUnauthorized 在请求 Promise settle 之前触发，
// clear() 会销毁仍在 fetching 的 me 查询并静默取消它，observer 永远等不到结果，
// 登录页就会一直转圈。整页跳转本身会丢弃缓存。
onUnauthorized(() => {
  if (window.location.pathname === '/login') return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace(`/login?next=${next}`);
});

const container = document.getElementById('root');
if (!container) throw new Error('root 节点缺失');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
