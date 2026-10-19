import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AccountDto,
  AccountPatch,
  AddressDto,
  AuthMeResponse,
  Channel,
  DetailBundle,
  ExpressItem,
  ItemSource,
  GoodsDto,
  ItemsQuery,
  ItemsResponse,
  ItemPatch,
  JumpLink,
  LoginSessionCreate,
  LoginSessionDto,
  ReportDto,
  ReportScheduleDto,
  SectionKey,
  SecretState,
  SettingsDto,
  SyncRunDto,
  SyncStartResponse,
  SyncStatusResponse,
  TraceResponse,
} from '@ea/shared';
import { ApiClientError, api, qs } from './client.js';

// ───────────────────────── 查询键 ─────────────────────────

export const keys = {
  me: ['me'] as const,
  items: (filter: ItemsFilter) => ['items', filter] as const,
  item: (mailNo: string) => ['item', mailNo] as const,
  trace: (mailNo: string) => ['trace', mailNo] as const,
  links: (mailNo: string) => ['links', mailNo] as const,
  hidden: ['hidden'] as const,
  accounts: ['accounts'] as const,
  settings: ['settings'] as const,
  addresses: ['addresses'] as const,
  reports: ['reports'] as const,
  schedules: ['schedules'] as const,
  localApiToken: ['local-api-token'] as const,
  syncStatus: ['sync', 'status'] as const,
  syncRuns: ['sync', 'runs'] as const,
  loginSession: (id: string) => ['login', id] as const,
};

export interface ItemsFilter {
  section?: SectionKey | '';
  q?: string;
  source?: ItemSource | '';
  tracked?: boolean;
}

function itemsPath(filter: ItemsFilter): string {
  return `/items${qs({
    section: filter.section || undefined,
    q: filter.q || undefined,
    source: filter.source || undefined,
    tracked: filter.tracked || undefined,
  })}`;
}

// ───────────────────────── 鉴权 ─────────────────────────

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api<AuthMeResponse>('/auth/me'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      api<{ user: { id: string; username: string }; csrfToken: string }>('/auth/login', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.clear(),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api<{ ok: boolean }>('/auth/password', { method: 'POST', body: input }),
  });
}

// ───────────────────────── 包裹 ─────────────────────────

export function useItems(filter: ItemsFilter) {
  return useQuery({
    queryKey: keys.items(filter),
    queryFn: ({ signal }) => api<ItemsResponse>(itemsPath(filter), { signal }),
    placeholderData: (prev) => prev,
  });
}

export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { mailNo: string; companyName?: string; companyCode?: string; phone?: string }) =>
      api<{ item: ExpressItem }>('/items', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['items'] }),
  });
}

export function useItem(mailNo: string) {
  return useQuery({
    queryKey: keys.item(mailNo),
    queryFn: () => api<DetailBundle>(`/items/${encodeURIComponent(mailNo)}`),
    enabled: Boolean(mailNo),
  });
}

export function useTrace(mailNo: string, enabled = true) {
  return useQuery({
    queryKey: keys.trace(mailNo),
    queryFn: () => api<TraceResponse>(`/items/${encodeURIComponent(mailNo)}/trace`),
    enabled: Boolean(mailNo) && enabled,
    staleTime: 60_000,
    retry: (failures, error) => !(error instanceof ApiClientError && error.status < 500) && failures < 1,
  });
}

export function useLinks(mailNo: string) {
  return useQuery({
    queryKey: keys.links(mailNo),
    queryFn: () => api<{ links: JumpLink[] }>(`/items/${encodeURIComponent(mailNo)}/links`),
    enabled: Boolean(mailNo),
    staleTime: 5 * 60_000,
  });
}

export function usePatchItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { mailNo: string; patch: ItemPatch }) =>
      api<{ item: unknown }>(`/items/${encodeURIComponent(input.mailNo)}`, {
        method: 'PATCH',
        body: input.patch,
      }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: keys.item(variables.mailNo) });
    },
  });
}

export function useHideItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailNo: string) =>
      api<{ ok: boolean }>(`/items/${encodeURIComponent(mailNo)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: keys.hidden });
    },
  });
}

export interface HiddenEntry {
  mailNo: string;
  hiddenAt: string;
  item: ExpressItem | null;
}

export function useHiddenItems() {
  return useQuery({
    queryKey: keys.hidden,
    queryFn: () => api<{ items: HiddenEntry[] }>('/items/hidden'),
  });
}

export function useRestoreItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailNo: string) =>
      api<{ ok: boolean }>(`/items/${encodeURIComponent(mailNo)}/restore`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: keys.hidden });
    },
  });
}

export function useRefreshItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailNo: string) =>
      api<DetailBundle>(`/items/${encodeURIComponent(mailNo)}/refresh`, { method: 'POST' }),
    onSuccess: (_data, mailNo) => {
      void qc.invalidateQueries({ queryKey: keys.item(mailNo) });
      void qc.invalidateQueries({ queryKey: keys.trace(mailNo) });
      void qc.invalidateQueries({ queryKey: ['items'] });
    },
  });
}

export function useResolveGoods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mailNo: string) =>
      api<{ goods: GoodsDto | null }>(`/items/${encodeURIComponent(mailNo)}/goods/resolve`, {
        method: 'POST',
      }),
    onSuccess: (_data, mailNo) => {
      void qc.invalidateQueries({ queryKey: keys.item(mailNo) });
    },
  });
}

// ───────────────────────── 同步 ─────────────────────────

export function useSyncStatus() {
  return useQuery({
    queryKey: keys.syncStatus,
    queryFn: () => api<SyncStatusResponse>('/sync/status'),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });
}

export function useSyncRuns() {
  return useQuery({
    queryKey: keys.syncRuns,
    queryFn: () => api<{ runs: SyncRunDto[] }>('/sync/runs?limit=20'),
  });
}

export function useStartSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<SyncStartResponse>('/sync', { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.syncStatus });
    },
  });
}

// ───────────────────────── 账号 ─────────────────────────

export function useAccounts() {
  return useQuery({
    queryKey: keys.accounts,
    queryFn: () => api<{ accounts: AccountDto[] }>('/accounts'),
  });
}

export function usePatchAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: AccountPatch }) =>
      api<{ account: AccountDto }>(`/accounts/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        body: input.patch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.accounts });
      void qc.invalidateQueries({ queryKey: ['items'] });
    },
  });
}

export function useVerifyAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; account: AccountDto }>(`/accounts/${encodeURIComponent(id)}/verify`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useCreateLoginSession() {
  return useMutation({
    mutationFn: (input: LoginSessionCreate) =>
      api<LoginSessionDto>('/login/sessions', { method: 'POST', body: input }),
  });
}

export function useLoginSession(sessionId: string) {
  return useQuery({
    queryKey: keys.loginSession(sessionId),
    queryFn: () => api<LoginSessionDto>(`/login/sessions/${encodeURIComponent(sessionId)}`),
    enabled: Boolean(sessionId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'ok' || status === 'failed' || status === 'cancelled' || status === 'expired'
        ? false
        : 5000;
    },
    retry: false,
  });
}

export function useCancelLoginSession() {
  return useMutation({
    mutationFn: (sessionId: string) =>
      api<{ ok: boolean }>(`/login/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }),
  });
}

// ───────────────────────── 设置 ─────────────────────────

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => api<SettingsDto>('/settings'),
  });
}

export interface SettingsPatch {
  kuaidi100Enabled?: boolean;
  kuaidi100Customer?: string;
  kuaidi100PollIntervalMin?: number;
  syncIntervalMin?: number;
  trackedPollIntervalMin?: number;
  timezone?: string;
  telegramEnabled?: boolean;
  telegramChatId?: string;
  webPushEnabled?: boolean;
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) =>
      api<{ settings: SettingsDto }>('/settings', { method: 'PATCH', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.settings }),
  });
}

export type SecretKind = 'telegram' | 'local-api' | 'kuaidi100';

/** 快递100使用Key，其余使用Token。 */
function secretPath(kind: SecretKind): string {
  return kind === 'kuaidi100' ? `/settings/${kind}/key` : `/settings/${kind}/token`;
}

export function useSetSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: SecretKind; value: string }) =>
      api<unknown>(secretPath(input.kind), { method: 'PUT', body: { value: input.value } }),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      if (variables.kind === 'local-api') {
        void qc.invalidateQueries({ queryKey: keys.localApiToken });
      }
    },
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: SecretKind) => api<unknown>(secretPath(kind), { method: 'DELETE' }),
    onSuccess: (_data, kind) => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      if (kind === 'local-api') {
        void qc.invalidateQueries({ queryKey: keys.localApiToken });
      }
    },
  });
}

/** 本地 API Token 只有「是否配置 + 末位」，明文不落库、不可回读 */
export function useLocalApiToken() {
  return useQuery({
    queryKey: keys.localApiToken,
    queryFn: () => api<{ token: SecretState }>('/settings/local-api/token'),
  });
}

// ───────────────────────── 地址 ─────────────────────────

export function useAddresses() {
  return useQuery({
    queryKey: keys.addresses,
    queryFn: () => api<{ addresses: AddressDto[]; activeId: string | null }>('/addresses'),
  });
}

export function useCreateAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { label: string; address: string }) =>
      api<{ address: AddressDto }>('/addresses', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.addresses }),
  });
}

export function usePatchAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: Partial<Pick<AddressDto, 'label' | 'address' | 'active'>> }) =>
      api<{ address: AddressDto }>(`/addresses/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        body: input.patch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.addresses }),
  });
}

export function useDeleteAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean }>(`/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.addresses }),
  });
}

// ───────────────────────── 日报 ─────────────────────────

export function useReports() {
  return useQuery({
    queryKey: keys.reports,
    queryFn: () => api<{ reports: ReportDto[] }>('/reports?limit=50'),
  });
}

export function useGenerateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ report: ReportDto; delivered: boolean }>('/reports/generate', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.reports }),
  });
}

export function useSchedules() {
  return useQuery({
    queryKey: keys.schedules,
    queryFn: () => api<{ schedules: ReportScheduleDto[] }>('/reports/schedules'),
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { time: string; repeat: number; weekdays: number; enabled: boolean }) =>
      api<{ schedule: ReportScheduleDto }>('/reports/schedules', { method: 'POST', body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.schedules }),
  });
}

export function usePatchSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      patch: Partial<Pick<ReportScheduleDto, 'time' | 'repeat' | 'weekdays' | 'enabled'>>;
    }) =>
      api<{ schedule: ReportScheduleDto }>(`/reports/schedules/${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        body: input.patch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.schedules }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean }>(`/reports/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.schedules }),
  });
}
