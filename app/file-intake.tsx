"use client";

import {FileUpload} from "@ark-ui/react/file-upload";
import {useId, useLayoutEffect, useRef} from "react";
import {Icon} from "./icons";

export function FileIntake({label, name, accept, format, disabled, multiple, onFiles, onError}: {
  label: string; name?: string; accept: string; format: string; disabled: boolean; multiple?: boolean;
  onFiles: (files: File[]) => void; onError: (message: string) => void;
}) {
  return <FileUpload.Root className="atlas-file-intake" accept={accept} maxFiles={multiple ? 10 : 1}
    maxFileSize={12_000_000} disabled={disabled} acceptedFiles={[]}
    onFileReject={({files}) => onError(files.map(({file}) => file.name).join(", ") + " could not be selected. Check the format, size and file count.")}
    onFileAccept={({files}) => {if (files.length) onFiles(files);}}>
    <FileUpload.HiddenInput aria-label={label} name={name} />
    <FileUpload.Label className="atlas-file-label">{label}</FileUpload.Label>
    <FileUpload.Dropzone className="atlas-file-zone" disableClick>
      <span className="atlas-file-glyph"><Icon name="file" /></span>
      <span className="atlas-file-format">{format}</span>
      <FileUpload.Trigger className="atlas-upload-action">Choose {multiple ? "files" : "file"}</FileUpload.Trigger>
    </FileUpload.Dropzone>
  </FileUpload.Root>;
}

export function PdfUnlock({filename, wrong, onUnlock, onSkip}: {
  filename: string; wrong: boolean; onUnlock: (password: string) => void; onSkip: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const title = useId(), hint = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="feature-dialog atlas-unlock-dialog" aria-labelledby={title}
    onCancel={event => {event.preventDefault();onSkip();}}>
    <form onSubmit={event => {
      event.preventDefault();
      const password = input.current?.value;
      if (password) {event.currentTarget.reset();onUnlock(password);}
    }}>
      <div className="dialog-heading"><h2 id={title}>Unlock PDF</h2></div>
      <div className="editor-fields">
        <p>Password required for {filename}</p>
        {wrong && <p className="error" role="alert">Incorrect password. Try again.</p>}
        <label>PDF password<input ref={input} type="password" name="password" required autoComplete="off" aria-describedby={hint} /></label>
        <small id={hint}>Used on this device to read this file. The password is never saved.</small>
      </div>
      <div className="dialog-actions"><button type="button" onClick={onSkip}>Skip file</button><button type="submit" className="primary">Unlock PDF</button></div>
    </form>
  </dialog>;
}
