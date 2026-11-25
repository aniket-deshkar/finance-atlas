import {Tabs} from "@ark-ui/react/tabs";
import type {ReactNode} from "react";
import {Icon, type IconName} from "./icons";

export const settingGroups = {
  "Appearance & navigation": {icon:"dashboard", label:"Appearance", detail:"Theme, motion and workspace layout"},
  "Finance & automation": {icon:"wallet", label:"Finance & automation", detail:"Reporting, reminders and transaction defaults"},
  "AI & providers": {icon:"sparkle", label:"AI & providers", detail:"Cloud connection, models and usage"},
  "Data, backup & security": {icon:"shield", label:"Data & security", detail:"Encrypted backups, recovery and local files"},
} satisfies Record<string, {icon:IconName; label:string; detail:string}>;
export type SettingsGroup = keyof typeof settingGroups;

export function SettingsLayout({selected, onSelect, children}: {
  selected: SettingsGroup; onSelect: (group: SettingsGroup) => void; children: ReactNode;
}) {
  const group = settingGroups[selected];
  return <Tabs.Root className="atlas-preferences" value={selected}
    onValueChange={({value}) => {if (Object.hasOwn(settingGroups, value)) onSelect(value as SettingsGroup);}}>
    <Tabs.List className="atlas-preference-list" aria-label="Settings sections">
      {(Object.keys(settingGroups) as SettingsGroup[]).map(key => {
        const entry = settingGroups[key];
        return <Tabs.Trigger key={key} value={key} aria-label={key} className="atlas-preference-tab">
          <span><Icon name={entry.icon} /></span><strong>{entry.label}</strong>
        </Tabs.Trigger>;
      })}
    </Tabs.List>
    <Tabs.Content value={selected} className="atlas-preference-body" key={selected}>
      <header className="atlas-preference-heading"><h2>{group.label}</h2><p>{group.detail}</p></header>
      {children}
    </Tabs.Content>
  </Tabs.Root>;
}
