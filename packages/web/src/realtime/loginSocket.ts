import type { LoginSessionStatus } from '@ea/shared';

/** 服务端 → 客户端控制消息（二进制帧之外） */
export type LoginServerMessage =
  | { type: 'frame'; width: number; height: number }
  | { type: 'page'; url: string }
  | { type: 'status'; status: LoginSessionStatus; message?: string }
  /** 刚点下的位置是否是输入框（用于唤起手机输入法） */
  | { type: 'editable'; editable: boolean; x?: number; y?: number }
  | { type: 'pong' };

/** 客户端 → 服务端输入消息（与 server/src/http/routes/login.ts 对齐） */
export type LoginInputMessage =
  | { type: 'pointer'; action: 'down' | 'up' | 'move'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaY: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code: string }
  | { type: 'text'; text: string }
  | { type: 'navigate'; action?: 'back' | 'reload'; url?: string }
  | { type: 'done' }
  | { type: 'cancel' }
  | { type: 'ping' };

export interface LoginSocketHandlers {
  onFrame?: (jpeg: Blob) => void;
  onMeta?: (meta: { width: number; height: number }) => void;
  onPage?: (url: string) => void;
  onStatus?: (status: LoginSessionStatus, message?: string) => void;
  onEditable?: (editable: boolean, point?: { x: number; y: number }) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: () => void;
}

export interface LoginSocket {
  send: (msg: LoginInputMessage) => void;
  close: () => void;
  readonly readyState: number;
}

/**
 * 远程登录 WebSocket 客户端。
 *
 * 服务端推送二进制 JPEG 帧与 JSON 控制消息；心跳 25s 由服务端 ping 驱动，
 * 客户端另每 20s 主动发 `{type:'ping'}`，防止 Cloudflare 空闲断流。
 */
export function connectLoginSocket(wsUrl: string, handlers: LoginSocketHandlers = {}): LoginSocket {
  const url = new URL(wsUrl, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new WebSocket(url);
  socket.binaryType = 'blob';

  const pingTimer = window.setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
  }, 20_000);

  const stop = (): void => window.clearInterval(pingTimer);

  socket.onmessage = (ev: MessageEvent<unknown>) => {
    if (ev.data instanceof Blob) {
      handlers.onFrame?.(ev.data);
      return;
    }
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as LoginServerMessage;
      switch (msg.type) {
        case 'frame':
          handlers.onMeta?.({ width: msg.width, height: msg.height });
          break;
        case 'page':
          handlers.onPage?.(msg.url);
          break;
        case 'status':
          handlers.onStatus?.(msg.status, msg.message);
          break;
        case 'editable':
          handlers.onEditable?.(
            msg.editable,
            typeof msg.x === 'number' && typeof msg.y === 'number'
              ? { x: msg.x, y: msg.y }
              : undefined,
          );
          break;
        case 'pong':
          break;
        default:
          break;
      }
    } catch {
      // 忽略非 JSON 帧
    }
  };

  socket.onclose = (ev) => {
    stop();
    handlers.onClose?.(ev.code, ev.reason);
  };

  socket.onerror = () => {
    handlers.onError?.();
  };

  return {
    send: (msg) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    close: () => {
      stop();
      socket.close(1000, 'client_close');
    },
    get readyState() {
      return socket.readyState;
    },
  };
}
