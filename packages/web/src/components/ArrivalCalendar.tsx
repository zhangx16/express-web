import { useMemo, useState } from 'react';
import { arrivalDateOf, calendarDateKey, calendarMonthCells, shiftCalendarMonth, type ExpressItem } from '@ea/shared';
import { useSettings } from '../api/queries.js';
import { cx } from '../lib/cx.js';
import ItemCard from './ItemCard.js';
import { Button, EmptyState, Sheet } from './ui.js';

export default function ArrivalCalendar({ open, onClose, items }: { open: boolean; onClose: () => void; items: ExpressItem[] }) {
  const settings = useSettings();
  const timezone = settings.data?.timezone ?? 'Asia/Shanghai';
  const today = calendarDateKey(new Date(), timezone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const dates = useMemo(() => {
    const map = new Map<string, ExpressItem[]>();
    for (const item of items) {
      const date = arrivalDateOf(item, new Date(), timezone);
      if (date) map.set(date, [...(map.get(date) ?? []), item]);
    }
    return map;
  }, [items, timezone]);
  const changeMonth = (offset: number) => {
    const next = shiftCalendarMonth(month, offset);
    setMonth(next);
    setSelected(`${next}-01`);
  };
  const arrivals = dates.get(selected) ?? [];
  return (
    <Sheet open={open} onClose={onClose} title="到达日历">
      <div className="max-h-[75dvh] space-y-3 overflow-y-auto px-0.5 pb-4">
        <p className="text-xs text-slate-500">按当前筛选显示在途包裹的预计到达日期，实际时间以物流更新为准。</p>
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" aria-label="上个月" onClick={() => changeMonth(-1)}>‹</Button>
          <strong className="text-sm text-slate-800">{month.replace('-', '年')}月</strong>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>今天</Button>
            <Button variant="ghost" size="sm" aria-label="下个月" onClick={() => changeMonth(1)}>›</Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day} className="py-1 text-[11px] text-slate-400">{day}</span>)}
          {calendarMonthCells(month).map((date, i) => date ? (
            <button key={date} type="button" onClick={() => setSelected(date)} aria-pressed={selected === date}
              aria-label={`${date}${date === today ? ' 今天' : ''}，${dates.get(date)?.length ?? 0}件预计到达`}
              className={cx('flex h-12 flex-col items-center justify-center rounded-xl text-xs transition-colors', selected === date ? 'bg-indigo-600 text-white' : date === today ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-100')}>
              <span>{Number(date.slice(-2))}</span>
              <span className="h-3 text-[9px]">{dates.has(date) ? `${dates.get(date)!.length}件` : ''}</span>
            </button>
          ) : <span key={`empty-${i}`} />)}
        </div>
        <div className="border-t border-slate-100 pt-3">
          <h3 className="mb-2 text-xs font-semibold text-slate-700">{selected} · 预计到达 {arrivals.length} 件</h3>
          <div className="space-y-2">
            {arrivals.map((item) => <ItemCard key={item.mailNo} item={item} />)}
            {arrivals.length === 0 && <EmptyState title="当天没有预计到达的包裹" description="暂无到达时间的包裹仍可在列表中查看" />}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
