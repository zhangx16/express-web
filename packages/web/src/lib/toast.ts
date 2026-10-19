import { useSyncExternalStore } from 'react';

export interface ToastItem {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ToastItem[] {
  return items;
}

/** 弹出一条轻提示，2.6 秒后自动消失 */
export function toast(text: string, tone: ToastItem['tone'] = 'info'): void {
  seq += 1;
  const item: ToastItem = { id: seq, text, tone };
  items = [...items, item];
  emit();
  window.setTimeout(() => {
    items = items.filter((x) => x.id !== item.id);
    emit();
  }, 2600);
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
