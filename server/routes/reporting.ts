import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';
import * as XLSX from 'xlsx';

const router = Router();

// GET /api/reporting/cycle/:cycleId/summary
router.get(
  '/api/reporting/cycle/:cycleId/summary',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId } = req.params;
      const buCode = req.query.bu_code as string | undefined;

      // ── Cycle-level counts ───────────────────────────────────────────────
      const countsResult = await query<{
        total_questions: string;
        total_submitted: string;
        total_validated: string;
        total_closed: string;
        total_closed_questions: string;
        total_validations: string;
        total_actioned: string;
        total_qa_rows: string;
        total_respondents: string;
      }>(
        `WITH expected_bu AS (
             SELECT q.id AS question_id, COUNT(*) AS expected_bu_count
             FROM questions q
             JOIN ccl_item_weights w ON w.item_number = q.item_number
             GROUP BY q.id
           ),
           validated_questions AS (
             SELECT v.question_id
             FROM validations v
             JOIN expected_bu e ON e.question_id = v.question_id
             JOIN questions q   ON q.id = v.question_id
             JOIN ccl_item_weights w ON w.item_number = q.item_number AND w.bu_code = v.bu_code
             WHERE v.cycle_id = $1
             GROUP BY v.question_id, e.expected_bu_count
             HAVING
               COUNT(CASE WHEN v.status = 'pending_approval' THEN 1 END) > 0
               AND COUNT(CASE WHEN v.status NOT IN ('pending_approval','closed') THEN 1 END) = 0
               AND COUNT(DISTINCT v.bu_code) = e.expected_bu_count
           )
           SELECT
             (SELECT COUNT(DISTINCT question_id) FROM question_applicability WHERE cycle_id = $1)  AS total_questions,
             (SELECT COUNT(DISTINCT r.question_id)
              FROM responses r
              WHERE r.cycle_id = $1 AND r.status = 'submitted')                                   AS total_submitted,
             (SELECT COUNT(*) FROM validated_questions)                                            AS total_validated,
             (SELECT COUNT(DISTINCT question_id) FROM validations WHERE cycle_id = $1 AND status = 'closed') AS total_closed,
             (SELECT COUNT(DISTINCT qa.question_id)
              FROM question_applicability qa
              WHERE qa.cycle_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM question_applicability qa2
                LEFT JOIN validations v
                  ON v.cycle_id = qa2.cycle_id AND v.question_id = qa2.question_id AND v.bu_code = qa2.bu_code
                WHERE qa2.cycle_id = qa.cycle_id AND qa2.question_id = qa.question_id
                  AND (v.id IS NULL OR v.status <> 'closed')
              ))                                                                                    AS total_closed_questions,
             (SELECT COUNT(*) FROM validations WHERE cycle_id = $1)                               AS total_validations,
             (SELECT COUNT(*) FROM validations WHERE cycle_id = $1 AND status IN ('closed','rejected','returned')) AS total_actioned,
             (SELECT COUNT(*) FROM question_applicability WHERE cycle_id = $1)                    AS total_qa_rows,
             (SELECT COUNT(DISTINCT bu_code) FROM question_applicability WHERE cycle_id = $1)     AS total_respondents`,
        [cycleId]
      );

      // ── Scores by thematic area (avg compliance_score per area, optional BU filter) ──
      // Collapse to one row per (question, bu) first to avoid inflating the
      // validation_score average when a BU has multiple material-risk sub-responses
      // for the same question (each sub-response would otherwise fan-join to the
      // single validation row, counting it N times).
      const byAreaParams: unknown[] = [cycleId];
      const byAreaBuFilter = buCode ? ` AND r.bu_code = $2` : '';
      if (buCode) byAreaParams.push(buCode);
      const byAreaResult = await query<{
        thematic_area: string;
        avg_compliance_score: string;
        consolidated_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
      }>(
        `WITH per_question_bu AS (
           SELECT
             r.question_id,
             r.bu_code,
             AVG(CAST(r.compliance_score AS float))                                                                         AS compliance_score,
             SUM(r.compliance_score * COALESCE(r.weight, 1.0)) / NULLIF(SUM(COALESCE(r.weight, 1.0)), 0)   AS weighted_compliance_score,
             SUM(COALESCE(r.weight, 1.0))                                                                   AS total_weight,
             MAX(v.validation_score)                                                                         AS validation_score
           FROM responses r
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
           WHERE r.cycle_id = $1 AND r.status = 'submitted'${byAreaBuFilter}
           GROUP BY r.question_id, r.bu_code
         )
         SELECT
           q.thematic_area,
           ROUND(AVG(pqb.compliance_score)::numeric, 2)                                                                                                                                         AS avg_compliance_score,
           ROUND((SUM(pqb.weighted_compliance_score * pqb.total_weight) / NULLIF(SUM(pqb.total_weight), 0))::numeric, 2)                                                                          AS consolidated_compliance_score,
           ROUND((SUM(pqb.validation_score * pqb.total_weight) / NULLIF(SUM(CASE WHEN pqb.validation_score IS NOT NULL THEN pqb.total_weight ELSE 0 END), 0))::numeric, 2) AS avg_validation_score,
           COUNT(DISTINCT pqb.question_id)                                                                                                                                             AS response_count
         FROM per_question_bu pqb
         JOIN questions q ON q.id = pqb.question_id
         GROUP BY q.thematic_area
         ORDER BY q.thematic_area`,
        byAreaParams
      );

      // ── Scores by thematic area × BU (drill-down rows) ──────────────────
      const byAreaByBuResult = await query<{
        thematic_area: string;
        bu_code: string;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
      }>(
        `WITH per_question_bu AS (
           SELECT
             r.question_id,
             r.bu_code,
             SUM(r.compliance_score * COALESCE(r.weight, 1.0)) / NULLIF(SUM(COALESCE(r.weight, 1.0)), 0) AS compliance_score,
             SUM(COALESCE(r.weight, 1.0))                                                                   AS total_weight,
             MAX(v.validation_score)                                                                         AS validation_score
           FROM responses r
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
           WHERE r.cycle_id = $1 AND r.status = 'submitted'
           GROUP BY r.question_id, r.bu_code
         )
         SELECT
           q.thematic_area,
           pqb.bu_code,
           ROUND((SUM(pqb.compliance_score * pqb.total_weight) / NULLIF(SUM(pqb.total_weight), 0))::numeric, 2)                                                                                  AS avg_compliance_score,
           ROUND((SUM(pqb.validation_score * pqb.total_weight) / NULLIF(SUM(CASE WHEN pqb.validation_score IS NOT NULL THEN pqb.total_weight ELSE 0 END), 0))::numeric, 2) AS avg_validation_score,
           COUNT(DISTINCT pqb.question_id)                                                                                                                                             AS response_count
         FROM per_question_bu pqb
         JOIN questions q ON q.id = pqb.question_id
         GROUP BY q.thematic_area, pqb.bu_code
         ORDER BY q.thematic_area, pqb.bu_code`,
        [cycleId]
      );

      // ── Scores by BCBS 239 Principle ─────────────────────────────────────
      // Questions that belong to multiple principles (separated by ' | ') are
      // unnested so each principle receives its own averaged score row.
      const byBcbsResult = await query<{
        bcbs_principle_name: string | null;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
      }>(
        `WITH per_question_bu AS (
           SELECT
             r.question_id,
             r.bu_code,
             SUM(r.compliance_score * COALESCE(r.weight, 1.0)) / NULLIF(SUM(COALESCE(r.weight, 1.0)), 0) AS compliance_score,
             SUM(COALESCE(r.weight, 1.0))                                                                   AS total_weight,
             MAX(v.validation_score)                                                                         AS validation_score
           FROM responses r
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
           WHERE r.cycle_id = $1 AND r.status = 'submitted'
           GROUP BY r.question_id, r.bu_code
         )
         SELECT
           TRIM(s)                                                                                                                                                                          AS bcbs_principle_name,
           ROUND((SUM(pqb.compliance_score * pqb.total_weight) / NULLIF(SUM(pqb.total_weight), 0))::numeric, 2)                                                                          AS avg_compliance_score,
           ROUND((SUM(pqb.validation_score * pqb.total_weight) / NULLIF(SUM(CASE WHEN pqb.validation_score IS NOT NULL THEN pqb.total_weight ELSE 0 END), 0))::numeric, 2)             AS avg_validation_score,
           COUNT(pqb.question_id)                                                                                                                                                          AS response_count
         FROM per_question_bu pqb
         JOIN questions q ON q.id = pqb.question_id
         CROSS JOIN LATERAL unnest(string_to_array(q.bcbs_principle_name, '|')) AS s
         GROUP BY TRIM(s)
         ORDER BY CASE WHEN MIN(q.bcbs_principle_number) IS NULL THEN 1 ELSE 0 END, MIN(q.bcbs_principle_number), TRIM(s)`,
        [cycleId]
      );

      // ── Scores by BU (avg compliance_score per bu_code) ──────────────────
      const byBuResult = await query<{
        bu_code: string;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
        submitted_count: string;
        validated_count: string;
      }>(
        `WITH per_question_bu AS (
           SELECT
             r.bu_code,
             r.question_id,
             SUM(CASE WHEN r.status = 'submitted' THEN r.compliance_score * COALESCE(r.weight, 1.0) END)
               / NULLIF(SUM(CASE WHEN r.status = 'submitted' THEN COALESCE(r.weight, 1.0) END), 0) AS compliance_score,
             SUM(CASE WHEN r.status = 'submitted' THEN COALESCE(r.weight, 1.0) END)                AS comp_weight,
             MAX(v.validation_score)                                                             AS validation_score,
             COUNT(r.id)                                                                         AS r_count,
             COUNT(CASE WHEN r.status = 'submitted' THEN r.id END)                                  AS r_submitted,
             MAX(CASE WHEN v.validation_score IS NOT NULL THEN 1 ELSE 0 END) AS has_validation
           FROM responses r
           LEFT JOIN validations v ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
           WHERE r.cycle_id = $1
           GROUP BY r.bu_code, r.question_id
         )
         SELECT
           bu_code,
           ROUND((SUM(compliance_score * comp_weight) / NULLIF(SUM(comp_weight), 0))::numeric, 2)                                                                                   AS avg_compliance_score,
           ROUND((SUM(validation_score * comp_weight) / NULLIF(SUM(CASE WHEN validation_score IS NOT NULL THEN comp_weight ELSE 0 END), 0))::numeric, 2) AS avg_validation_score,
           SUM(r_count)                                                                                                                                                   AS response_count,
           SUM(r_submitted)                                                                                                                                               AS submitted_count,
           SUM(has_validation)                                                                                                                                            AS validated_count
         FROM per_question_bu
         GROUP BY bu_code
         ORDER BY bu_code`,
        [cycleId]
      );

      // ── Scores by material risk ──────────────────────────────────────────
      const byMaterialRiskResult = await query<{
        material_risk: string;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
      }>(
        `WITH per_question_bu AS (
           SELECT
             CASE TRIM(r.material_risk)
               WHEN 'IRRBB' THEN 'IRRBB Risk'
               ELSE TRIM(r.material_risk)
             END AS material_risk,
             r.question_id,
             r.bu_code,
             SUM(r.compliance_score * COALESCE(r.weight, 1.0)) / NULLIF(SUM(COALESCE(r.weight, 1.0)), 0) AS compliance_score,
             SUM(COALESCE(r.weight, 1.0))                                                                   AS total_weight,
             MAX(v.validation_score)                                                                         AS validation_score
           FROM responses r
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
           WHERE r.cycle_id = $1 AND r.status = 'submitted' AND r.material_risk IS NOT NULL
           GROUP BY CASE TRIM(r.material_risk) WHEN 'IRRBB' THEN 'IRRBB Risk' ELSE TRIM(r.material_risk) END, r.question_id, r.bu_code
         )
         SELECT
           material_risk,
           ROUND((SUM(compliance_score * total_weight) / NULLIF(SUM(total_weight), 0))::numeric, 2)                                                                                      AS avg_compliance_score,
           ROUND((SUM(validation_score * total_weight) / NULLIF(SUM(CASE WHEN validation_score IS NOT NULL THEN total_weight ELSE 0 END), 0))::numeric, 2) AS avg_validation_score,
           COUNT(DISTINCT question_id)                                                                                                                                         AS response_count
         FROM per_question_bu
         GROUP BY material_risk
         ORDER BY material_risk`,
        [cycleId]
      );

      // ── Validation vs compliance score comparison (per question) ─────────
      const comparisonResult = await query<{
        question_id: number;
        item_number: number;
        thematic_area: string;
        avg_compliance_score: string;
        validation_score: string | null;
        validation_status: string;
      }>(
        `SELECT
           v.question_id,
           q.item_number,
           q.thematic_area,
           ROUND((SUM(r.compliance_score * COALESCE(r.weight, 1.0)) / NULLIF(SUM(COALESCE(r.weight, 1.0)), 0))::numeric, 2) AS avg_compliance_score,
           v.validation_score                                                                                       AS validation_score,
           v.status                                                                                                        AS validation_status
         FROM validations v
         JOIN questions q ON q.id = v.question_id
         LEFT JOIN responses r ON r.cycle_id = v.cycle_id AND r.question_id = v.question_id AND r.bu_code = v.bu_code AND r.status = 'submitted'
         WHERE v.cycle_id = $1
         GROUP BY v.question_id, q.item_number, q.thematic_area, v.validation_score, v.status
         ORDER BY q.item_number`,
        [cycleId]
      );

      const counts = countsResult.rows[0] ?? {};

      res.json({
        cycle_id: parseInt(String(cycleId), 10),
        counts: {
          total_questions:        parseInt(counts.total_questions        ?? '0', 10),
          total_submitted:        parseInt(counts.total_submitted        ?? '0', 10),
          total_validated:        parseInt(counts.total_validated        ?? '0', 10),
          total_closed:           parseInt(counts.total_closed           ?? '0', 10),
          total_closed_questions: parseInt(counts.total_closed_questions ?? '0', 10),
          total_validations:      parseInt(counts.total_validations      ?? '0', 10),
          total_actioned:         parseInt(counts.total_actioned         ?? '0', 10),
          total_qa_rows:          parseInt(counts.total_qa_rows          ?? '0', 10),
          total_respondents:      parseInt(counts.total_respondents      ?? '0', 10),
        },
        scores_by_bcbs_principle: byBcbsResult.rows.map((r) => ({
          bcbs_principle_name:   r.bcbs_principle_name ?? null,
          avg_compliance_score:  r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          avg_validation_score:  r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
          response_count:        parseInt(r.response_count, 10),
        })),
        scores_by_thematic_area: byAreaResult.rows.map((r) => ({
          thematic_area:                r.thematic_area,
          avg_compliance_score:         r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          consolidated_compliance_score: r.consolidated_compliance_score != null ? parseFloat(r.consolidated_compliance_score) : null,
          avg_validation_score:         r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
          response_count:               parseInt(r.response_count, 10),
        })),
        scores_by_material_risk: byMaterialRiskResult.rows.map((r) => ({
          material_risk:        r.material_risk,
          avg_compliance_score: r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          avg_validation_score: r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
          response_count:       parseInt(r.response_count, 10),
        })),
        scores_by_thematic_area_by_bu: byAreaByBuResult.rows.map((r) => ({
          thematic_area:        r.thematic_area,
          bu_code:              r.bu_code,
          avg_compliance_score: r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          avg_validation_score: r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
          response_count:       parseInt(r.response_count, 10),
        })),
        scores_by_bu: byBuResult.rows.map((r) => ({
          bu_code:              r.bu_code,
          avg_compliance_score: r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          avg_validation_score: r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
          response_count:       parseInt(r.response_count, 10),
          submitted_count:      parseInt(r.submitted_count, 10),
          validated_count:      parseInt(r.validated_count ?? '0', 10),
        })),
        validation_vs_compliance: comparisonResult.rows.map((r) => ({
          question_id:          r.question_id,
          item_number:          r.item_number,
          thematic_area:        r.thematic_area,
          avg_compliance_score: r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          validation_score:     r.validation_score != null ? parseFloat(r.validation_score) : null,
          validation_status:    r.validation_status,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/reporting/cycle/:cycleId/export/excel — download xlsx for a closed cycle
router.get(
  '/api/reporting/cycle/:cycleId/export/excel',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { cycleId } = req.params;

      // Fetch cycle name + year for the filename
      const cycleRow = await query<{ name: string; year: string; status: string }>(
        `SELECT name, year, status FROM questionnaire_cycles WHERE id = $1`,
        [cycleId]
      );
      if (!cycleRow.rows.length) {
        res.status(404).json({ error: 'Cycle not found' });
        return;
      }
      const cycle = cycleRow.rows[0];

      // ── Single sheet: one row per closed validation (question × BU × material_risk) ───
      const rows = await query<{
        bu_code: string;
        display_name: string;
        item_number: string;
        thematic_area: string;
        bcbs_principle_name: string | null;
        description: string;
        material_risk: string | null;
        validation_score: string | null;
      }>(
        `SELECT
           v.bu_code,
           COALESCE(
             (SELECT display_name FROM users
              WHERE role = 'Responder' AND unit_codes ? v.bu_code
              LIMIT 1),
             v.bu_code
           )                                                                        AS display_name,
           q.item_number::text,
           q.thematic_area,
           q.bcbs_principle_name,
           q.requirement                                                            AS description,
           CASE TRIM(v.material_risk) WHEN 'IRRBB' THEN 'IRRBB Risk' ELSE TRIM(v.material_risk) END AS material_risk,
           v.validation_score::text
         FROM validations v
         JOIN questions q ON q.id = v.question_id
         WHERE v.cycle_id = $1 AND v.status = 'closed'
         ORDER BY v.bu_code, q.item_number::int, v.material_risk NULLS FIRST`,
        [cycleId]
      );

      const SCORE_LABEL: Record<number, string> = {
        1: 'Non-compliant',
        2: 'Partially compliant',
        3: 'Largely compliant',
        4: 'Fully compliant',
      };
      const scoreLabel = (v: string | null): string => {
        if (v === null || v === undefined || v === '') return '';
        const n = parseFloat(v);
        return isNaN(n) ? v : `${SCORE_LABEL[Math.round(n)] ?? n}`;
      };

      // Build workbook
      const wb = XLSX.utils.book_new();

      const sheetData = [
        ['Respondent (BU Code)', 'Respondent Name', 'Item No.', 'Thematic Area', 'BCBS239 Principle', 'Description', 'Material Risk', 'Validation Score', 'Score Label'],
        ...rows.rows.map(r => [
          r.bu_code,
          r.display_name,
          r.item_number,
          r.thematic_area,
          r.bcbs_principle_name ?? '',
          r.description,
          r.material_risk ?? '',
          r.validation_score != null ? parseFloat(r.validation_score) : '',
          scoreLabel(r.validation_score),
        ]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws['!cols'] = [{ wch: 22 }, { wch: 34 }, { wch: 10 }, { wch: 30 }, { wch: 28 }, { wch: 60 }, { wch: 20 }, { wch: 18 }, { wch: 22 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Validation Scores');

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      const safeName = cycle.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="CCL_Validation_Scores_${safeName}_${cycle.year}.xlsx"`);
      res.send(buf);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/reporting/admin/analytics — cross-cycle analytics (Admin only)
router.get(
  '/api/reporting/admin/analytics',
  async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'Admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const yearParam = req.query.year ? parseInt(String(req.query.year), 10) : null;
      const yearFilter = yearParam ? ` AND qc.year = ${yearParam}` : '';
      const yearFilterSimple = yearParam ? ` AND year = ${yearParam}` : '';

      const [
        trendsResult,
        buResult,
        monthlyResult,
        scoreDistResult,
        cycleStatusResult,
        userActivityResult,
      ] = await Promise.all([
        // a. Performance trends — closed cycles
        query<{
          id: string; name: string; year: string;
          distributed_at: string | null; closed_at: string | null;
          avg_val_score: string | null; avg_comp_score: string | null;
          closed_validations: string; submitted_responses: string;
          cycle_duration_days: string | null; bu_count: string;
        }>(
          `SELECT
             qc.id, qc.name, qc.year,
             qc.distributed_at, qc.closed_at,
             ROUND(AVG(CASE WHEN v.validation_score IS NOT NULL THEN CAST(v.validation_score AS float) END)::numeric, 2)                                                                                                          AS avg_val_score,
             ROUND((SUM(CASE WHEN r.compliance_score IS NOT NULL THEN r.compliance_score * COALESCE(r.weight, 1.0) END) / NULLIF(SUM(CASE WHEN r.compliance_score IS NOT NULL THEN COALESCE(r.weight, 1.0) END), 0))::numeric, 2) AS avg_comp_score,
             COUNT(DISTINCT CASE WHEN v.status = 'closed' THEN v.id END)                        AS closed_validations,
             COUNT(DISTINCT CASE WHEN r.status = 'submitted' THEN r.id END)                     AS submitted_responses,
             ROUND(EXTRACT(EPOCH FROM (qc.closed_at - qc.distributed_at)) / 86400.0, 1)       AS cycle_duration_days,
             COUNT(DISTINCT r.bu_code)                                                       AS bu_count
           FROM questionnaire_cycles qc
           LEFT JOIN validations v ON v.cycle_id = qc.id
           LEFT JOIN responses r ON r.cycle_id = qc.id
           WHERE qc.status = 'closed'${yearFilter}
           GROUP BY qc.id, qc.name, qc.year, qc.distributed_at, qc.closed_at
           ORDER BY CASE WHEN qc.distributed_at IS NULL THEN 1 ELSE 0 END, qc.distributed_at, qc.id`
        ),

        // b. BU productivity across closed cycles (filtered by year)
        query<{
          bu_code: string; total_assigned: string; submitted: string;
          submission_pct: string | null; avg_score: string | null;
        }>(
          `SELECT
             r.bu_code,
             COUNT(*)                                                                               AS total_assigned,
             COUNT(CASE WHEN r.status = 'submitted' THEN 1 END)                                        AS submitted,
             ROUND((CAST(COUNT(CASE WHEN r.status = 'submitted' THEN 1 END) AS float) / NULLIF(COUNT(*), 0) * 100)::numeric, 1) AS submission_pct,
             ROUND((SUM(CASE WHEN r.compliance_score IS NOT NULL THEN r.compliance_score * COALESCE(r.weight, 1.0) END) / NULLIF(SUM(CASE WHEN r.compliance_score IS NOT NULL THEN COALESCE(r.weight, 1.0) END), 0))::numeric, 2) AS avg_score
           FROM responses r
           JOIN questionnaire_cycles qc ON qc.id = r.cycle_id
           WHERE qc.status = 'closed'${yearFilter}
           GROUP BY r.bu_code
           ORDER BY ROUND((CAST(COUNT(CASE WHEN r.status = 'submitted' THEN 1 END) AS float) / NULLIF(COUNT(*), 0) * 100)::numeric, 1) DESC`
        ),

        // c. Monthly submissions (filtered by year)
        query<{ month: string; submitted_count: string; avg_score: string | null }>(
          `SELECT
             TO_CHAR(submitted_at, 'YYYY-MM') AS month,
             COUNT(*)                                          AS submitted_count,
             ROUND(AVG(CAST(compliance_score AS float))::numeric, 2) AS avg_score
           FROM responses
           WHERE status = 'submitted' AND submitted_at IS NOT NULL${yearParam ? ` AND EXTRACT(YEAR FROM submitted_at) = ${yearParam}` : ''}
           GROUP BY TO_CHAR(submitted_at, 'YYYY-MM')
           ORDER BY TO_CHAR(submitted_at, 'YYYY-MM')`
        ),

        // d. Validation score distribution (filtered by year)
        query<{ validation_score: string; count: string }>(
          `SELECT v.validation_score, COUNT(*) AS count
           FROM validations v
           JOIN questionnaire_cycles qc ON qc.id = v.cycle_id
           WHERE v.status = 'closed' AND v.validation_score IS NOT NULL${yearFilter}
           GROUP BY v.validation_score ORDER BY v.validation_score`
        ),

        // e. Cycle status distribution (filtered by year)
        query<{ status: string; count: string }>(
          `SELECT status, COUNT(*) AS count FROM questionnaire_cycles WHERE 1=1${yearFilterSimple} GROUP BY status`
        ),

        // f. User activity by role
        query<{
          role: string; user_count: string;
          total_logins: string; active_users: string;
        }>(
          `SELECT
             u.role,
             COUNT(DISTINCT u.id)                                         AS user_count,
             COUNT(lh.id)                                                 AS total_logins,
             COUNT(DISTINCT lh.user_id)                                   AS active_users
           FROM users u
           LEFT JOIN login_history lh ON lh.user_id = u.id
           GROUP BY u.role
           ORDER BY u.role`
        ),
      ]);

      // g. Forecasting — simple linear regression on avg_val_score and avg_comp_score across closed cycles
      const trends = trendsResult.rows;
      function linearRegression(ys: number[]): { slope: number; intercept: number; r2: number } {
        const n = ys.length;
        if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
        const xs = ys.map((_, i) => i);
        const xMean = xs.reduce((a, b) => a + b, 0) / n;
        const yMean = ys.reduce((a, b) => a + b, 0) / n;
        const ssXX = xs.reduce((a, x) => a + (x - xMean) ** 2, 0);
        const ssXY = xs.reduce((a, x, i) => a + (x - xMean) * (ys[i] - yMean), 0);
        const slope = ssXX === 0 ? 0 : ssXY / ssXX;
        const intercept = yMean - slope * xMean;
        const ssRes = ys.reduce((a, y, i) => a + (y - (slope * i + intercept)) ** 2, 0);
        const ssTot = ys.reduce((a, y) => a + (y - yMean) ** 2, 0);
        const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
        return { slope, intercept, r2 };
      }

      const valScores  = trends.map(r => r.avg_val_score  ? parseFloat(r.avg_val_score)  : null).filter((v): v is number => v !== null);
      const compScores = trends.map(r => r.avg_comp_score ? parseFloat(r.avg_comp_score) : null).filter((v): v is number => v !== null);
      const valReg  = linearRegression(valScores);
      const compReg = linearRegression(compScores);
      const nextIdx = trends.length;
      const forecasting = {
        next_cycle_est_val:  Math.max(1, Math.min(4, parseFloat((valReg.slope  * nextIdx + valReg.intercept).toFixed(2)))),
        next_cycle_est_comp: Math.max(1, Math.min(4, parseFloat((compReg.slope * nextIdx + compReg.intercept).toFixed(2)))),
        r_squared_val:  parseFloat(valReg.r2.toFixed(3)),
        r_squared_comp: parseFloat(compReg.r2.toFixed(3)),
        data_points: trends.length,
      };

      res.json({
        performance_trends: trends.map(r => ({
          id:                  parseInt(r.id, 10),
          name:                r.name,
          year:                parseInt(r.year, 10),
          distributed_at:      r.distributed_at,
          closed_at:           r.closed_at,
          avg_val_score:       r.avg_val_score   ? parseFloat(r.avg_val_score)   : null,
          avg_comp_score:      r.avg_comp_score  ? parseFloat(r.avg_comp_score)  : null,
          closed_validations:  parseInt(r.closed_validations, 10),
          submitted_responses: parseInt(r.submitted_responses, 10),

          // Guard on != null so a same-day cycle renders 0.0 instead of null.
          cycle_duration_days: r.cycle_duration_days != null ? parseFloat(r.cycle_duration_days) : null,
          bu_count:            parseInt(r.bu_count, 10),
        })),
        bu_productivity: buResult.rows.map(r => ({
          bu_code:        r.bu_code,
          total_assigned: parseInt(r.total_assigned, 10),
          submitted:      parseInt(r.submitted, 10),
          submission_pct: r.submission_pct ? parseFloat(r.submission_pct) : 0,
          avg_score:      r.avg_score      ? parseFloat(r.avg_score)      : null,
        })),
        monthly_activity: monthlyResult.rows.map(r => ({
          month:           r.month,
          submitted_count: parseInt(r.submitted_count, 10),
          avg_score:       r.avg_score ? parseFloat(r.avg_score) : null,
        })),
        score_distribution: scoreDistResult.rows.map(r => ({
          score: parseInt(r.validation_score, 10),
          count: parseInt(r.count, 10),
        })),
        cycle_status: cycleStatusResult.rows.map(r => ({
          status: r.status,
          count:  parseInt(r.count, 10),
        })),
        user_activity: userActivityResult.rows.map(r => ({
          role:         r.role,
          user_count:   parseInt(r.user_count, 10),
          total_logins: parseInt(r.total_logins, 10),
          active_users: parseInt(r.active_users, 10),
        })),
        forecasting,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
