/**
 * Test helper for the load and fault tests (T3.7): the figures a run reports (doc 03 §8 "p95 per submission
 * measured"), printed as a table and written as JSON to the system's temp folder.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attempt, SentItem } from './tablet-sim';

/** Nearest-rank percentile (`p` in 0–100) of `values`; `null` for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export interface Spread {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function spread(values: readonly number[]): Spread {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

export interface LoadReport {
  scenario: string;
  settings: Record<string, number>;
  submissions: { sent: number; failed: number };
  /** Answers by status (`200`, `201`, `503`, …; `none` without an answer) and by problem code. */
  answers: Record<string, number>;
  codes: Record<string, number>;
  /** First attempt to the `201`/`200`, per submission, in ms; includes waits for a resend. */
  perSubmissionMs: Spread;
  /** One request, answered `201`, in ms (client side). */
  writeRequestMs: Spread;
  /** `durationMs` of the API's `Submit PO` log lines answered `201` (server side, NFR-10). */
  serverWriteMs: Spread;
}

function tally(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = (out[key] ?? 0) + 1;
  return out;
}

export function summarise(input: {
  scenario: string;
  settings: Record<string, number>;
  items: readonly SentItem[];
  attempts: readonly Attempt[];
  serverWriteMs: readonly number[];
}): LoadReport {
  const sent = input.items.filter((i) => i.state === 'sent');
  return {
    scenario: input.scenario,
    settings: input.settings,
    submissions: { sent: sent.length, failed: input.items.length - sent.length },
    answers: tally(input.attempts.map((a) => (a.status === null ? 'none' : String(a.status)))),
    codes: tally(input.attempts.flatMap((a) => (a.code === undefined ? [] : [a.code]))),
    perSubmissionMs: spread(sent.map((i) => i.doneAt - i.firstAttemptAt)),
    writeRequestMs: spread(input.attempts.filter((a) => a.status === 201).map((a) => a.latencyMs)),
    serverWriteMs: spread(input.serverWriteMs),
  };
}

const ms = (value: number | null) => (value === null ? '—' : `${String(Math.round(value))} ms`);

export function formatReport(report: LoadReport): string {
  const row = (label: string, s: Spread) =>
    `  ${label.padEnd(28)} n=${String(s.count).padEnd(5)} p50 ${ms(s.p50).padEnd(10)} p95 ${ms(s.p95).padEnd(10)} max ${ms(s.max)}`;
  return [
    `T3.7 ${report.scenario}`,
    `  settings: ${JSON.stringify(report.settings)}`,
    `  submissions: ${String(report.submissions.sent)} sent, ${String(report.submissions.failed)} failed`,
    `  answers: ${JSON.stringify(report.answers)}  codes: ${JSON.stringify(report.codes)}`,
    row('per submission (to stored)', report.perSubmissionMs),
    row('write request (client)', report.writeRequestMs),
    row('write (API log durationMs)', report.serverWriteMs),
  ].join('\n');
}

/** Prints the report and writes it as JSON; returns the file's path. */
export function publishReport(report: LoadReport): string {
  const slug = report.scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const file = join(
    tmpdir(),
    `m100-load-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatReport(report)}\n  report: ${file}\n`);
  return file;
}
