import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useEffect, useId, useRef } from 'react';
import { cx } from '../lib/cx.js';
import { useToasts } from '../lib/toast.js';

// ───────────────────────── 按钮 ─────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 shadow-sm',
  secondary:
    'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 active:bg-slate-100',
  ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 active:bg-slate-200',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800 shadow-sm',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs rounded-lg gap-1.5',
  md: 'h-10 px-4 text-sm rounded-xl gap-2',
  lg: 'h-12 px-5 text-base rounded-xl gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center font-medium transition-colors select-none',
        'disabled:opacity-50 disabled:pointer-events-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        block && 'w-full',
        className,
      )}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

// ───────────────────────── 加载 ─────────────────────────

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin text-current', className ?? 'size-5')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-20" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PageLoader() {
  return (
    <div className="flex items-center justify-center py-16 text-slate-400">
      <Spinner className="size-6" />
    </div>
  );
}

// ───────────────────────── 表单 ─────────────────────────

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-slate-500">
      {children}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-10 w-full rounded-xl border-0 bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-200',
        'placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none',
        'disabled:bg-slate-50 disabled:text-slate-400',
        className,
      )}
    />
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cx(
        'w-full rounded-xl border-0 bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-200',
        'placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none',
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx(
        'h-10 w-full appearance-none rounded-xl border-0 bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-200',
        'focus:ring-2 focus:ring-indigo-500 focus:outline-none',
        'disabled:bg-slate-50 disabled:text-slate-400',
        className,
      )}
    >
      {children}
    </select>
  );
}

/** 底部弹出的操作面板（移动端友好的 confirm / action sheet） */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? []).filter((node) => node.getClientRects().length > 0);
    if (!panel.current?.contains(document.activeElement)) (focusable()[0] ?? panel.current)?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first || !last) { event.preventDefault(); panel.current?.focus(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : "操作面板"} tabIndex={-1} className="relative w-full max-w-lg rounded-t-2xl bg-white p-4 pb-safe shadow-xl sm:rounded-2xl sm:pb-4">
        <div className="mb-3 flex items-center justify-between">
          {title ? <h3 id={titleId} className="text-sm font-semibold text-slate-800">{title}</h3> : <span />}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-100"
          >
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'disabled:opacity-50',
        checked ? 'bg-indigo-600' : 'bg-slate-300',
      )}
    >
      <span
        className={cx(
          'inline-block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1',
        )}
      />
    </button>
  );
}

// ───────────────────────── 容器 ─────────────────────────

export function Card({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cx(
        'rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5',
        onClick && 'cursor-pointer active:bg-slate-50',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-1 pb-2 pt-4">
      <h2 className="flex items-baseline gap-1.5 text-sm font-semibold text-slate-700">
        {children}
        {typeof count === 'number' && count > 0 && (
          <span className="text-xs font-normal text-slate-400">{count}</span>
        )}
      </h2>
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl bg-white/60 px-6 py-14 text-center ring-1 ring-slate-900/5">
      {icon && <div className="mb-3 text-slate-300">{icon}</div>}
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {description && <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700 ring-1 ring-rose-200">
      {message}
    </div>
  );
}

export function Chip({
  children,
  tone = 'slate',
  className,
}: {
  children: ReactNode;
  tone?: 'slate' | 'indigo' | 'emerald' | 'amber' | 'rose';
  className?: string;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    indigo: 'bg-indigo-50 text-indigo-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ───────────────────────── 进度环 ─────────────────────────

export type ProgressRingKind = 'progress' | 'done' | 'abnormal' | 'unknown';

/**
 * 进度环。
 * - 正常进度：环 + 百分比
 * - 已签收：满环 + ✓（100% 文字放不下时更好读）
 * - 异常/终止：玫瑰色空环 + 感叹号，避免显示成误导性的 0%
 * - 未知：虚线空环 + 省略号（手工件还没有物流信息）
 */
export function ProgressRing({
  value,
  kind = 'progress',
  size = 40,
  stroke = 4,
  className,
}: {
  value: number;
  kind?: ProgressRingKind;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = kind === 'done' ? 100 : kind === 'progress' ? clamped : 0;
  const offset = circumference * (1 - filled / 100);

  const color =
    kind === 'done'
      ? '#059669'
      : kind === 'abnormal'
        ? '#e11d48'
        : kind === 'unknown'
          ? '#cbd5e1'
          : clamped >= 60
            ? '#4f46e5'
            : '#818cf8';
  const textColor =
    kind === 'abnormal' ? 'text-rose-500' : kind === 'unknown' ? 'text-slate-400' : 'text-slate-600';
  const text = kind === 'done' ? '✓' : kind === 'abnormal' ? '!' : kind === 'unknown' ? '…' : `${clamped}%`;

  return (
    <div
      className={cx('relative shrink-0', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={
        kind === 'done'
          ? '已签收'
          : kind === 'abnormal'
            ? '物流异常'
            : kind === 'unknown'
              ? '物流信息待更新'
              : `运输进度 ${clamped}%`
      }
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={stroke}
          strokeDasharray={kind === 'unknown' ? `${stroke * 2.2} ${stroke * 1.6}` : undefined}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-500"
        />
      </svg>
      <span
        className={cx(
          'absolute inset-0 flex items-center justify-center font-semibold',
          textColor,
        )}
        style={{ fontSize: Math.max(9, size * 0.26) }}
      >
        {text}
      </span>
    </div>
  );
}

// ───────────────────────── 轻提示 ─────────────────────────

export function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'max-w-sm rounded-xl px-4 py-2 text-center text-xs font-medium text-white shadow-lg',
            t.tone === 'error' ? 'bg-rose-600' : t.tone === 'success' ? 'bg-emerald-600' : 'bg-slate-800',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
