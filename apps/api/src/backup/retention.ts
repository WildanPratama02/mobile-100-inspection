/**
 * Which backups to keep (doc 03 §7.6): the nightly ones 14 daily and 12 monthly, the ones taken before an upgrade
 * the last 5. A backup is a folder named by its start time in WIB, `yyyy-MM-dd_HHmmss`, so names sort by time.
 */

export const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

export interface RetentionRule {
  /** The newest backup of each of this many most recent days. */
  daily?: number;
  /** The newest backup of each of this many most recent months. */
  monthly?: number;
  /** This many newest backups, whatever their dates. */
  latest?: number;
}

export const NIGHTLY_RETENTION: RetentionRule = { daily: 14, monthly: 12 };
export const PRE_UPGRADE_RETENTION: RetentionRule = { latest: 5 };

/** The folder name of a backup started at `at`, in WIB. */
export function backupName(at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}${parts.second}`;
}

/** The names `rule` does not keep. Names that are not backup names are never returned, so never deleted. */
export function backupsToDelete(names: readonly string[], rule: RetentionRule): string[] {
  const backups = names.filter((n) => BACKUP_NAME.test(n)).sort((a, b) => b.localeCompare(a));
  const keep = new Set(backups.slice(0, rule.latest ?? 0));
  const newestPer = (length: number, count: number) => {
    const seen = new Set<string>();
    for (const name of backups) {
      const period = name.slice(0, length);
      if (seen.has(period)) continue;
      if (seen.size === count) break;
      seen.add(period);
      keep.add(name);
    }
  };
  newestPer('yyyy-MM-dd'.length, rule.daily ?? 0);
  newestPer('yyyy-MM'.length, rule.monthly ?? 0);
  return backups.filter((n) => !keep.has(n));
}
