import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ArrivalCalendar from '../components/ArrivalCalendar.js';
import AddItemSheet from '../components/AddItemSheet.js';
import {
  CHANNELS,
  CHANNEL_NAMES,
  SECTION_ORDER,
  SECTION_TITLES,
  sectionKeyOf,
  compareLogisticsUpdated,
  isTransport,
  type Channel,
  type ItemSource,
  type ExpressItem,
  type SectionKey,
} from '@ea/shared';
import { useItems, useStartSync, useSyncStatus } from '../api/queries.js';
import { cx } from '../lib/cx.js';
import { formatRelative } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import ItemCard from '../components/ItemCard.js';
import { Button, EmptyState, ErrorBanner, PageLoader, Spinner } from '../components/ui.js';

/** 首页：在途优先，完成/异常独立浏览，支持分页和到达日历。 */
export default function HomePage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sourceValue = params.get('source') ?? '';
  const source = [...CHANNELS, 'manual'].includes(sourceValue) ? sourceValue as ItemSource : '';
  const tracked = params.get('tracked') === '1';
  const view = ['active', 'done', 'abnormal', 'all'].includes(params.get('view') ?? '') ? params.get('view')! : 'active';
  const [calendar, setCalendar] = useState(false);
  const [adding, setAdding] = useState(false);
  const debouncedQ = useDebouncedValue(q.trim());
  const items = useItems({ q: debouncedQ, source, tracked });
  const syncStatus = useSyncStatus();
  const startSync = useStartSync();
  const running = (syncStatus.data?.running ?? false) || startSync.isPending;
  const updateFilter = (key: string, value: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      next.delete('page');
      return next;
    }, { replace: true });
  };
  const counts = items.data?.counts;
  const inTransit = items.data?.items.filter(isTransport).length ?? 0;
  const unconfirmed = items.data?.items.filter((item) => item.state < 0 && item.stateNum === 0).length ?? 0;
  const visible = useMemo(() => (items.data?.items ?? []).filter((item) => {
    const section = sectionKeyOf(item);
    if (view === 'active') return isTransport(item);
    return view === 'all' || section === view;
  }).sort((a, b) => view === 'active' ? compareLogisticsUpdated(a, b) : SECTION_ORDER.indexOf(sectionKeyOf(a)) - SECTION_ORDER.indexOf(sectionKeyOf(b)) || compareLogisticsUpdated(a, b)), [items.data, view]);
  const pages = Math.max(1, Math.ceil(visible.length / 12));
  const requestedPage = Number(params.get('page'));
  const page = Math.min(pages, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const grouped = useMemo(() => {
    const map: Record<SectionKey, ExpressItem[]> = { delivering: [], shipped: [], notshipped: [], done: [], abnormal: [] };
    for (const item of visible.slice((page - 1) * 12, page * 12)) map[sectionKeyOf(item)]?.push(item);
    return map;
  }, [visible, page]);
  const triggerSync = (): void => {
    if (running) return;
    startSync.mutate(undefined, { onError: (error) => toast(error instanceof Error ? error.message : '同步启动失败', 'error') });
  };
  const pull = usePullToRefresh(triggerSync, !running);
  const filtering = debouncedQ !== '' || source !== '' || tracked;
  const changePage = (nextPage: number) => {
    setParams((previous) => { const next = new URLSearchParams(previous); next.set('page', String(nextPage)); return next; }, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  return (
    <div className="min-h-full" onTouchStart={pull.onTouchStart} onTouchMove={pull.onTouchMove} onTouchEnd={pull.onTouchEnd} onTouchCancel={pull.onTouchCancel}>
      <div className="flex items-center justify-center overflow-hidden text-[11px] text-slate-400 transition-[height] duration-150" style={{ height: pull.offset }}>
        <span>{pull.offset >= 56 ? '松开立即同步' : '下拉同步'}</span>
      </div>
      <header className="sticky top-0 z-30 bg-slate-100/95 px-4 pb-3 pt-4 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">我的包裹</h1>
            <p className="mt-0.5 text-[11px] text-slate-400">{items.data?.syncedAt ? `更新于 ${formatRelative(items.data.syncedAt)}` : '尚未同步'} · 在途 {inTransit} 件</p>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setCalendar(true)}>日历</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>添加</Button>
            <button type="button" onClick={triggerSync} disabled={running} aria-label="同步" className="flex size-8 items-center justify-center rounded-full bg-white text-indigo-600 shadow-sm disabled:text-slate-300">
              {running ? <Spinner className="size-4" /> : <RefreshIcon />}
            </button>
          </div>
        </div>
        <div className="relative mt-3">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input aria-label="搜索包裹" value={q} maxLength={100} onChange={(event) => updateFilter('q', event.target.value)} placeholder="搜索单号、快递公司、商品" className="h-9 w-full rounded-xl border-0 bg-white pl-9 pr-9 text-sm text-slate-900 ring-1 ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 focus:outline-none" />
          {q && <button type="button" onClick={() => updateFilter('q', '')} aria-label="清空搜索" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400"><CloseIcon /></button>}
        </div>
        <div className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-1">
          <FilterChip active={source === ''} onClick={() => updateFilter('source', '')}>全部渠道</FilterChip>
          {[...CHANNELS, 'manual' as const].map((channel) => <FilterChip key={channel} active={source === channel} onClick={() => updateFilter('source', channel)}>{CHANNEL_NAMES[channel]}</FilterChip>)}
          <FilterChip active={tracked} onClick={() => updateFilter('tracked', tracked ? '' : '1')}>只看追踪</FilterChip>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1 rounded-xl bg-slate-200/60 p-1" aria-label="包裹分区">
          {([
            ['active', '在途', inTransit], ['done', '已完成', counts?.done ?? 0],
            ['abnormal', '异常', counts?.abnormal ?? 0], ['all', '全部', items.data?.items.length ?? 0],
          ] as const).map(([key, label, count]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => updateFilter('view', key)} className={cx('rounded-lg px-1 py-2 text-xs transition-colors', view === key ? 'bg-white font-semibold text-indigo-700 shadow-sm' : 'text-slate-500')}>
            {label} <span className="text-[10px] opacity-70">{count}</span>
          </button>)}
        </div>
      </header>
      <div className="px-4 pb-6" aria-busy={items.isFetching}>
        {view === 'active' && unconfirmed > 0 && <button type="button" onClick={() => updateFilter('view', 'all')} className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-left text-xs text-amber-800">有 {unconfirmed} 条记录状态待确认，点击在“全部”中查看</button>}
        {q.trim() !== debouncedQ && <p role="status" className="pt-2 text-xs text-slate-400">正在搜索…</p>}
        {syncStatus.data?.lastError && !running && <div className="pt-3"><ErrorBanner message={`上次同步出错：${syncStatus.data.lastError}`} /></div>}
        {running && syncStatus.data && <SyncProgress channels={syncStatus.data.channels} />}
        {items.isPending ? <PageLoader /> : items.isError ? (
          <div className="space-y-3 pt-3"><ErrorBanner message="包裹列表加载失败，请稍后重试" /><Button variant="secondary" size="sm" onClick={() => void items.refetch()}>重新加载</Button></div>
        ) : visible.length === 0 ? (
          <div className="pt-4"><EmptyState icon={<BoxIcon className="size-12" />} title={filtering ? '没有符合条件的包裹' : view === 'active' ? '当前没有在途包裹' : '当前分区没有包裹'} description={filtering ? '换个关键词、渠道或追踪条件试试' : '可以添加包裹，或同步平台账号更新列表'} action={
            view === 'active' && (counts?.done ?? 0) > 0 ? <Button variant="secondary" onClick={() => updateFilter('view', 'done')}>查看已完成</Button> : <Button onClick={() => setAdding(true)}>添加包裹</Button>
          } /></div>
        ) : <>
          {view === 'active' ? <section>
            <h2 className="px-1 pb-2 pt-4 text-sm font-semibold text-slate-700">在途包裹 · 按物流更新时间排序</h2>
            <div className="space-y-2">{visible.slice((page - 1) * 12, page * 12).map(item => <ItemCard key={item.mailNo} item={item} />)}</div>
          </section> : SECTION_ORDER.map((section) => grouped[section].length > 0 && <section key={section}>
            <h2 className="px-1 pb-2 pt-4 text-sm font-semibold text-slate-700">{section === 'shipped' && grouped[section].every((item) => item.state < 0 && item.stateNum === 0) ? '状态待确认' : SECTION_TITLES[section]}</h2>
            <div className="space-y-2">{grouped[section].map((item) => <ItemCard key={item.mailNo} item={item} />)}</div>
          </section>)}
          {pages > 1 && <div className="mt-5 flex items-center justify-between gap-2" aria-label="包裹分页">
            <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => changePage(page - 1)}>上一页</Button>
            <span className="text-xs text-slate-500">{page} / {pages} 页 · {visible.length} 件</span>
            <Button variant="secondary" size="sm" disabled={page === pages} onClick={() => changePage(page + 1)}>下一页</Button>
          </div>}
        </>}
      </div>
      {calendar && <ArrivalCalendar open onClose={() => setCalendar(false)} items={items.data?.items ?? []} />}
      {adding && <AddItemSheet open onClose={() => setAdding(false)} />}
    </div>
  );
}

function useDebouncedValue(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), 250); return () => clearTimeout(timer); }, [value]);
  return debounced;
}

/** 同步中的逐渠道进度条 */
function SyncProgress({ channels }: { channels: Array<{ channel: Channel; state: string; count: number }> }) {
  return (
    <div className="mt-3 rounded-xl bg-white px-3 py-2.5 text-[11px] text-slate-500 shadow-sm ring-1 ring-slate-900/5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {channels.map((c) => (
          <span key={c.channel} className="flex items-center gap-1">
            <span
              className={cx(
                'inline-block size-1.5 rounded-full',
                c.state === 'ok'
                  ? 'bg-emerald-500'
                  : c.state === 'failed'
                    ? 'bg-rose-500'
                    : c.state === 'running'
                      ? 'bg-indigo-500 animate-pulse'
                      : 'bg-slate-300',
              )}
            />
            {CHANNEL_NAMES[c.channel]}
            {c.count > 0 && <span className="text-slate-400">{c.count}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-slate-900 text-white'
          : 'bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  );
}

/** 下拉刷新：仅在页面顶部时生效，松手超过阈值触发 */
function usePullToRefresh(onRefresh: () => void, enabled: boolean) {
  const startY = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);

  return {
    offset,
    onTouchCancel: (): void => { startY.current = null; setOffset(0); },
    onTouchStart: (e: React.TouchEvent): void => {
      startY.current = null;
      if (!enabled || window.scrollY > 0 || e.touches.length !== 1) return;
      startY.current = e.touches[0]?.clientY ?? null;
    },
    onTouchMove: (e: React.TouchEvent): void => {
      if (startY.current === null) return;
      const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
      if (dy <= 0 || window.scrollY > 0) {
        setOffset(0);
        return;
      }
      setOffset(Math.min(72, dy * 0.5));
    },
    onTouchEnd: (): void => {
      if (startY.current === null) return;
      const shouldRefresh = offset >= 56;
      startY.current = null;
      setOffset(0);
      if (shouldRefresh) onRefresh();
    },
  };
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
      <path
        d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-3.5" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function BoxIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z M3.5 8.5 12 13l8.5-4.5 M12 13v7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
