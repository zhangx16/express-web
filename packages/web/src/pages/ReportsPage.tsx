import { useState } from 'react';
import { REPORT_REPEAT, type ReportDto, type ReportScheduleDto } from '@ea/shared';
import {
  useCreateSchedule,
  useDeleteSchedule,
  useGenerateReport,
  usePatchSchedule,
  useReports,
  useSchedules,
} from '../api/queries.js';
import { ApiClientError } from '../api/client.js';
import { cx } from '../lib/cx.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import Markdown from '../components/Markdown.js';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Input,
  PageLoader,
  Select,
  Sheet,
  Switch,
} from '../components/ui.js';

const REPEAT_LABELS: Record<number, string> = {
  [REPORT_REPEAT.ONCE]: '仅一次',
  [REPORT_REPEAT.DAILY]: '每天',
  [REPORT_REPEAT.WEEKDAYS]: '工作日',
  [REPORT_REPEAT.WEEKENDS]: '周末',
  [REPORT_REPEAT.CUSTOM]: '自定义',
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 日报页：生成日报 + 定时推送设置 */
export default function ReportsPage() {
  const reports = useReports();
  const schedules = useSchedules();
  const generate = useGenerateReport();
  const createSchedule = useCreateSchedule();
  const patchSchedule = usePatchSchedule();
  const deleteSchedule = useDeleteSchedule();

  const [selected, setSelected] = useState<ReportDto | null>(null);
  const [adding, setAdding] = useState(false);

  const [time, setTime] = useState('08:00');
  const [repeat, setRepeat] = useState<number>(REPORT_REPEAT.DAILY);
  const [weekdays, setWeekdays] = useState(0);

  const doGenerate = (): void => {
    generate.mutate(undefined, {
      onSuccess: (res) => {
        toast(res.delivered ? '日报已生成并推送' : '日报已生成', 'success');
        setSelected(res.report);
      },
      onError: (err) => {
        if (err instanceof ApiClientError && err.status === 409) {
          toast('当前没有在途包裹', 'info');
          return;
        }
        toast(err instanceof Error ? err.message : '生成失败', 'error');
      },
    });
  };

  const submitSchedule = (): void => {
    createSchedule.mutate(
      { time, repeat, weekdays: repeat === REPORT_REPEAT.CUSTOM ? weekdays : 0, enabled: true },
      {
        onSuccess: () => {
          toast('已添加定时日报', 'success');
          setAdding(false);
          setWeekdays(0);
        },
        onError: (err) => toast(err instanceof Error ? err.message : '添加失败', 'error'),
      },
    );
  };

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 flex items-center justify-between bg-slate-100/90 px-4 pb-2 pt-4 backdrop-blur">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">快递日报</h1>
          <p className="mt-0.5 text-[11px] text-slate-400">每日在途包裹小结</p>
        </div>
        <Button size="sm" loading={generate.isPending} onClick={doGenerate}>
          生成日报
        </Button>
      </header>

      <div className="px-4 pb-6">
        <ScheduleSection
          schedules={schedules.data?.schedules ?? []}
          loading={schedules.isPending}
          onAdd={() => setAdding(true)}
          onToggle={(s, enabled) =>
            patchSchedule.mutate(
              { id: s.id, patch: { enabled } },
              {
                onSuccess: () => toast(enabled ? '已启用' : '已停用', 'success'),
                onError: () => toast('操作失败', 'error'),
              },
            )
          }
          onDelete={(s) =>
            deleteSchedule.mutate(s.id, {
              onSuccess: () => toast('已删除', 'success'),
              onError: () => toast('删除失败', 'error'),
            })
          }
        />

        <h2 className="px-1 pb-2 pt-5 text-sm font-semibold text-slate-700">历史日报</h2>

        {reports.isPending ? (
          <PageLoader />
        ) : reports.isError ? (
          <ErrorBanner message="日报加载失败，请稍后重试" />
        ) : reports.data.reports.length === 0 ? (
          <EmptyState
            title="还没有日报"
            description="点右上角「生成日报」立即生成，或在上面添加定时任务"
          />
        ) : (
          <div className="space-y-2">
            {reports.data.reports.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelected(r)}
                className="block w-full rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-900/5 active:bg-slate-50"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-slate-800">{r.date}</span>
                  <span className="text-[11px] text-slate-400">{formatRelative(r.createdAt)}</span>
                </div>
                <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-slate-600">
                  {stripMarkdown(r.content).slice(0, 160)}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {r.delivered ? (
                    <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                      已推送
                    </span>
                  ) : (
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
                      未推送
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 日报详情 */}
      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={selected?.date}>
        {selected && (
          <>
            <p className="mb-2 text-[11px] text-slate-400">
              生成于 {formatDateTime(selected.createdAt)}
              {selected.delivered ? ' · 已推送 Telegram' : ''}
            </p>
            <div className="max-h-[60vh] overflow-y-auto rounded-xl bg-slate-50 p-3 text-[13px] text-slate-700">
              <Markdown text={selected.content} />
            </div>
            <Button
              variant="secondary"
              block
              className="mt-3"
              onClick={() => {
                void navigator.clipboard
                  .writeText(selected.content)
                  .then(() => toast('已复制', 'success'))
                  .catch(() => toast('复制失败', 'error'));
              }}
            >
              复制全文
            </Button>
          </>
        )}
      </Sheet>

      {/* 新增定时任务 */}
      <Sheet open={adding} onClose={() => setAdding(false)} title="添加定时日报">
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">发送时间（{timezoneLabel()}）</p>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">重复</p>
            <Select value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
              {Object.entries(REPEAT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>

          {repeat === REPORT_REPEAT.CUSTOM && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-slate-500">星期</p>
              <div className="flex gap-1.5">
                {WEEKDAYS.map((label, idx) => {
                  const bit = 1 << idx;
                  const active = (weekdays & bit) !== 0;
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setWeekdays((v) => v ^ bit)}
                      className={cx(
                        'size-9 rounded-lg text-xs font-medium',
                        active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600',
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              {weekdays === 0 && (
                <p className="mt-1 text-[11px] text-rose-500">自定义模式至少要选一天</p>
              )}
            </div>
          )}

          <Button
            block
            loading={createSchedule.isPending}
            disabled={repeat === REPORT_REPEAT.CUSTOM && weekdays === 0}
            onClick={submitSchedule}
          >
            保存
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function ScheduleSection({
  schedules,
  loading,
  onAdd,
  onToggle,
  onDelete,
}: {
  schedules: ReportScheduleDto[];
  loading: boolean;
  onAdd: () => void;
  onToggle: (s: ReportScheduleDto, enabled: boolean) => void;
  onDelete: (s: ReportScheduleDto) => void;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800">定时推送</h2>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
        >
          + 添加
        </button>
      </div>

      {loading ? (
        <div className="py-4">
          <PageLoader />
        </div>
      ) : schedules.length === 0 ? (
        <p className="py-2 text-xs leading-relaxed text-slate-400">
          还没有定时任务。添加后每天到点会自动同步、生成日报并推送到 Telegram。
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">
                  {s.time}
                  <span className="ml-2 text-[11px] font-normal text-slate-400">
                    {repeatLabel(s)}
                  </span>
                </p>
                {s.lastRunAt && (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    上次运行 {formatRelative(s.lastRunAt)}
                  </p>
                )}
              </div>
              <Switch checked={s.enabled} onChange={(v) => onToggle(s, v)} label="启用" />
              <button
                type="button"
                onClick={() => onDelete(s)}
                aria-label="删除"
                className="rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
              >
                <svg viewBox="0 0 24 24" fill="none" className="size-4" aria-hidden="true">
                  <path
                    d="M5 7h14M9.5 7V5h5v2M7 7l1 12h8l1-12"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function repeatLabel(s: ReportScheduleDto): string {
  if (s.repeat !== REPORT_REPEAT.CUSTOM) return REPEAT_LABELS[s.repeat] ?? '未知';
  const days = WEEKDAYS.filter((_, idx) => (s.weekdays & (1 << idx)) !== 0);
  return days.length > 0 ? `每周${days.join('、')}` : '自定义';
}

function timezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时间';
  } catch {
    return '本地时间';
  }
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
