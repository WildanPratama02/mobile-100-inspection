/** The source report of `import-master` as text: counts, PO numbers and row numbers, never a person's name. */
import type { ImportProblem, SourceReport } from './parse-master';

/** One line per problem of an invalid import: sheet, row and what is wrong (ids and codes, never a name). */
export function problemLines(problems: readonly ImportProblem[]): string[] {
  return problems.map(
    (p) => `  ${p.sheet}${p.line === undefined ? '' : ` row ${p.line}`}: ${p.message}`,
  );
}

export function reportLines(report: SourceReport): string[] {
  const lines: string[] = [];
  const out = (line = '') => lines.push(line);
  const { users, cells, defects, mapping, pos } = report;
  out();
  out(
    `USER_LIST      ${users.rows} rows, ${users.psiRows} PSI rows, ${users.unique} unique (name, level)`,
  );
  out(
    `DB_CELL        ${cells.rows} rows, ${cells.imported} cells in ${cells.factories.join(', ')}` +
      (cells.otherFactories.length ? `; not imported: ${cells.otherFactories.join(', ')}` : ''),
  );
  out(`DEFECT_LIST    ${defects.rows} defects`);
  out(
    `Mapping        ${mapping.areas} areas, ${mapping.subAreas} sub-areas, ${mapping.families} families, ` +
      `${mapping.mapRows} map rows`,
  );
  if (mapping.unmappedDefects.length) {
    out(`  warning: no map row offers ${mapping.unmappedDefects.join(', ')}`);
  }
  out(`ALL_PO_MASTER  ${pos.rows} non-empty rows`);
  out(`  identical duplicate rows merged   ${pos.duplicatesMerged}`);
  out(`  conflicting PO numbers skipped    ${pos.conflictGroups} (${pos.conflictRows} rows)`);
  out(`  other rows skipped                ${pos.otherSkippedRows}`);
  out(`  unique POs to import              ${pos.unique}`);
  out(`  unreadable PODD/CRD (kept empty)  ${pos.unreadableDates}`);
  for (const c of pos.conflicts) {
    out(`  conflict ${c.po}: rows ${c.lines.join(', ')} differ in ${c.columns.join(', ')}`);
  }
  for (const s of pos.skipped) out(`  skipped row ${s.line} (${s.reason}) ${s.po}`);
  return lines;
}
