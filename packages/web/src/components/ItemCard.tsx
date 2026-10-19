import PickupInfo from './PickupInfo.js';
import { useNavigate } from 'react-router-dom';
import {
  CHANNEL_NAMES,
  isTransport,
  progressView,
  pickupCodeFrom,
  stateLabel,
  type ExpressItem,
} from '@ea/shared';
import { usePatchItem } from '../api/queries.js';
import { cx } from '../lib/cx.js';
import { formatTime, shortMailNo } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { Chip, ProgressRing } from './ui.js';

const SOURCE_TONE = {
  jd: 'rose',
  taobao: 'amber',
  pdd: 'emerald',
  manual: 'slate',
} as const;

export default function ItemCard({ item }: { item: ExpressItem }) {
  const navigate = useNavigate();
  const patch = usePatchItem();

  // 进度环只反映真实物流状态：手动拖进「已签收」分区不会伪造 100%
  const view = progressView(item);
  const done = view.kind === 'done';
  const label = stateLabel(item);
  const pickupCode = item.pickupCode || pickupCodeFrom(item.latestText);

  const toggleTracked = (e: React.MouseEvent): void => {
    e.stopPropagation();
    patch.mutate(
      { mailNo: item.mailNo, patch: { tracked: !item.tracked } },
      {
        onSuccess: () => toast(item.tracked ? '已关闭追踪' : '已开启追踪', 'success'),
        onError: () => toast('操作失败，请重试', 'error'),
      },
    );
  };

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/item/${encodeURIComponent(item.mailNo)}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') navigate(`/item/${encodeURIComponent(item.mailNo)}`);
      }}
      className="rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-slate-900/5 transition-colors active:bg-slate-50"
    >
      <div className="flex items-start gap-3">
        {/* 进度环 */}
        <ProgressRing value={view.value} kind={view.kind} size={44} stroke={4} className="mt-0.5" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-800">
              {item.companyName || label}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-slate-400">
              ·{shortMailNo(item.mailNo)}
            </span>
            {view.kind === 'abnormal' && (
              <Chip tone="rose" className="ml-auto shrink-0">
                异常
              </Chip>
            )}
            {view.kind === 'unknown' && (
              <Chip tone="slate" className="ml-auto shrink-0">
                待更新
              </Chip>
            )}
            {item.tracked && (
              <Chip tone="indigo" className={cx('shrink-0', view.kind === 'progress' && 'ml-auto')}>
                追踪中
              </Chip>
            )}
          </div>

          {item.originalName && (
            <p className="mt-0.5 truncate text-[11px] text-slate-400">{item.originalName}</p>
          )}

          <p
            className={cx(
              'mt-1 line-clamp-2 text-[13px] leading-snug',
              done ? 'text-slate-400' : 'text-slate-700',
            )}
          >
            {item.latestText || label}
          </p>

          <PickupInfo item={item} />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {pickupCode && (
              <Chip tone="amber">
                取件码 <span className="font-mono">{pickupCode}</span>
              </Chip>
            )}
            <Chip tone={SOURCE_TONE[item.source]}>{CHANNEL_NAMES[item.source]}</Chip>
            {item.accountLabel && (
              <span className="truncate text-[11px] text-slate-400">{item.accountLabel}</span>
            )}
            <span className="ml-auto shrink-0 text-[11px] text-slate-400">
              {formatTime(item.latestTime)}
            </span>
          </div>
        </div>
      </div>

      {isTransport(item) && (
        <div className="mt-2.5 flex items-center justify-end border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={toggleTracked}
            disabled={patch.isPending}
            className={cx(
              'flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors',
              item.tracked
                ? 'bg-indigo-50 text-indigo-600'
                : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600',
            )}
          >
            <span
              className={cx(
                'inline-block size-1.5 rounded-full',
                item.tracked ? 'bg-indigo-500' : 'bg-slate-300',
              )}
            />
            {item.tracked ? '追踪提醒已开启' : '开启追踪提醒'}
          </button>
        </div>
      )}
    </div>
  );
}
