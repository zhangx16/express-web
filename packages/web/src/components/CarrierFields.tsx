import { Field, Input, Select } from './ui.js';
const names = ['顺丰速运', '顺丰快运', '中通快递', '圆通速递', '申通快递', '韵达快递', '极兔速递', '邮政快递包裹', 'EMS', '京东物流', '德邦快递', '德邦物流', '百世快递', '菜鸟速递'];
export function CarrierFields({ company, phone, onCompany, onPhone }: { company: string; phone: string; onCompany: (v: string) => void; onPhone: (v: string) => void }) {
  return <>
    <Field label="快递公司" hint="请选择实际承运公司，用于快递100查询">
      {id => <Select id={id} value={company} onChange={e => onCompany(e.target.value)}>
        <option value="">请选择快递公司</option>
        {company && !names.includes(company) && <option value={company}>{company}（请确认承运公司）</option>}
        {names.map(name => <option key={name} value={name}>{name}</option>)}
      </Select>}
    </Field>
    <Field label="查件手机号（部分公司必填）" hint="顺丰、中通等需要；虚拟号码填写横线后的四位。此号码会发送给快递100查件。">
      {id => <Input id={id} autoComplete="off" inputMode="tel" maxLength={24} pattern="[0-9+\-]{4,24}" value={phone} onChange={e => onPhone(e.target.value)} placeholder="收件或寄件手机号" />}
    </Field>
  </>;
}
