import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCreateItem } from '../api/queries.js';
import { toast } from '../lib/toast.js';
import { CarrierFields } from './CarrierFields.js';
import { Button, Field, Input, Sheet } from './ui.js';

export default function AddItemSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mailNo, setMailNo] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const create = useCreateItem();
  const navigate = useNavigate();
  return (
    <Sheet open={open} onClose={() => { if (!create.isPending) onClose(); }} title="添加包裹">
      <form className="space-y-4 pb-4" onSubmit={(event) => {
        event.preventDefault();
        if (create.isPending) return;
        create.mutate({ mailNo: mailNo.trim(), companyName: company.trim() || undefined, phone: phone.trim() || undefined }, {
          onSuccess: ({ item }) => {
            setMailNo(''); setCompany(''); setPhone(''); onClose();
            toast('包裹已添加', 'success');
            navigate(`/item/${encodeURIComponent(item.mailNo)}`);
          },
          onError: (error) => toast(error instanceof Error ? error.message : '添加失败，请重试', 'error'),
        });
      }}>
        <Field label="快递单号" hint="6–40 位字母、数字或连字符">
          {(id) => <Input id={id} autoFocus autoComplete="off" required pattern="[A-Za-z0-9-]{6,40}" maxLength={40} value={mailNo} onChange={(event) => setMailNo(event.target.value)} placeholder="输入快递单号" />}
        </Field>
        <CarrierFields company={company} phone={phone} onCompany={setCompany} onPhone={setPhone} />
        <p className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">手工记录会在平台同步后保留。设置中启用快递100后，可直接查询物流；开启包裹追踪后会定期更新。请填写真实运单号，快递100最多支持32位。</p>
        <Button type="submit" block loading={create.isPending}>添加包裹</Button>
      </form>
    </Sheet>
  );
}
