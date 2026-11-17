"use client";
import {useState} from "react";
import {checkedJson, cloudFetch, connectCloud, disconnectCloud, json} from "../../lib/cloud";

export default function ConnectDesktop() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function connect() {
    setBusy(true);setError("");
    try {
      const values = new URLSearchParams(location.hash.slice(1));
      const challenge = values.get("challenge") ?? "", state = values.get("state") ?? "", port = Number(values.get("port"));
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
          !Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Start desktop sign-in from your Finance Atlas app.");
      window.history.replaceState(null, "", location.pathname);
      const signal = AbortSignal.timeout(115_000);
      await connectCloud(signal);
      try {
        const {code} = await checkedJson<{code: string}>(await cloudFetch("/v1/auth/desktop/issue", json({challenge}, signal)));
        if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw Error("Invalid pairing response.");
        location.replace("http://127.0.0.1:" + port + "/atlas-callback?" + new URLSearchParams({code, state}));
      } finally {await disconnectCloud();}
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Sign-in could not finish.");
    } finally {setBusy(false);}
  }
  return <main className="panel"><h1>Connect Finance Atlas on Windows</h1>
    <p>Continue only if you just selected Connect to Google Cloud in your Windows app.</p>
    <button className="primary" type="button" disabled={busy} onClick={() => void connect()}>Continue with Google</button>
    {error && <p role="alert" className="error">{error}</p>}
  </main>;
}
