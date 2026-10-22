import { test, expect } from "bun:test";

process.env.ORRY_DB_PATH = ":memory:";
const costReport = require("./costReport");
const db = require("./db");
db.open(":memory:");

const rows = () => [
  { operation: "answer", requests: 10, prompt_tokens: 20000, completion_tokens: 4000, cost_usd: 0.0056 },
  { operation: "intent", requests: 40, prompt_tokens: 12000, completion_tokens: 2000, cost_usd: 0.0024 },
];

test("digest names each operation with its cost and a total", () => {
  const text = costReport.costDigestText(rows());
  expect(text).toContain("answer 10 ($0.006)");
  expect(text).toContain("intent 40 ($0.002)");
  expect(text).toContain("total $0.008");
  expect(text).toContain("50 calls");
});

test("digest is falsy when nothing ran, so nothing is posted", () => {
  expect(costReport.costDigestText([])).toBeNull();
  expect(costReport.costDigestText([{ operation: "answer", requests: 0 }])).toBeNull();
});

test("digest rounds, never invents precision it does not have", () => {
  const text = costReport.costDigestText([
    { operation: "answer", requests: 1, prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.0000000152 },
  ]);
  expect(text).toContain("total $0.000");
});

test("date key is stable within a day", () => {
  expect(costReport.isCostReportDue(new Date("2026-10-07T01:00:00Z"))).toBe(
    costReport.isCostReportDue(new Date("2026-10-07T23:59:59Z")),
  );
});

test("a UTC daily report marker remains current around local midnight", () => {
  const oldTz = process.env.TZ;
  const at = new Date("2026-10-06T22:05:00Z");
  db.handle().query("DELETE FROM metrics").run();
  try {
    process.env.TZ = "Europe/Berlin";
    costReport.markCostReportSent("2026-10-06");
    expect(at.getDate()).toBe(7);
    expect(costReport.isCostReportDue(at)).toBe(false);
  } finally {
    if (oldTz === undefined) delete process.env.TZ;
    else process.env.TZ = oldTz;
  }
});

test("digest identifies calls with unknown prices instead of counting them as free", () => {
  const text = costReport.costDigestText([
    {
      operation: "answer",
      requests: 15,
      prompt_tokens: 3000,
      completion_tokens: 450,
      cost_usd: 0.0001,
      unknown_cost_requests: 5,
    },
  ]);
  expect(text).toContain("5 calls have unknown cost");
  expect(text).toContain("priced calls");
});
