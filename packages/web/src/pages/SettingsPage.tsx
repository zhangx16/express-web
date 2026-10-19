import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CHANNELS,
  CHANNEL_NAMES,
  type AccountDto,
  type AccountStatus,
  type AddressDto,
  type Channel,
  type SecretState,
  type SettingsDto,
} from '@ea/shared';
import {
  useAccounts,
  useAddresses,
  useChangePassword,
  useCreateAddress,
  useCreateLoginSession,
  useDeleteAccount,
  useDeleteAddress,
  useDeleteSecret,
  useLocalApiToken,
  useLogout,
  useMe,
  usePatchAccount,
  usePatchAddress,
  usePatchSettings,
  useSetSecret,
  useSettings,
  useVerifyAccount,
  type SecretKind,
} from '../api/queries.js';
import { ApiClientError } from '../api/client.js';
import { cx } from '../lib/cx.js';
import { formatRelative } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import {
  Button,
  Card,
  Chip,
  ErrorBanner,
  Field,
  Input,
  PageLoader,
  Select,
  Sheet,
  Switch,
  Textarea,
} from '../components/ui.js';

const STATUS_LABEL: Record<AccountStatus, string> = {
  ok: '正常',
  needs_login: '需要重新登录',
  challenge: '风控验证',
  error: '异常',
  disabled: '已停用',
};

const STATUS_TONE: Record<AccountStatus, 'slate' | 'indigo' | 'emerald' | 'amber' | 'rose'> = {
  ok: 'emerald',
  needs_login: 'amber',
  challenge: 'rose',
  error: 'rose',
  disabled: 'slate',
};

interface FormState {
  kuaidi100Enabled: boolean;
  kuaidi100Customer: string;
  kuaidi100PollIntervalMin: string;
  syncIntervalMin: string;
  trackedPollIntervalMin: string;
  timezone: string;
  telegramEnabled: boolean;
  telegramChatId: string;
  webPushEnabled: boolean;
}

function fromDto(s: SettingsDto): FormState {
  return {
    kuaidi100Enabled: s.logistics.enabled,
    kuaidi100Customer: s.logistics.customer,
    kuaidi100PollIntervalMin: String(s.logistics.pollIntervalMin),
    syncIntervalMin: String(s.syncIntervalMin),
    trackedPollIntervalMin: String(s.trackedPollIntervalMin),
    timezone: s.timezone,
    telegramEnabled: s.notifications.telegram.enabled,
    telegramChatId: s.notifications.telegram.chatId ?? '',
    webPushEnabled: s.notifications.webPush.enabled,
  };
}

/** 设置页：账号 / 同步 / 通知 / 地址 / 安全 */
export default function SettingsPage() {
  const navigate = useNavigate();
  const me = useMe();
  const settings = useSettings();
  const patchSettings = usePatchSettings();
  const accounts = useAccounts();
  const addresses = useAddresses();
  const localApi = useLocalApiToken();
  const logout = useLogout();
  const setSecret = useSetSecret();
  const deleteSecret = useDeleteSecret();

  const [form, setForm] = useState<FormState | null>(null);

  const saveSecret = (kind: SecretKind, value: string): void => {
    setSecret.mutate(
      { kind, value },
      {
        onSuccess: () => toast('密钥已保存', 'success'),
        onError: (err) => toast(errorMessage(err, '保存失败'), 'error'),
      },
    );
  };

  const clearSecret = (kind: SecretKind): void => {
    deleteSecret.mutate(kind, {
      onSuccess: () => toast('密钥已清除', 'success'),
      onError: (err) => toast(errorMessage(err, '清除失败'), 'error'),
    });
  };

  // 首次加载后初始化草稿；之后的本地编辑不被后台刷新覆盖
  useEffect(() => {
    if (settings.data && form === null) setForm(fromDto(settings.data));
  }, [settings.data, form]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const saveSync = (): void => {
    if (!form) return;
    const sync = Number(form.syncIntervalMin);
    const tracked = Number(form.trackedPollIntervalMin);
    if (!Number.isInteger(sync) || sync < 0 || sync > 1440) {
      toast('同步间隔需为 0–1440 分钟', 'error');
      return;
    }
    if (!Number.isInteger(tracked) || tracked < 0 || tracked > 1440) {
      toast('追踪间隔需为 0–1440 分钟', 'error');
      return;
    }
    patchSettings.mutate(
      {
        syncIntervalMin: sync,
        trackedPollIntervalMin: tracked,
        timezone: form.timezone.trim() || 'Asia/Shanghai',
      },
      {
        onSuccess: (res) => {
          setForm(fromDto(res.settings));
          toast('同步设置已保存', 'success');
        },
        onError: (err) => toast(errorMessage(err, '保存失败'), 'error'),
      },
    );
  };

  const saveNotifications = (): void => {
    if (!form) return;
    patchSettings.mutate(
      {
        telegramEnabled: form.telegramEnabled,
        telegramChatId: form.telegramChatId.trim(),
        webPushEnabled: form.webPushEnabled,
      },
      {
        onSuccess: () => toast('通知设置已保存', 'success'),
        onError: (err) => toast(errorMessage(err, '保存失败'), 'error'),
      },
    );
  };

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 bg-slate-100/90 px-4 pb-2 pt-4 backdrop-blur">
        <h1 className="text-lg font-semibold text-slate-900">设置</h1>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {me.data?.user ? `已登录：${me.data.user.username}` : '单用户自托管'}
        </p>
      </header>

      <div className="space-y-4 px-4 pb-8">
        {/* ───────── 账号 ───────── */}
        <AccountSection
          accounts={accounts.data?.accounts ?? []}
          loading={accounts.isPending}
          error={accounts.isError}
        />

        {/* ───────── 同步 ───────── */}
        <Card className="p-4">
          <SectionHead title="同步" hint="周期同步与追踪轮询，0 表示关闭" />
          {settings.isPending || !form ? (
            <PageLoader />
          ) : settings.isError ? (
            <ErrorBanner message="设置加载失败，请下拉刷新页面重试" />
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="全量同步间隔（分钟）">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={1440}
                      value={form.syncIntervalMin}
                      onChange={(e) => set('syncIntervalMin', e.target.value)}
                    />
                  )}
                </Field>
                <Field label="追踪轮询间隔（分钟）">
                  {(id) => (
                    <Input
                      id={id}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={1440}
                      value={form.trackedPollIntervalMin}
                      onChange={(e) => set('trackedPollIntervalMin', e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Field label="时区" hint="日报与定时任务使用该时区，例如 Asia/Shanghai">
                {(id) => (
                  <Input
                    id={id}
                    value={form.timezone}
                    onChange={(e) => set('timezone', e.target.value)}
                    placeholder="Asia/Shanghai"
                  />
                )}
              </Field>
              <Button block loading={patchSettings.isPending} onClick={saveSync}>
                保存同步设置
              </Button>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <SectionHead title="快递100" hint="独立查询手工运单及已有运单号的拼多多包裹" />
          {form && <div className="space-y-3">
            <div className="flex items-center justify-between"><span className="text-sm font-medium text-slate-700">启用快递100</span><Switch checked={form.kuaidi100Enabled} onChange={(v) => set('kuaidi100Enabled', v)} label="启用快递100" /></div>
            <Field label="Customer 授权码">{id => <Input id={id} autoComplete="off" value={form.kuaidi100Customer} onChange={e => set('kuaidi100Customer', e.target.value)} />}</Field>
            <SecretField label="快递100 Key" state={settings.data?.logistics.key} placeholder="控制台中的 Key" onSave={v => saveSecret('kuaidi100', v)} onClear={() => clearSecret('kuaidi100')} />
            <Field label="自动查询间隔（分钟）" hint="31–1440；仅自动查询开启追踪且尚未完成的包裹，按服务套餐计费">
              {id => <Input id={id} type="number" min={31} max={1440} value={form.kuaidi100PollIntervalMin} onChange={e => set('kuaidi100PollIntervalMin', e.target.value)} />}
            </Field>
            <p className="text-xs leading-relaxed text-slate-500">需开通快递100实时查询服务。每单至少间隔31分钟，手动刷新也受限制。顺丰、中通等需填写查件手机号。此接口不能发现新增购物订单。</p>
            <a className="text-xs text-indigo-600" href="https://api.kuaidi100.com/" target="_blank" rel="noopener noreferrer">打开快递100开放平台 ↗</a>
            <Button block loading={patchSettings.isPending} onClick={() => {
              const interval = Number(form.kuaidi100PollIntervalMin);
              if (!Number.isInteger(interval) || interval < 31 || interval > 1440) { toast('查询间隔需为31–1440分钟', 'error'); return; }
              if (form.kuaidi100Enabled && (!form.kuaidi100Customer.trim() || !settings.data?.logistics.key.configured)) { toast('请先填写 Customer 并保存 Key', 'error'); return; }
              patchSettings.mutate({ kuaidi100Enabled: form.kuaidi100Enabled, kuaidi100Customer: form.kuaidi100Customer.trim(), kuaidi100PollIntervalMin: interval }, { onSuccess: () => toast('物流查询设置已保存', 'success'), onError: e => toast(errorMessage(e, '保存失败'), 'error') });
            }}>保存物流查询设置</Button>
          </div>}
        </Card>

        {/* ───────── 通知 ───────── */}
        <Card className="p-4">
          <SectionHead title="通知" hint="包裹动态与日报推送" />
          {settings.isPending || !form ? (
            <PageLoader />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-700">Telegram 推送</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    待取件自动推送柜号、取件码；追踪包裹另推送物流动态和定时日报
                  </p>
                </div>
                <Switch
                  checked={form.telegramEnabled}
                  onChange={(v) => set('telegramEnabled', v)}
                  label="Telegram 推送"
                />
              </div>

              <Field label="Chat ID" hint="先让 Bot 给你发一条消息，再用 getUpdates 获取">
                {(id) => (
                  <Input
                    id={id}
                    value={form.telegramChatId}
                    onChange={(e) => set('telegramChatId', e.target.value)}
                    placeholder="123456789"
                    inputMode="numeric"
                  />
                )}
              </Field>

              <SecretField
                label="Bot Token"
                hint="从 @BotFather 获取，保存后不可回读"
                state={settings.data?.notifications.telegram.token}
                placeholder="123456:ABC…"
                onSave={(value) => saveSecret('telegram', value)}
                onClear={() => clearSecret('telegram')}
              />

              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <div>
                  <p className="text-sm font-medium text-slate-700">浏览器推送</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">Web Push（需 HTTPS）</p>
                </div>
                <Switch
                  checked={form.webPushEnabled}
                  onChange={(v) => set('webPushEnabled', v)}
                  label="浏览器推送"
                />
              </div>

              <Button block loading={patchSettings.isPending} onClick={saveNotifications}>
                保存通知设置
              </Button>
            </div>
          )}
        </Card>

        {/* ───────── 地址 ───────── */}
        <AddressSection
          addresses={addresses.data?.addresses ?? []}
          loading={addresses.isPending}
        />

        {/* ───────── 数据 ───────── */}
        <Card className="divide-y divide-slate-100">
          <button
            type="button"
            onClick={() => navigate('/hidden')}
            className="flex w-full items-center justify-between px-4 py-3.5 text-left active:bg-slate-50"
          >
            <span>
              <span className="block text-sm font-medium text-slate-700">已隐藏的包裹</span>
              <span className="mt-0.5 block text-[11px] text-slate-400">查看并恢复被隐藏的包裹</span>
            </span>
            <Chevron />
          </button>
        </Card>

        {/* ───────── 本地 API ───────── */}
        <Card className="p-4">
          <SectionHead
            title="本地 API"
            hint="供 /api/v1 与 MCP 使用的 Bearer Token"
          />
          <SecretField
            label="Token"
            hint="配置后可在本机脚本中调用包裹接口"
            state={localApi.data?.token}
            placeholder="至少 16 位随机字符串"
            onSave={(value) => saveSecret('local-api', value)}
            onClear={() => clearSecret('local-api')}
          />
        </Card>

        {/* ───────── 安全 ───────── */}
        <SecuritySection />

        <Button
          variant="secondary"
          block
          loading={logout.isPending}
          onClick={() => {
            logout.mutate(undefined, {
              onSettled: () => navigate('/login', { replace: true }),
            });
          }}
        >
          退出登录
        </Button>

        <p className="pt-1 text-center text-[10px] text-slate-400">
          ExpressAssistant Web · 凭据加密存储于本服务器
        </p>
      </div>
    </div>
  );
}

// ───────────────────────── 账号 ─────────────────────────

function AccountSection({
  accounts,
  loading,
  error,
}: {
  accounts: AccountDto[];
  loading: boolean;
  error: boolean;
}) {
  const navigate = useNavigate();
  const createSession = useCreateLoginSession();
  const verify = useVerifyAccount();
  const patch = usePatchAccount();
  const del = useDeleteAccount();

  const [editing, setEditing] = useState<AccountDto | null>(null);
  const [removing, setRemoving] = useState<AccountDto | null>(null);
  const [label, setLabel] = useState('');

  const startLogin = (channel: Channel, accountId?: string): void => {
    createSession.mutate(
      { channel, ...(accountId ? { accountId } : {}) },
      {
        onSuccess: (session) => navigate(`/login/remote/${session.sessionId}`),
        onError: (err) => toast(errorMessage(err, '无法启动登录会话'), 'error'),
      },
    );
  };

  const doVerify = (account: AccountDto): void => {
    verify.mutate(account.id, {
      onSuccess: (res) => {
        if (res.account.status === 'ok') toast('登录凭据已保存，实际状态以下次同步结果为准', 'success');
        else toast(`${STATUS_LABEL[res.account.status]}${res.account.statusDetail ? `：${res.account.statusDetail}` : ''}`, 'error');
      },
      onError: (err) => toast(errorMessage(err, '校验失败'), 'error'),
    });
  };

  return (
    <Card className="p-4">
      <SectionHead title="平台账号" hint="服务端浏览器登录，凭据加密保存" />

      {loading ? (
        <PageLoader />
      ) : error ? (
        <ErrorBanner message="账号加载失败，请稍后重试" />
      ) : accounts.length === 0 ? (
        <p className="py-1 text-xs leading-relaxed text-slate-400">
          还没有绑定账号。选择下面的平台开始登录，扫码或短信验证都在本站内完成。
        </p>
      ) : (
        <div className="space-y-2">
          {accounts.map((account) => (
            <div key={account.id} className="rounded-xl bg-slate-50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                    <span className="truncate">{account.label}</span>
                    <Chip tone={STATUS_TONE[account.status]}>{STATUS_LABEL[account.status]}</Chip>
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {CHANNEL_NAMES[account.channel]}
                    {account.lastOkAt && ` · 最近成功 ${formatRelative(account.lastOkAt)}`}
                  </p>
                  {account.statusDetail && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">
                      {account.statusDetail}
                    </p>
                  )}
                </div>
                <Switch
                  checked={account.enabled}
                  onChange={(enabled) =>
                    patch.mutate(
                      { id: account.id, patch: { enabled } },
                      {
                        onSuccess: () => toast(enabled ? '已启用' : '已停用', 'success'),
                        onError: () => toast('操作失败', 'error'),
                      },
                    )
                  }
                  label="启用账号"
                />
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={createSession.isPending}
                  onClick={() => startLogin(account.channel, account.id)}
                >
                  {account.channel === 'pdd' && account.status === 'challenge' ? '完成安全验证' : '重新登录'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={verify.isPending && verify.variables === account.id}
                  onClick={() => doVerify(account)}
                >
                  校验
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(account);
                    setLabel(account.label);
                  }}
                >
                  重命名
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(account)}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 border-t border-slate-100 pt-3">
        <p className="mb-2 text-[11px] font-medium text-slate-400">添加账号</p>
        <div className="grid grid-cols-2 gap-2">
          {CHANNELS.map((channel) => (
            <Button
              key={channel}
              size="sm"
              variant="secondary"
              disabled={createSession.isPending}
              onClick={() => startLogin(channel)}
            >
              + {CHANNEL_NAMES[channel]}
            </Button>
          ))}
        </div>
      </div>

      {/* 重命名 */}
      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="账号名称"
      >
        <div className="space-y-3">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如：我的京东账号"
            maxLength={64}
          />
          <Button
            block
            loading={patch.isPending}
            disabled={!label.trim()}
            onClick={() => {
              if (!editing) return;
              patch.mutate(
                { id: editing.id, patch: { label: label.trim() } },
                {
                  onSuccess: () => {
                    toast('已重命名', 'success');
                    setEditing(null);
                  },
                  onError: (err) => toast(errorMessage(err, '重命名失败'), 'error'),
                },
              );
            }}
          >
            保存
          </Button>
        </div>
      </Sheet>

      {/* 删除确认 */}
      <Sheet open={removing !== null} onClose={() => setRemoving(null)} title="删除账号">
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-slate-500">
            将删除「{removing?.label}」及其保存的登录凭据。已同步的包裹记录会保留，但不会再从该账号更新。
          </p>
          <Button
            variant="danger"
            block
            loading={del.isPending}
            onClick={() => {
              if (!removing) return;
              del.mutate(removing.id, {
                onSuccess: () => {
                  toast('账号已删除', 'success');
                  setRemoving(null);
                },
                onError: (err) => toast(errorMessage(err, '删除失败'), 'error'),
              });
            }}
          >
            确认删除
          </Button>
          <Button
            variant="secondary"
            block
            onClick={() => setRemoving(null)}
          >
            取消
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

// ───────────────────────── 地址 ─────────────────────────

function AddressSection({
  addresses,
  loading,
}: {
  addresses: AddressDto[];
  loading: boolean;
}) {
  const create = useCreateAddress();
  const patch = usePatchAddress();
  const del = useDeleteAddress();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AddressDto | null>(null);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');

  const openCreate = (): void => {
    setEditing(null);
    setLabel('');
    setAddress('');
    setOpen(true);
  };

  const openEdit = (a: AddressDto): void => {
    setEditing(a);
    setLabel(a.label);
    setAddress(a.address);
    setOpen(true);
  };

  const submit = (): void => {
    if (!label.trim() || !address.trim()) {
      toast('请填写名称和地址', 'error');
      return;
    }
    if (editing) {
      patch.mutate(
        { id: editing.id, patch: { label: label.trim(), address: address.trim() } },
        {
          onSuccess: () => {
            toast('地址已更新', 'success');
            setOpen(false);
          },
          onError: (err) => toast(errorMessage(err, '保存失败'), 'error'),
        },
      );
      return;
    }
    create.mutate(
      { label: label.trim(), address: address.trim() },
      {
        onSuccess: () => {
          toast('地址已添加', 'success');
          setOpen(false);
        },
        onError: (err) => toast(errorMessage(err, '添加失败'), 'error'),
      },
    );
  };

  return (
    <Card className="p-4">
      <SectionHead
        title="收货地址"
        hint="用于判断包裹是否已到家"
        action={
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
          >
            + 添加
          </button>
        }
      />

      {loading ? (
        <PageLoader />
      ) : addresses.length === 0 ? (
        <p className="py-1 text-xs leading-relaxed text-slate-400">
          还没有地址。添加常用收货地址后，AI 可以判断「到家」的包裹。
        </p>
      ) : (
        <div className="divide-y divide-slate-100">
          {addresses.map((a) => (
            <div key={a.id} className="flex items-start gap-2 py-2.5 first:pt-0 last:pb-0">
              <button
                type="button"
                aria-label={a.active ? '当前默认地址' : '设为默认地址'}
                onClick={() =>
                  patch.mutate(
                    { id: a.id, patch: { active: true } },
                    {
                      onSuccess: () => toast('已设为默认地址', 'success'),
                      onError: () => toast('操作失败', 'error'),
                    },
                  )
                }
                className={cx(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ring-1',
                  a.active
                    ? 'bg-indigo-600 ring-indigo-600'
                    : 'bg-white ring-slate-300',
                )}
              >
                {a.active && <span className="size-1.5 rounded-full bg-white" />}
              </button>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">
                  {a.label}
                  {a.active && <span className="ml-1.5 text-[11px] font-normal text-indigo-500">默认</span>}
                </p>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-400">
                  {a.address}
                </p>
              </div>

              <button
                type="button"
                onClick={() => openEdit(a)}
                className="rounded-lg px-1.5 py-1 text-[11px] text-slate-400 hover:bg-slate-100"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() =>
                  del.mutate(a.id, {
                    onSuccess: () => toast('已删除', 'success'),
                    onError: () => toast('删除失败', 'error'),
                  })
                }
                aria-label="删除地址"
                className="rounded-lg p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
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

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? '编辑地址' : '添加地址'}
      >
        <div className="space-y-3">
          <Field label="名称">
            {(id) => (
              <Input
                id={id}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如：家 / 公司"
                maxLength={64}
              />
            )}
          </Field>
          <Field label="地址">
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="省市区 + 详细地址"
                maxLength={500}
              />
            )}
          </Field>
          <Button
            block
            loading={create.isPending || patch.isPending}
            onClick={submit}
          >
            保存
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

// ───────────────────────── 安全 ─────────────────────────

function SecuritySection() {
  const change = useChangePassword();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const submit = (): void => {
    if (next !== confirm) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    if (next.length < 8 || /^\d+$/.test(next)) {
      toast('新密码至少 8 位且不能是纯数字', 'error');
      return;
    }
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          toast('密码已修改', 'success');
          setOpen(false);
          setCurrent('');
          setNext('');
          setConfirm('');
        },
        onError: (err) => toast(errorMessage(err, '修改失败'), 'error'),
      },
    );
  };

  return (
    <Card className="p-4">
      <SectionHead title="安全" hint="修改登录密码" />
      <Button variant="secondary" block onClick={() => setOpen(true)}>
        修改密码
      </Button>

      <Sheet open={open} onClose={() => setOpen(false)} title="修改密码">
        <div className="space-y-3">
          <Field label="当前密码">
            {(id) => (
              <Input
                id={id}
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
              />
            )}
          </Field>
          <Field label="新密码" hint="至少 8 位，不能是纯数字">
            {(id) => (
              <Input
                id={id}
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
              />
            )}
          </Field>
          <Field label="确认新密码">
            {(id) => (
              <Input
                id={id}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            )}
          </Field>
          <Button
            block
            loading={change.isPending}
            disabled={!current || !next || !confirm}
            onClick={submit}
          >
            确认修改
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

// ───────────────────────── 通用 ─────────────────────────

function SectionHead({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-4 text-slate-300" aria-hidden="true">
      <path
        d="m9.5 5 7 7-7 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 只写密钥输入：显示 configured/maskedTail，保存后清空输入框。
 * mutation 由调用方通过 hooks 传入（避免在子组件里重复创建 hook 实例）。
 */
function SecretField({
  label,
  hint,
  state,
  placeholder,
  onSave,
  onClear,
}: {
  label: string;
  hint?: string;
  state: SecretState | undefined;
  placeholder?: string;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [value, setValue] = useState('');
  const configured = Boolean(state?.configured);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        {configured ? (
          <Chip tone="emerald">已配置{state?.maskedTail ? ` · ${state.maskedTail}` : ''}</Chip>
        ) : (
          <Chip tone="slate">未配置</Chip>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={configured ? '输入新值以替换' : placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          size="md"
          disabled={!value.trim()}
          onClick={() => {
            onSave(value.trim());
            setValue('');
          }}
        >
          保存
        </Button>
        {configured && (
          <Button
            size="md"
            variant="secondary"
            onClick={() => {
              onClear();
              setValue('');
            }}
          >
            清除
          </Button>
        )}
      </div>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) return err.message || fallback;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
