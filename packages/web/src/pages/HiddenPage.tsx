import { useNavigate } from 'react-router-dom';
import { CHANNEL_NAMES } from '@ea/shared';
import { useHiddenItems, useRestoreItem } from '../api/queries.js';
import { formatRelative, shortMailNo } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { Button, EmptyState, ErrorBanner, PageLoader } from '../components/ui.js';

/** 已隐藏包裹：恢复或查看 */
export default function HiddenPage() {
  const navigate = useNavigate();
  const hidden = useHiddenItems();
  const restore = useRestoreItem();

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 flex items-center gap-2 bg-slate-100/90 px-2 pb-2 pt-2 pt-safe backdrop-blur">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          aria-label="返回"
          className="flex size-9 items-center justify-center rounded-full text-slate-600 hover:bg-slate-200/60"
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
        <h1 className="flex-1 text-sm font-semibold text-slate-800">已隐藏的包裹</h1>
      </header>

      <div className="px-4 pb-6 pt-2">
        {hidden.isPending ? (
          <PageLoader />
        ) : hidden.isError ? (
          <ErrorBanner message="加载失败，请稍后重试" />
        ) : hidden.data.items.length === 0 ? (
          <EmptyState
            title="没有隐藏的包裹"
            description="在包裹详情页点「隐藏」后，可以在这里恢复"
          />
        ) : (
          <div className="space-y-2">
            {hidden.data.items.map((entry) => {
              const item = entry.item;
              return (
                <div
                  key={entry.mailNo}
                  className="rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-slate-900/5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800">
                        {item?.companyName || item?.stateName || '包裹'}
                        <span className="ml-1 font-mono text-[11px] font-normal text-slate-400">
                          ·{shortMailNo(entry.mailNo)}
                        </span>
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-slate-500">
                        {item?.latestText || entry.mailNo}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        {item ? `${CHANNEL_NAMES[item.source]} · ` : ''}
                        {formatRelative(entry.hiddenAt)}隐藏
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={restore.isPending && restore.variables === entry.mailNo}
                      onClick={() =>
                        restore.mutate(entry.mailNo, {
                          onSuccess: () => toast('已恢复', 'success'),
                          onError: () => toast('恢复失败', 'error'),
                        })
                      }
                    >
                      恢复
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
