/**
 * Unit tests for the load sim's submission builder (`psiSubmission`): the submissions the load and fault tests
 * (T3.7, T7.8) send in bulk must be well-formed before a run starts — findings and photos one to one, unique
 * parts, JPEG bytes that match their `sha256`, timestamps that parse. Cheap compared to a load run.
 */
import type { SubmissionRequest } from '@m100/shared';
import { sha256Hex } from '../submissions/multipart';
import { psiSubmission } from './tablet-sim';

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

describe("psiSubmission (T7.8, the load and fault tests' builder)", () => {
  it('emits 15 findings with 15 photos when asked for 15 (the LOAD_PHOTOS default)', () => {
    const item = psiSubmission(300, 15);
    const body = JSON.parse(item.json) as SubmissionRequest;

    expect(body.user).toEqual({ username: 'TEST BUDI', level: 'PSI lv.2' });
    expect(body.findings).toHaveLength(15);
    expect(body.photos).toHaveLength(15);
    expect(item.photos).toHaveLength(15);

    // One finding per defect, each photographed at most once, and every photo's defect has its finding.
    const defectIds = body.findings.map((f) => f.defectId);
    expect(new Set(defectIds).size).toBe(15);
    for (const photo of body.photos) {
      expect(defectIds).toContain(photo.defectId);
      expect(photo.part).toBe(`photo_${String(photo.defectId)}`);
    }

    // Every timestamp parses (the build of T7.8 fixed `13:00:0${i + 1}` for i beyond 8).
    for (const finding of body.findings) {
      expect(Number.isFinite(Date.parse(finding.firstRecordedAt))).toBe(true);
    }
    expect(body.findings.at(-1)!.firstRecordedAt).toBe('2026-10-16T13:00:15.250+07:00');
  });

  it('every photo part is a JPEG whose bytes hash to its entry and appears once', () => {
    const item = psiSubmission(300, 15);
    const body = JSON.parse(item.json) as SubmissionRequest;
    const byPart = new Map(item.photos.map((p) => [p.part, p.jpeg]));

    expect(new Set(byPart.keys()).size).toBe(15);
    for (const photo of body.photos) {
      const jpeg = byPart.get(photo.part)!;
      expect(jpeg.subarray(0, JPEG_SIGNATURE.length)).toEqual(JPEG_SIGNATURE);
      expect(sha256Hex(jpeg)).toBe(photo.sha256);
    }
  });

  it('defaults to the old five-findings, five-photos shape (T3.7)', () => {
    const item = psiSubmission(200);
    const body = JSON.parse(item.json) as SubmissionRequest;
    expect(body.findings).toHaveLength(5);
    expect(body.photos).toHaveLength(5);
    expect(item.photos).toHaveLength(5);
    expect((JSON.parse(item.json) as { counts: { rework: number } }).counts.rework).toBe(10);
  });
});
