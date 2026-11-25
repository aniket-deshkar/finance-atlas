"use client";

import {useState, type FormEvent} from "react";
import {Icon} from "./icons";

export function GoogleMark() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
    <path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z" />
    <path fill="#34A853" d="M24 44c5.5 0 10.2-1.8 13.5-4.9l-6.6-5.1c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z" />
    <path fill="#FBBC05" d="M12.6 27.5a12 12 0 0 1 0-7v-5.3H5.8a20 20 0 0 0 0 17.6l6.8-5.3Z" />
    <path fill="#EA4335" d="M24 12.1c3 0 5.7 1 7.8 3l5.8-5.8A19.4 19.4 0 0 0 24 4 20 20 0 0 0 5.8 15.2l6.8 5.3c1.6-4.8 6.1-8.4 11.4-8.4Z" />
  </svg>;
}

type WelcomeProps = {
  checking: boolean;
  existing: boolean;
  remoteVault: boolean;
  connected: boolean;
  cloudAvailable: boolean;
  desktop: boolean;
  busy: boolean;
  error: string;
  connect: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
};

export function Welcome(props: WelcomeProps) {
  const {checking, existing, remoteVault, connected, cloudAvailable, desktop, busy, error, connect, submit} = props;
  const [revealed, setRevealed] = useState(false);
  const unlocking = existing || remoteVault;
  const title = checking ? "Open Finance Atlas" : remoteVault ? "Unlock your cloud workspace" : existing ? "Unlock your workspace" : "Create a workspace";
  const description = checking ? "Checking for an encrypted vault on this device." : unlocking
    ? "Enter your vault passphrase to open your accounts and transactions."
    : "Choose a vault passphrase to encrypt your accounts and transactions on this device.";
  return <main className="atlas-welcome">
    <section className="atlas-welcome-story" aria-label="Finance Atlas overview">
      <div className="atlas-welcome-brand"><span><Icon name="wallet" /></span>Finance Atlas</div>
      <div className="atlas-welcome-editorial">
        <h2>Your money,<br />in focus.</h2>
        <p>Track what you spend, what’s due, and what you’re saving in one private workspace.</p>
        <div className="atlas-welcome-art" aria-hidden="true">
          <div className="atlas-welcome-orbit" />
          <div className="atlas-welcome-mini atlas-welcome-mini-back"><Icon name="bank" /><span /><span /></div>
          <div className="atlas-welcome-mini atlas-welcome-mini-front"><Icon name="card" /><i /><span /><span /></div>
        </div>
      </div>
      <p className="atlas-welcome-security"><Icon name="shield" /> Encrypted on your device</p>
    </section>
    <section className="atlas-welcome-entry" aria-labelledby="atlas-welcome-title">
      <div className="atlas-welcome-brand atlas-welcome-mobile"><span><Icon name="wallet" /></span>Finance Atlas</div>
      <div className="atlas-welcome-card">
        <div className="atlas-welcome-lock"><Icon name="lock" /></div>
        <h1 id="atlas-welcome-title">{title}</h1>
        <p id="atlas-welcome-note">{description}</p>
        {checking ? <p role={error ? "alert" : "status"} className={error ? "error" : "muted"}>{error || "Checking local storage…"}</p> : <>
          {connected && !existing && <p className="atlas-welcome-connected" role="status"><GoogleMark /> Google connected</p>}
          <form onSubmit={submit} aria-describedby="atlas-welcome-note">
            <div className="atlas-welcome-field">
              <label htmlFor="vault-passphrase">Vault passphrase</label>
              <div className="atlas-welcome-password">
                <input id="vault-passphrase" name="passphrase" type={revealed ? "text" : "password"} required minLength={unlocking ? 1 : 12}
                  maxLength={128} autoComplete={unlocking ? "current-password" : "new-password"} aria-invalid={Boolean(error)}
                  aria-describedby={!unlocking ? "atlas-passphrase-hint" : undefined} spellCheck={false} disabled={busy} />
                <button type="button" aria-label={revealed ? "Hide passphrase" : "Show passphrase"} aria-pressed={revealed}
                  onClick={() => setRevealed(value => !value)}><Icon name="eye" /></button>
              </div>
              {!unlocking && <small id="atlas-passphrase-hint">Use at least 12 characters. Keep a copy somewhere safe.</small>}
            </div>
            {!unlocking && <div className="atlas-welcome-field"><label htmlFor="vault-confirm">Confirm passphrase</label>
              <input id="vault-confirm" name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" disabled={busy} /></div>}
            {error && <p className="error atlas-welcome-error" role="alert">{error}</p>}
            <button type="submit" className="primary atlas-welcome-submit" disabled={busy}>
              {busy ? "Working…" : unlocking ? "Unlock workspace" : "Create workspace"}<Icon name="right" />
            </button>
          </form>
          {cloudAvailable && !existing && !connected && <div className="atlas-welcome-cloud">
            <button type="button" disabled={busy} onClick={connect}><GoogleMark /> Continue with Google</button>
            <small>Connect optional cloud services or restore an existing cloud workspace.</small>
          </div>}
        </>}
        {desktop && <p className="atlas-welcome-desktop"><Icon name="shield" /> Finance Atlas for Windows</p>}
      </div>
    </section>
  </main>;
}
