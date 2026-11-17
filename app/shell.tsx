import {useEffect, useRef, useState, type ReactNode} from "react";
import {Icon} from "./icons";
import {navGroups, orderedViews, viewIcons, type View} from "../lib/navigation";
import type {Ledger} from "../lib/ledger";

export function Sidebar({ledger, view, collapsed, hasSidebar, busy, drawer, navigate, toggle, lock, close}: {
  ledger: Ledger; view: View; collapsed: boolean; hasSidebar: boolean; busy: boolean; drawer: boolean;
  navigate: (view: View) => void; toggle: () => void; lock: () => void; close: () => void;
}) {
  const ordered = orderedViews(ledger);
  const button = (item: View) => {
    const label = item === "Overview" ? "Dashboard" : item;
    return <button key={item} title={label} aria-label={label} aria-current={item === view ? "page" : undefined}
      onClick={() => {navigate(item);close();}}><Icon name={viewIcons[item]} /><span className="nav-label">{label}</span></button>;
  };
  return <>
    {drawer && <button className="atlas-drawer-backdrop" aria-label="Close navigation" onClick={close} />}
    <aside data-drawer={drawer}>
      <div className="sidebar-heading"><div className="brand"><Icon name="wallet" /><span className="brand-label">Finance Atlas</span></div>
        {hasSidebar && <button className="sidebar-toggle" disabled={busy} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls="workspace-navigation"
          onClick={toggle}><Icon name={collapsed ? "right" : "left"} /></button>}</div>
      <nav id="workspace-navigation" aria-label="Workspace">{navGroups.map(group => {
        const items = ordered.filter(item => group.views.includes(item));
        return items.length > 0 && <div className="atlas-nav-group" key={group.label}>
          <span className="atlas-nav-caption">{group.label}</span>{items.map(button)}
        </div>;
      })}</nav>
      <div className="sidebar-bottom">{button("Assistant")}
        <button className="lock" aria-label="Lock workspace" title="Lock workspace" disabled={busy} onClick={lock}>
          <Icon name="lock" /><span className="nav-label">Lock workspace</span></button>
      </div>
    </aside>
  </>;
}

export function PeriodPicker({children}: {children: ReactNode}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {setOpen(false);trigger.current?.focus();}
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div ref={wrapper} className="atlas-period">
    <button ref={trigger} className="icon-button" aria-label="Choose reporting period" aria-expanded={open}
      onClick={() => setOpen(value => !value)}><Icon name="calendar" /></button>
    {open && <div className="period-popover">{children}</div>}
  </div>;
}
