import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  CHANNEL_NAMES,
  SECTION_ORDER,
  SECTION_TITLES,
  isTransport,
  parseJumpLinks,
  progressView,
  pickupCodeFromParts,
  progressViewOf,
  sectionKeyOf,
  stateLabel,
  type SectionKey,
} from '@ea/shared';
import {
  useAddresses,
  useHideItem,
  useItem,
  useItems,
  useLinks,
  usePatchItem,
  useRefreshItem,
  useResolveGoods,
  useTrace,
} from '../api/queries.js';
import { cx } from '../lib/cx.js';
import PickupInfo from '../components/PickupInfo.js';
import { CarrierFields } from '../components/CarrierFields.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import {
  Button,
  Chip,
  EmptyState,
  ErrorBanner,
  Input,
  PageLoader,
  ProgressRing,
  Select,
  Sheet,
  Switch,
} from '../components/ui.js';

const SOURCE_TONE = {
  jd: 'rose',
  taobao: 'amber',
  pdd: 'emerald',
  manual: 'slate',
} as const;

/** 详情页：商品、进度、轨迹时间线、操作面板 */
export default function ItemPage() {
  const { mailNo = '' } = useParams();
  const navigate = useNavigate();

  const item = useItem(mailNo);
  const list = useItems({});
  const trace = useTrace(mailNo);
  const links = useLinks(mailNo);
  const addresses = useAddresses();
  const refresh = useRefreshItem();
  const patch = usePatchItem();
  const hide = useHideItem();
  const resolveGoods = useResolveGoods();

  const [editing, setEditing] = useState(false);
  const [carrierCompany, setCarrierCompany] = useState<string | null>(null);
  const [carrierPhone, setCarrierPhone] = useState<string | null>(null);
  const [confirmHide, setConfirmHide] = useState(false);
  const [cabinetDraft, setCabinetDraft] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState<string | null>(null);

  // 详情接口只返回 ExpressDetail，tracked/override 等字段从列表缓存取
  const fromList = useMemo(
    () => list.data?.items.find((x) => x.mailNo === mailNo),
    [list.data, mailNo],
  );

  const data = item.data;
  const express = data?.detail;

  const jumpLinks = useMemo(
    () => parseJumpLinks(fromList?.jumpLinks ?? ''),
    [fromList?.jumpLinks],
  );

  if (item.isPending) {
    return (
      <div className="min-h-full bg-slate-100">
        <TopBar onBack={() => navigate(-1)} title="包裹详情" />
        <PageLoader />
      </div>
    );
  }

  if (item.isError || !data) {
    return (
      <div className="min-h-full bg-slate-100">
        <TopBar onBack={() => navigate(-1)} title="包裹详情" />
        <div className="px-4 pt-4">
          <ErrorBanner message="包裹不存在或已被隐藏" />
        </div>
      </div>
    );
  }

  const tracked = fromList?.tracked ?? false;
  const section: SectionKey = fromList ? sectionKeyOf(fromList) : 'shipped';
  // 列表缓存缺失时（直接打开链接、列表还在加载）用详情接口自带的状态，
  // 否则进度环会错误地显示 0%。
  const view = fromList
    ? progressView(fromList)
    : progressViewOf(express?.state ?? -1, express?.stateNum ?? 0);
  const done = view.kind === 'done';
  const company = data.detail.companyName || fromList?.companyName || '快递';
  const label = fromList ? stateLabel(fromList) : '';
  const pickupCode = fromList?.pickupCode || pickupCodeFromParts([fromList?.latestText, ...[...(trace.data?.points ?? express?.data ?? [])].reverse().map(p => p.context)]) || '';

  const doRefresh = (): void => {
    refresh.mutate(mailNo, {
      onSuccess: () => toast('已刷新最新轨迹', 'success'),
      onError: (err) => toast(err instanceof Error ? err.message : '刷新失败，请稍后重试', 'error'),
    });
  };

  const doPatch = (
    next: Parameters<typeof patch.mutate>[0]['patch'],
    successText: string,
  ): void => {
    patch.mutate(
      { mailNo, patch: next },
      {
        onSuccess: () => toast(successText, 'success'),
        onError: () => toast('操作失败，请重试', 'error'),
      },
    );
  };

  return (
    <div className="min-h-full bg-slate-100 pb-8">
      <TopBar
        onBack={() => navigate(-1)}
        title="包裹详情"
        onRefresh={doRefresh}
        refreshing={refresh.isPending}
      />

      <div className="space-y-3 px-4 pt-3">
        {/* 商品 + 进度 */}
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
          <div className="flex items-start gap-3">
            <ProgressRing value={view.value} kind={view.kind} size={56} stroke={5} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={fromList ? SOURCE_TONE[fromList.source] : 'slate'}>
                  {fromList ? CHANNEL_NAMES[fromList.source] : company}
                </Chip>
                {fromList?.accountLabel && (
                  <span className="truncate text-[11px] text-slate-400">{fromList.accountLabel}</span>
                )}
                {done && <Chip tone="emerald">已签收</Chip>}
                {view.kind === 'abnormal' && <Chip tone="rose">异常 / 已终止</Chip>}
                {view.kind === 'unknown' && <Chip tone="slate">状态待更新</Chip>}
              </div>
              <p className="mt-1.5 text-sm font-semibold text-slate-900">
                {data.goods?.shortName || data.goods?.name || fromList?.originalName || label || '包裹'}
              </p>
              {data.goods?.count && (
                <p className="mt-0.5 text-[11px] text-slate-400">数量 {data.goods.count}</p>
              )}
            </div>
            {data.goods?.imageUrl && (
              <img
                src={data.goods.imageUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="size-16 shrink-0 rounded-xl object-cover ring-1 ring-slate-900/5"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            )}
          </div>

          {!data.goods && (fromList?.source === 'jd' || fromList?.source === 'taobao') && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              loading={resolveGoods.isPending}
              onClick={() =>
                resolveGoods.mutate(mailNo, {
                  onSuccess: (res) =>
                    toast(
                      res.goods ? '已获取商品信息' : '未找到商品信息',
                      res.goods ? 'success' : 'info',
                    ),
                  onError: (err) => toast(err instanceof Error ? err.message : '获取失败', 'error'),
                })
              }
            >
              获取商品信息
            </Button>
          )}

          {fromList && <PickupInfo item={fromList} texts={[...(trace.data?.points ?? express?.data ?? [])].reverse().map(p => p.context)} />}
          <div className="mt-3 border-t border-slate-100 pt-3">
            <p className="text-sm leading-relaxed text-slate-700">
              {fromList?.latestText || express?.data[0]?.context || label}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
              <span>{fromList?.latestTime ? formatDateTime(fromList.latestTime) : ''}</span>
              {(express?.eta || fromList?.eta) && <span>预计 {express?.eta || fromList?.eta}</span>}
              {pickupCode && (
                <Chip tone="amber">
                  取件码 <span className="font-mono">{pickupCode}</span>
                </Chip>
              )}
            </div>
          </div>
        </div>

        {/* 快捷操作 */}
        <div className="grid grid-cols-4 gap-2">
          <QuickAction
            label={tracked ? '追踪中' : '追踪'}
            active={tracked}
            disabled={!fromList || !isTransport(fromList) || patch.isPending}
            onClick={() => doPatch({ tracked: !tracked }, tracked ? '已关闭追踪' : '已开启追踪')}
            icon={<BellIcon />}
          />
          <QuickAction label="改分区" onClick={() => setEditing(true)} icon={<FolderIcon />} />
          <QuickAction
            label="复制单号"
            onClick={() => {
              void navigator.clipboard
                .writeText(mailNo)
                .then(() => toast('单号已复制', 'success'))
                .catch(() => toast('复制失败', 'error'));
            }}
            icon={<CopyIcon />}
          />
          <QuickAction label="隐藏" danger onClick={() => setConfirmHide(true)} icon={<EyeOffIcon />} />
        </div>

        {/* 轨迹 */}
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">物流轨迹</h2>
            {trace.data?.cached && trace.data.fetchedAt && (
              <span className="text-[11px] text-slate-400">
                {formatRelative(trace.data.fetchedAt)}缓存
              </span>
            )}
          </div>

          {trace.data?.stale && (
            <div className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
              最新轨迹暂时无法获取，以下为上次保存的记录。{trace.data.refreshError}
            </div>
          )}
          {trace.isPending ? (
            <div className="py-6">
              <PageLoader />
            </div>
          ) : trace.isError ? (
            <div className="space-y-2">
              <ErrorBanner message={trace.error instanceof Error ? trace.error.message : '轨迹获取失败，可稍后刷新重试'} />
              <Button variant="secondary" size="sm" onClick={doRefresh} loading={refresh.isPending}>
                重新获取
              </Button>
            </div>
          ) : trace.data.points.length === 0 ? (
            <EmptyState title="暂无轨迹" description="快递公司可能还没更新物流信息" />
          ) : (
            <ol className="relative ml-1 border-l border-slate-200 pl-4">
              {trace.data.points.toReversed().map((p, idx) => (
                <li key={`${p.time}-${idx}`} className="relative pb-4 last:pb-0">
                  <span
                    className={cx(
                      'absolute -left-[21px] top-1 size-2.5 rounded-full ring-4 ring-white',
                      idx === 0 ? 'bg-indigo-500' : 'bg-slate-300',
                    )}
                  />
                  <p
                    className={cx(
                      'text-[13px] leading-snug',
                      idx === 0 ? 'font-medium text-slate-900' : 'text-slate-600',
                    )}
                  >
                    {p.context}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{p.formattedTime || p.time}</p>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* 元信息 */}
        <div className="rounded-2xl bg-white p-4 text-[13px] shadow-sm ring-1 ring-slate-900/5">
          <MetaRow label="快递公司" value={company} />
          <MetaRow label="运单号" value={mailNo} mono />
          <MetaRow label="来源" value={fromList ? CHANNEL_NAMES[fromList.source] : '—'} />
          {fromList?.accountLabel && <MetaRow label="账号" value={fromList.accountLabel} />}
          {fromList?.originalName && <MetaRow label="备注名称" value={fromList.originalName} />}
          <MetaRow label="状态" value={label || '—'} />
        </div>

        {/* 跳转平台 */}
        {(links.data?.links.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2">
            {links.data?.links.map((l) => (
              <a
                key={l.link}
                href={l.link}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl bg-white px-3 py-2 text-xs font-medium text-indigo-600 shadow-sm ring-1 ring-slate-900/5"
              >
                {l.type || '去平台查看'} ↗
              </a>
            ))}
          </div>
        )}

        {jumpLinks.length > 0 && (links.data?.links.length ?? 0) === 0 && (
          <div className="flex flex-wrap gap-2">
            {jumpLinks.map((l) => (
              <a
                key={l.link}
                href={l.link}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl bg-white px-3 py-2 text-xs font-medium text-indigo-600 shadow-sm ring-1 ring-slate-900/5"
              >
                {l.type || '去平台查看'} ↗
              </a>
            ))}
          </div>
        )}
      </div>

      {/* 改分区 / 追踪开关 / 地址 / 备注 */}
      <Sheet open={editing} onClose={() => { setEditing(false); setCarrierCompany(null); setCarrierPhone(null); }} title="编辑包裹">
        <div className="space-y-4">
          {(fromList?.source === 'manual' || fromList?.source === 'pdd') && <div className="space-y-3">
            <CarrierFields company={carrierCompany ?? fromList.companyName} phone={carrierPhone ?? fromList.phone ?? ''} onCompany={setCarrierCompany} onPhone={setCarrierPhone} />
            <Button loading={patch.isPending} onClick={() => {
              doPatch({ companyName: carrierCompany ?? fromList.companyName, companyCode: '', phone: carrierPhone ?? fromList.phone ?? '' }, '查件资料已保存，请刷新轨迹');
            }}>保存查件资料</Button>
          </div>}
          {fromList && <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500">丰巢取件信息（可手动补填）</p>
            <Input aria-label="丰巢柜号或柜机位置" maxLength={160} placeholder="例如：丰巢A区3号柜" value={cabinetDraft ?? fromList.pickupCabinet ?? ''} onChange={e => setCabinetDraft(e.target.value)} />
            <Input aria-label="取件码" maxLength={32} autoComplete="off" placeholder="取件码" value={codeDraft ?? fromList.pickupCode ?? ''} onChange={e => setCodeDraft(e.target.value)} />
            <Button loading={patch.isPending} onClick={() => doPatch({ pickupCabinet: cabinetDraft ?? fromList.pickupCabinet ?? '', pickupCode: codeDraft ?? fromList.pickupCode ?? '' }, '取件信息已保存')}>保存取件信息</Button>
          </div>}
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-500">手动分区</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  doPatch({ partitionOverride: '' }, '已恢复自动分区');
                  setEditing(false);
                }}
                className={cx(
                  'rounded-lg px-2.5 py-1.5 text-xs font-medium',
                  fromList?.partitionOverride
                    ? 'bg-slate-100 text-slate-500'
                    : 'bg-slate-900 text-white',
                )}
              >
                自动（{SECTION_TITLES[section] ?? '—'}）
              </button>
              {SECTION_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    doPatch({ partitionOverride: s }, `已移到「${SECTION_TITLES[s]}」`);
                    setEditing(false);
                  }}
                  className={cx(
                    'rounded-lg px-2.5 py-1.5 text-xs font-medium',
                    fromList?.partitionOverride === s
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-100 text-slate-600',
                  )}
                >
                  {SECTION_TITLES[s]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 pt-3">
            <div>
              <p className="text-sm text-slate-800">追踪提醒</p>
              <p className="text-[11px] text-slate-400">物流有新动态时推送通知</p>
            </div>
            <Switch
              checked={tracked}
              disabled={!fromList || patch.isPending}
              onChange={(next) => doPatch({ tracked: next }, next ? '已开启追踪' : '已关闭追踪')}
            />
          </div>

          <div className="border-t border-slate-100 pt-3">
            <p className="mb-1.5 text-xs font-medium text-slate-500">关联收货地址</p>
            <Select
              value={fromList?.addressId ?? ''}
              onChange={(e) => doPatch({ addressId: e.target.value }, '地址已更新')}
            >
              <option value="">未关联</option>
              {addresses.data?.addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.active ? '（默认）' : ''}
                </option>
              ))}
            </Select>
          </div>

          <div className="border-t border-slate-100 pt-3">
            <p className="mb-1.5 text-xs font-medium text-slate-500">备注名称</p>
            <Input
              defaultValue={fromList?.originalName ?? ''}
              placeholder="例如：生日礼物"
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value === (fromList?.originalName ?? '')) return;
                doPatch({ originalName: value }, '备注已保存');
              }}
            />
          </div>
        </div>
      </Sheet>

      <Sheet open={confirmHide} onClose={() => setConfirmHide(false)} title="隐藏包裹">
        <p className="text-sm leading-relaxed text-slate-600">
          隐藏后该包裹不再出现在列表与同步结果中，可在「设置 → 已隐藏」里恢复。
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" block onClick={() => setConfirmHide(false)}>
            取消
          </Button>
          <Button
            variant="danger"
            block
            loading={hide.isPending}
            onClick={() =>
              hide.mutate(mailNo, {
                onSuccess: () => {
                  toast('已隐藏', 'success');
                  navigate('/', { replace: true });
                },
                onError: () => toast('隐藏失败', 'error'),
              })
            }
          >
            确认隐藏
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function TopBar({
  onBack,
  title,
  onRefresh,
  refreshing,
}: {
  onBack: () => void;
  title: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200/60 bg-slate-100/90 px-2 py-2 pt-safe backdrop-blur">
      <button
        type="button"
        onClick={onBack}
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
      <h1 className="flex-1 text-sm font-semibold text-slate-800">{title}</h1>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="刷新"
          className="flex size-9 items-center justify-center rounded-full text-slate-600 hover:bg-slate-200/60 disabled:text-slate-300"
        >
          {refreshing ? (
            <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      )}
    </header>
  );
}

function QuickAction({
  label,
  icon,
  onClick,
  active,
  danger,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'flex flex-col items-center gap-1 rounded-2xl bg-white py-3 text-[11px] font-medium shadow-sm ring-1 ring-slate-900/5',
        'disabled:opacity-40',
        active ? 'text-indigo-600' : danger ? 'text-rose-500' : 'text-slate-600',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 py-2 first:pt-0 last:border-0 last:pb-0">
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className={cx('text-right text-slate-700', mono && 'font-mono text-xs')}>{value}</span>
    </div>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
      <path
        d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5ZM10 18a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
      <path
        d="M3.5 7.5h6l2 2h9v9h-17v-11Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
      <path
        d="M4 4l16 16M10.6 6.3A9.7 9.7 0 0 1 12 6.2c5 0 8.5 5.8 8.5 5.8a17 17 0 0 1-2.4 3M6.6 8.1A17 17 0 0 0 3.5 12s3.5 5.8 8.5 5.8a9 9 0 0 0 3.4-.7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
