import { useMemo } from 'react';

/** 支持标题、列表、代码块、行内代码、粗体、链接的最小 Markdown 渲染器 */
export default function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className={className ?? 'space-y-1.5 break-words'}>
      {blocks.map((block, i) => {
        if (block.kind === 'code') {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[12px] leading-relaxed text-slate-100"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === 'heading') {
          return (
            <p key={i} className="text-sm font-semibold text-slate-800">
              {inline(block.text)}
            </p>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-4">
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap leading-relaxed">
            {inline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; items: string[] };

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > cursor) pushTextBlocks(blocks, text.slice(cursor, match.index));
    blocks.push({ kind: 'code', text: match[1]?.replace(/\n$/, '') ?? '' });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) pushTextBlocks(blocks, text.slice(cursor));
  return blocks;
}

function pushTextBlocks(blocks: Block[], raw: string): void {
  let list: string[] = [];
  let paragraph: string[] = [];

  const flushList = (): void => {
    if (list.length > 0) blocks.push({ kind: 'list', items: list });
    list = [];
  };
  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'text', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (const line of raw.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushList();
      flushParagraph();
      blocks.push({ kind: 'heading', text: heading[1] ?? '' });
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? '');
      continue;
    }
    if (line.trim() === '') {
      flushList();
      flushParagraph();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushList();
  flushParagraph();
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;

/** 行内标记：`code`、**粗体**、[文字](链接) */
function inline(text: string): React.ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={i}
          className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = link[2] ?? '';
      if (/^https?:\/\//.test(href)) {
        return (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 underline underline-offset-2"
          >
            {link[1]}
          </a>
        );
      }
      return <span key={i}>{link[1]}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}
