import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMe } from './api/queries.js';
import { createEventInvalidator } from './realtime/invalidation.js';
import { subscribeEvents } from './realtime/events.js';
import { PageLoader, Toaster } from './components/ui.js';
import AppShell from './components/AppShell.js';

const LoginPage = lazy(() => import('./pages/LoginPage.js'));
const HomePage = lazy(() => import('./pages/HomePage.js'));
const ItemPage = lazy(() => import('./pages/ItemPage.js'));
const ReportsPage = lazy(() => import('./pages/ReportsPage.js'));
const HiddenPage = lazy(() => import('./pages/HiddenPage.js'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'));
const RemoteLoginPage = lazy(() => import('./pages/RemoteLoginPage.js'));

/** 未登录时跳转登录页，并带上回跳地址 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <PageLoader />;
  if (!me.data?.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

/** 全局 SSE：同步进度、账号状态、日报生成等事件驱动缓存刷新 */
function useGlobalEvents(): void {
  const me = useMe();
  const authenticated = Boolean(me.data?.user);
  const qc = useQueryClient();
  useEffect(() => {
    if (!authenticated) return;
    const invalidator = createEventInvalidator(qc);
    let connected = false;
    const unsubscribe = subscribeEvents({
      onEvent: (event) => invalidator.handle(event.type),
      onStateChange: (state) => {
        if (state === 'open') {
          if (connected) invalidator.reconnect();
          connected = true;
        }
      },
    });
    return () => { unsubscribe(); invalidator.dispose(); };
  }, [qc, authenticated]);
}

export default function App() {
  useGlobalEvents();

  return (
    <>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/login/remote/:sessionId"
            element={
              <RequireAuth>
                <RemoteLoginPage />
              </RequireAuth>
            }
          />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<HomePage />} />
            <Route path="item/:mailNo" element={<ItemPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="hidden" element={<HiddenPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
