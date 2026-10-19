import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { cx } from '../lib/cx.js';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const NAV: NavItem[] = [
  {
    to: '/',
    label: '包裹',
    end: true,
    icon: <Icon d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z M3.5 8.5 12 13l8.5-4.5 M12 13v7" />,
  },
  {
    to: '/reports',
    label: '日报',
    icon: <Icon d="M6 3.5h9l3.5 3.5v13.5H6V3.5Z M15 3.5V7h3.5 M9 11h6 M9 14.5h6 M9 18h3.5" />,
  },
  {
    to: '/settings',
    label: '设置',
    icon: (
      <Icon d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.7 7.7 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5Z" />
    ),
  },
];

/** 移动优先外壳：内容区 + 底部导航（桌面端居中限宽） */
export default function AppShell() {
  const location = useLocation();
  // 详情页沉浸式，不显示底部导航
  const hideNav = /^\/item\//.test(location.pathname);

  return (
    <div className="relative mx-auto flex min-h-full w-full max-w-lg flex-col bg-slate-100 shadow-xl sm:my-4 sm:min-h-[calc(100%-2rem)] sm:rounded-3xl">
      <main className={cx('flex-1', hideNav ? 'pb-0' : 'pb-20')}>
        <Outlet />
      </main>

      {!hideNav && (
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/70 bg-white/95 backdrop-blur sm:absolute sm:mx-auto sm:max-w-lg sm:rounded-b-3xl">
          <div className="flex items-stretch justify-around px-2 pb-safe">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                    isActive ? 'text-indigo-600' : 'text-slate-400 hover:text-slate-600',
                  )
                }
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
