import {test} from "node:test";
import assert from "node:assert/strict";
import {parseFinancialAlert} from "../lib/alert-parser.ts";

test("local alert review extracts a purchase but excludes the available balance", () => {
  const result = parseFinancialAlert("INR 1,234.50 debited from A/c XX1234 on 10-11-2026. Available balance INR 9,000.00");
  assert.equal(result.type, "expense");
  assert.equal(result.amount, "1234.50");
  assert.equal(result.date, "2026-11-10");
  assert.equal(result.accountHint, "1234");
  assert.equal(result.uncertainStatus, false);
  assert.equal(JSON.stringify(result).includes("9,000"), false);
});

test("ambiguous alerts need review and notices cannot be applied as cleared transactions", () => {
  const ambiguous = parseFinancialAlert("Rs 200 credited and Rs 200 debited on 10 Nov 2026");
  assert.equal(ambiguous.type, "");
  assert.equal(ambiguous.amount, "");
  assert.equal(parseFinancialAlert("Payment of Rs 500 due 10/11/2026").uncertainStatus, true);
  assert.equal(parseFinancialAlert("Rs 500 debited on 10/11/2026 but reversed").uncertainStatus, true);
  assert.throws(() => parseFinancialAlert("Your OTP is 123456"), /OTP/);
  assert.throws(() => parseFinancialAlert("Rs 500 debited https://example.com"), /links/);
});
