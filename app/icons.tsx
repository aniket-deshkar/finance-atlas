import type { ReactNode } from "react";

const paths = {
  chat: <><path d="M4 4h16v12H9l-5 4z" /><path d="M8 9h8m-8 3h5" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  eye: <><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
  file: <><path d="M5 3h9l5 5v13H5zM14 3v5h5M8 12h8m-8 4h8" /></>,
  vehicle: <><path d="m4 11 2-6h12l2 6m-17 0h18v7H3zM5 18v2m14-2v2M6 14h2m8 0h2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></>,
  moon: <path d="M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z" />,
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /></>,
  activity: <><path d="M3 3v18h18M5 15l5-6 5 4 6-9" /></>,
  wallet: <><path d="M19 7V4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h16V7H5a1 1 0 0 1 0-2" /><path d="M21 11h-6v6h6M17 14h.01" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M2 10h20M6 15h3" /></>,
  goals: <><path d="M5 21V3m0 1c5-4 9 4 15 0v10c-6 4-10-4-15 0" /></>,
  settings: <><path d="m10 3-.6 2.2-1.6.9-2.2-.6-2 3.4L5.2 11v2l-1.6 2.1 2 3.4 2.2-.6 1.6.9.6 2.2h4l.6-2.2 1.6-.9 2.2.6 2-3.4-1.6-2.1v-2l1.6-2.1-2-3.4-2.2.6-1.6-.9L14 3z" /><circle cx="12" cy="12" r="3" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h2m3 0h2m3 0h.1M7 18h2m3 0h2" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  left: <path d="m14 6-6 6 6 6" />,
  right: <path d="m10 6 6 6-6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  income: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  expense: <><path d="M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  transfer: <path d="M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4" />,
  house: <><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" /></>,
  shield: <><path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7zM8 12l3 3 5-6" /></>,
  more: <><circle cx="12" cy="5" r=".7" /><circle cx="12" cy="12" r=".7" /><circle cx="12" cy="19" r=".7" /></>
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={"icon " + className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
