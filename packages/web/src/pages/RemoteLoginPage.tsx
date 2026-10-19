import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CHANNEL_NAMES, type LoginSessionStatus } from '@ea/shared';
import {
  keys,
  useCancelLoginSession,
  useLoginSession,
} from '../api/queries.js';
import { connectLoginSocket, type LoginSocket } from '../realtime/loginSocket.js';
import { cx } from '../lib/cx.js';
import { toast } from '../lib/toast.js';
import { Button, ErrorBanner, PageLoader, Spinner } from '../components/ui.js';

const STATUS_TEXT: Partial<Record<LoginSessionStatus, string>> = {
  pending: '正在准备浏览器…',
  running: '请在下方页面中完成登录',
  ok: '登录成功',
  failed: '登录失败',
  cancelled: '已取消',
  expired: '会话已过期',
};

/**
 * 远程登录页：接收服务端浏览器的 JPEG 帧并用 canvas 渲染，
 * 把触摸/滚轮/键盘事件转发回服务端 CDP。
 */
export default function RemoteLoginPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const session = useLoginSession(sessionId);
  const cancel = useCancelLoginSession();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<LoginSocket | null>(null);
  const sizeRef = useRef({ width: 390, height: 844 });
  const drawingRef = useRef(false);
  /** 隐藏输入框：点击画面时同步聚焦，用来唤起手机输入法 */
  const imeRef = useRef<HTMLInputElement | null>(null);
  const imeComposingRef = useRef(false);
  const imeComposedAtRef = useRef(0);
  const imeBackspaceAtRef = useRef(0);

  const [meta, setMeta] = useState({ width: 390, height: 844 });
  const [status, setStatus] = useState<LoginSessionStatus>('pending');
  const [statusMessage, setStatusMessage] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [connected, setConnected] = useState(false);
  const [socketError, setSocketError] = useState(false);
  const [text, setText] = useState('');
  const [hasFrame, setHasFrame] = useState(false);

  const finished = status === 'ok' || status === 'failed' || status === 'cancelled' || status === 'expired';

  // 轮询到的会话状态与 WS 推送合并（WS 断开时仍能感知结束）
  useEffect(() => {
    if (session.data?.status) setStatus((prev) => (prev === 'pending' ? session.data.status : prev));
  }, [session.data?.status]);

  const finishAndLeave = useCallback(
    (next: LoginSessionStatus, message?: string) => {
      setStatus(next);
      if (message) setStatusMessage(message);
      if (next === 'ok') {
        toast('账号已保存', 'success');
        void qc.invalidateQueries({ queryKey: keys.accounts });
        void qc.invalidateQueries({ queryKey: ['items'] });
      } else if (next === 'failed') {
        toast(message || '登录失败，请重试', 'error');
      }
    },
    [qc],
  );

  // 建立 WebSocket
  useEffect(() => {
    if (!session.data?.wsUrl) return undefined;
    if (finished) return undefined;

    const socket = connectLoginSocket(session.data.wsUrl, {
      onFrame: (blob) => {
        void drawFrame(blob);
      },
      onMeta: (m) => {
        sizeRef.current = m;
        setMeta(m);
        const canvas = canvasRef.current;
        if (canvas && (canvas.width !== m.width || canvas.height !== m.height)) {
          canvas.width = m.width;
          canvas.height = m.height;
        }
      },
      onPage: (url) => setPageUrl(url),
      onEditable: (editable) => {
        const input = imeRef.current;
        if (!input) return;
        if (editable) {
          input.focus({ preventScroll: true });
        } else {
          // 点击的不是输入框：收起键盘（下次点击画面仍会在手势里重新聚焦）
          input.blur();
        }
      },
      onStatus: (s, message) => {
        setStatus(s);
        if (message) setStatusMessage(message);
        if (s !== 'running' && s !== 'pending') finishAndLeave(s, message);
      },
      onClose: (code, reason) => {
        setConnected(false);
        if (code === 4404) finishAndLeave('expired', '登录会话不存在或已结束');
        else if (code === 4401) finishAndLeave('failed', '登录已失效，请重新登录本站');
        else if (reason && reason !== 'ok' && reason !== 'client_close') {
          // 服务端在结束时也会带 status 帧，这里只做兜底
          setStatusMessage((prev) => prev || reason);
        }
      },
      onError: () => setSocketError(true),
    });

    socketRef.current = socket;
    setConnected(true);
    setSocketError(false);

    return () => {
      socket.close();
      socketRef.current = null;
    };
    // finished 仅用于阻止在已结束的会话上重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.data?.wsUrl, finished, finishAndLeave]);

  // 帧绘制：串行解码，避免同一时刻多个 createImageBitmap
  const drawFrame = useCallback(async (blob: Blob) => {
    if (drawingRef.current) return;
    drawingRef.current = true;
    try {
      const bitmap = await createImageBitmap(blob);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          setHasFrame(true);
        }
      }
      bitmap.close();
    } catch {
      // 帧损坏时忽略，下一帧会覆盖
    } finally {
      drawingRef.current = false;
    }
  }, []);

  // 桌面端：页面获得焦点时转发按键（移动端用下方输入框）
  useEffect(() => {
    if (finished) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const socket = socketRef.current;
      if (!socket) return;
      if (e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        e.preventDefault();
        socket.send({ type: 'key', action: 'down', key: e.key, code: e.code });
        socket.send({ type: 'key', action: 'up', key: e.key, code: e.code });
        return;
      }
      if (e.key.length === 1) {
        socket.send({ type: 'text', text: e.key });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finished]);

  const viewportPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * width),
      y: Math.round(((clientY - rect.top) / rect.height) * height),
    };
  };

  const pointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    // 必须在用户手势里同步聚焦，否则 iOS/Android 不会弹出输入法。
    // 服务端会回一条 editable 消息：点击的不是输入框时再失焦收起键盘。
    imeRef.current?.focus({ preventScroll: true });
    const { x, y } = viewportPoint(e.clientX, e.clientY);
    socketRef.current?.send({ type: 'pointer', action: 'down', x, y });
  };

  const pointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.buttons === 0) return;
    // 拖动（滑块验证码）时收起输入法，避免键盘遮挡画面
    if (document.activeElement === imeRef.current) imeRef.current?.blur();
    const { x, y } = viewportPoint(e.clientX, e.clientY);
    socketRef.current?.send({ type: 'pointer', action: 'move', x, y });
  };

  const pointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = viewportPoint(e.clientX, e.clientY);
    socketRef.current?.send({ type: 'pointer', action: 'up', x, y });
  };

  const sendText = (): void => {
    const value = text;
    if (!value) return;
    socketRef.current?.send({ type: 'text', text: value });
    setText('');
  };

  const sendKey = (key: string, code: string): void => {
    socketRef.current?.send({ type: 'key', action: 'down', key, code });
    socketRef.current?.send({ type: 'key', action: 'up', key, code });
  };

  const remaining = useRemaining(session.data?.expiresAt);

  const title = useMemo(
    () => (session.data ? `${CHANNEL_NAMES[session.data.channel]}登录` : '远程登录'),
    [session.data],
  );

  if (session.isPending) {
    return (
      <div className="min-h-full bg-slate-100">
        <Header title="远程登录" onBack={() => navigate('/settings')} />
        <PageLoader />
      </div>
    );
  }

  if (session.isError) {
    return (
      <div className="min-h-full bg-slate-100">
        <Header title="远程登录" onBack={() => navigate('/settings')} />
        <div className="px-4 pt-4">
          <ErrorBanner message="登录会话不存在或已过期，请回到设置重新发起登录" />
          <Button block className="mt-4" onClick={() => navigate('/settings')}>
            返回设置
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-slate-900">
      <Header
        title={title}
        dark
        onBack={() => {
          if (!finished) cancel.mutate(sessionId);
          navigate('/settings');
        }}
      />

      <div className="flex flex-1 flex-col px-3 pb-4 pt-2">
        {/* 状态条 */}
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            {!finished && <span className={cx('size-1.5 rounded-full', connected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse')} />}
            {STATUS_TEXT[status] ?? status}
            {statusMessage && `：${statusMessage}`}
          </span>
          {!finished && remaining !== null && <span>剩余 {remaining}</span>}
        </div>

        {socketError && !finished && (
          <div className="mb-2 rounded-lg bg-rose-500/15 px-3 py-2 text-[11px] text-rose-200">
            实时连接异常，正在重试…若长时间无画面请返回重新发起登录。
          </div>
        )}

        {/* 画面 */}
        <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-2xl bg-slate-800 shadow-2xl">
          <canvas
            ref={canvasRef}
            width={meta.width}
            height={meta.height}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onWheel={(e) => {
              e.preventDefault();
              const { x, y } = viewportPoint(e.clientX, e.clientY);
              socketRef.current?.send({ type: 'wheel', x, y, deltaY: e.deltaY });
            }}
            className="block w-full touch-none select-none"
            style={{ aspectRatio: `${meta.width} / ${meta.height}` }}
          />

          {/* 隐藏输入框：承接手机输入法。位置保持可见（1px）以便 iOS 正常弹出键盘 */}
          <input
            ref={imeRef}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="远程页面输入"
            className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
            onCompositionStart={() => {
              imeComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              imeComposingRef.current = false;
              imeComposedAtRef.current = Date.now();
              if (e.currentTarget.value) {
                socketRef.current?.send({ type: 'text', text: e.currentTarget.value });
                e.currentTarget.value = '';
              }
            }}
            onChange={(e) => {
              // 输入法合成中的中间态不发送，等 compositionend 一次发整段
              if (imeComposingRef.current) return;
              const value = e.currentTarget.value;
              if (!value) return;
              socketRef.current?.send({ type: 'text', text: value });
              e.currentTarget.value = '';
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Backspace') {
                e.preventDefault();
                const now = Date.now();
                // 部分安卓输入法在删除最后一个字符后仍会触发一次 compositionend（值为空），
                // 短时间去重，避免重复删除。
                if (now - imeComposedAtRef.current < 120) return;
                if (now - imeBackspaceAtRef.current < 40) return;
                imeBackspaceAtRef.current = now;
                sendKey('Backspace', 'Backspace');
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                sendKey('Enter', 'Enter');
              }
            }}
          />

          {!hasFrame && !finished && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-800 text-slate-400">
              <Spinner className="size-6" />
              <p className="text-xs">{STATUS_TEXT[status] ?? '连接中…'}</p>
            </div>
          )}

          {finished && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900/80 px-6 text-center">
              <p className="text-sm font-medium text-white">
                {status === 'ok' ? '登录成功，账号已保存' : (STATUS_TEXT[status] ?? '会话已结束')}
              </p>
              {statusMessage && status !== 'ok' && (
                <p className="text-xs leading-relaxed text-slate-400">{statusMessage}</p>
              )}
              <Button
                variant={status === 'ok' ? 'primary' : 'secondary'}
                onClick={() => navigate('/settings', { replace: true })}
              >
                返回设置
              </Button>
            </div>
          )}
        </div>

        {/* 地址栏 */}
        {pageUrl && (
          <p className="mt-2 truncate px-1 text-center font-mono text-[10px] text-slate-500">
            {pageUrl}
          </p>
        )}

        {/* 工具栏 */}
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              disabled={finished}
              onClick={() => socketRef.current?.send({ type: 'navigate', action: 'back' })}
            >
              后退
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              disabled={finished}
              onClick={() => socketRef.current?.send({ type: 'navigate', action: 'reload' })}
            >
              刷新
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              disabled={finished}
              onClick={() => sendKey('Enter', 'Enter')}
            >
              回车
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              disabled={finished}
              onClick={() => sendKey('Backspace', 'Backspace')}
            >
              删除
            </Button>
          </div>

          {/* 中文输入：IME 合成完成后整段发送 */}
          <div className="flex items-center gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendText();
                }
              }}
              placeholder="备用输入框：输入后点发送"
              disabled={finished}
              className="h-10 flex-1 rounded-xl border-0 bg-slate-800 px-3 text-sm text-white ring-1 ring-slate-700 placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500 focus:outline-none"
            />
            <Button size="md" disabled={finished || !text} onClick={sendText}>
              发送
            </Button>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="secondary"
              block
              disabled={finished}
              onClick={() => {
                cancel.mutate(sessionId, {
                  onSettled: () => navigate('/settings', { replace: true }),
                });
              }}
            >
              取消
            </Button>
            <Button
              block
              disabled={finished}
              onClick={() => {
                socketRef.current?.send({ type: 'done' });
                toast('正在检查登录状态…', 'info');
              }}
            >
              我已完成登录
            </Button>
          </div>

          <p className="pt-1 text-center text-[10px] leading-relaxed text-slate-500">
            画面来自服务器上的浏览器，账号凭据只会加密保存在本服务器。
          </p>
        </div>
      </div>
    </div>
  );
}

function Header({
  title,
  onBack,
  dark,
}: {
  title: string;
  onBack: () => void;
  dark?: boolean;
}) {
  return (
    <header
      className={cx(
        'sticky top-0 z-30 flex items-center gap-2 px-2 py-2 pt-safe backdrop-blur',
        dark ? 'bg-slate-900/90' : 'bg-slate-100/90',
      )}
    >
      <button
        type="button"
        onClick={onBack}
        aria-label="返回"
        className={cx(
          'flex size-9 items-center justify-center rounded-full',
          dark ? 'text-slate-300 hover:bg-slate-800' : 'text-slate-600 hover:bg-slate-200/60',
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
          <path
            d="m14.5 5-7 7 7 7"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <h1 className={cx('flex-1 text-sm font-semibold', dark ? 'text-slate-100' : 'text-slate-800')}>
        {title}
      </h1>
    </header>
  );
}

/** 会话剩余时间（分钟:秒），过期返回 null */
function useRemaining(expiresAt: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}
