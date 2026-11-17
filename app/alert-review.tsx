"use client";
import {useState} from "react";
import {parseFinancialAlert, type AlertSuggestion} from "../lib/alert-parser";

export function AlertReview({useSuggestion}: {useSuggestion: (value: AlertSuggestion) => void}) {
  const [text, setText] = useState(""), [suggestion, setSuggestion] = useState<AlertSuggestion | null>(null), [error, setError] = useState("");
  return <details className="settings-disclosure"><summary>Paste a bank or card alert</summary>
    <p className="muted">Review one alert locally. Do not include OTPs, PINs, passwords or links. The message is not saved or sent anywhere.</p>
    <label>Alert text<textarea value={text} maxLength={8000} rows={4} onChange={event => {setText(event.target.value);setSuggestion(null);setError("");}} /></label>
    <div className="button-row section-gap"><button type="button" onClick={() => {
      try {setSuggestion(parseFinancialAlert(text));setError("");}
      catch (problem) {setSuggestion(null);setError(problem instanceof Error ? problem.message : "Could not review this alert.");}
    }}>Review alert</button><button type="button" onClick={() => {setText("");setSuggestion(null);setError("");}}>Clear</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {suggestion && <div className="editor-note"><strong>Suggested fields</strong><p>{suggestion.type || "Type not identified"} · {suggestion.amount ? "₹" + suggestion.amount : "Amount not identified"} · {suggestion.date || "Date not identified"}{suggestion.accountHint && " · Account ending " + suggestion.accountHint}</p>
      <ul>{suggestion.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      {suggestion.uncertainStatus && <p>Suggestions cannot be applied for a pending, failed, reversed or due notice. Confirm the actual transaction first.</p>}
      <button type="button" disabled={suggestion.uncertainStatus} onClick={() => {useSuggestion(suggestion);setText("");setSuggestion(null);}}>Use these suggestions</button></div>}
  </details>;
}
