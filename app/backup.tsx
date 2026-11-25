"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { today } from "../lib/ledger";
import { preference, saveSnapshot, serializeEnvelope, type Envelope } from "../lib/vault";
import {desktopInvoke, isDesktop} from "../lib/desktop";

type Directory = FileSystemDirectoryHandle & {
  queryPermission(options: {mode: "readwrite"}): Promise<PermissionState>;
  requestPermission(options: {mode: "readwrite"}): Promise<PermissionState>;
};
type Config = {handle?: Directory; desktopFolder?: string; enabled: boolean; lastDay?: string; lastRevision?: string; lastAt?: string};
export type BackupControls = {
  message: string; localStatus: string; folder: string; enabled: boolean; lastAt: string; choose: () => Promise<void>; toggle: () => Promise<void>; run: () => Promise<void>;
};

export function useDailyBackup(envelope: Envelope | undefined): BackupControls {
  const [config, setConfig] = useState<Config>({enabled: false});
  const [message, setMessage] = useState("Choose a folder to keep an additional encrypted copy outside the app.");
  const [localStatus, setLocalStatus] = useState("Saving the local recovery copy…");
  const writing = useRef(false);
  useEffect(() => {
    void preference<Config>("backup").then(saved => {
      if (saved) {
        setConfig(saved);
        if (saved.handle || saved.desktopFolder) setMessage(saved.enabled ? "Encrypted folder backups are enabled while the workspace is open and unlocked." : "Encrypted folder backups are paused.");
      }
    }).catch(() => setMessage("Backup preferences could not be loaded."));
  }, []);
  const perform = useCallback(async (manual: boolean) => {
    if (!envelope || writing.current) return;
    writing.current = true;
    try {
      const latest = await preference<Config>("backup");
      if (!latest?.enabled || (!latest.handle && !latest.desktopFolder)) return;
      if (!manual && latest.lastDay === today() && latest.lastRevision === envelope.revision) return;
      if (isDesktop() && latest.desktopFolder) {
        await desktopInvoke<string>("write_encrypted_backup", {text: serializeEnvelope(envelope)});
        const current = await preference<Config>("backup");
        if (!current?.enabled || current.desktopFolder !== latest.desktopFolder) return;
        const saved = {...current, lastDay: today(), lastRevision: envelope.revision, lastAt: new Date().toISOString()};
        await preference("backup", saved);setConfig(saved);
        setMessage("Encrypted desktop backup saved and verified.");
        return;
      }
      if (!latest.handle) return;
      let permission = await latest.handle.queryPermission({mode: "readwrite"});
      if (manual && permission !== "granted") permission = await latest.handle.requestPermission({mode: "readwrite"});
      if (permission !== "granted") throw new Error("Open Settings and choose the backup folder again to grant access.");
      const text = serializeEnvelope(envelope), name = "Finance_Atlas_" + today() + "_" + envelope.revision + ".atlasenc";
      const file = await latest.handle.getFileHandle(name, {create: true}), writable = await file.createWritable();
      try {await writable.write(text);await writable.close();}
      catch (error) {await writable.abort().catch(() => {});throw error;}
      if (await (await file.getFile()).text() !== text) throw new Error("The written backup could not be verified.");
      const current = await preference<Config>("backup");
      if (!current?.enabled || !current.handle || !await current.handle.isSameEntry(latest.handle)) return;
      const saved = {...current, lastDay: today(), lastRevision: envelope.revision, lastAt: new Date().toISOString()};
      await preference("backup", saved);setConfig(saved);
      setMessage("Encrypted backup saved and verified.");
    } catch (error) {setMessage(error instanceof Error ? error.message : "The backup could not be written.");}
    finally {writing.current = false;}
  }, [envelope]);
  useEffect(() => {
    if (!envelope) return;
    let active = true;
    const snapshot = () => void saveSnapshot(envelope, today(), true).then(saved => {
      if (active && saved) setLocalStatus("Local recovery copy saved.");
    }).catch(() => {if (active) setLocalStatus("Could not save a local recovery copy.");});
    setLocalStatus("Saving the local recovery copy…");
    snapshot();
    const timer = setTimeout(() => {void perform(false);}, 15000);
    const interval = setInterval(() => {void perform(false);}, 60000);
    const daily = setInterval(snapshot, 3_600_000);
    return () => {active = false;clearTimeout(timer);clearInterval(interval);clearInterval(daily);};
  }, [envelope, perform]);
  const choose = async () => {
    try {
      if (isDesktop()) {
        const folder = await desktopInvoke<string | null>("choose_backup_folder");
        if (!folder) return;
        const next: Config = {desktopFolder: folder, enabled: true};
        await preference("backup", next);setConfig(next);
        setMessage("Desktop backup folder connected.");
        await perform(true);
        return;
      }
      const picker = (window as Window & {showDirectoryPicker?: (options: {mode: "readwrite"; id: string}) => Promise<Directory>}).showDirectoryPicker;
      if (!picker) throw new Error("Folder backups require a browser with folder access. Download an encrypted backup on this device.");
      const handle = await picker({mode: "readwrite", id: "finance-atlas-backup"});
      const next = {handle, enabled: true};
      await preference("backup", next);setConfig(next);
      setMessage("Folder connected. Backups run while the workspace is open and unlocked.");
      await perform(true);
    } catch (error) {if (!(error instanceof DOMException && error.name === "AbortError")) setMessage(error instanceof Error ? error.message : "Could not select the folder.");}
  };
  return {message, localStatus, folder: config.desktopFolder || config.handle?.name || "", enabled: config.enabled, lastAt: config.lastAt || "", choose,
    toggle: async () => {
      const latest = await preference<Config>("backup") ?? config;
      const next = {...latest, enabled: !latest.enabled};
      await preference("backup", next);setConfig(next);
      setMessage(next.enabled ? "Encrypted folder backups are enabled." : "Encrypted folder backups are paused.");
      if (next.enabled) await perform(true);
    }, run: () => perform(true)};
}
