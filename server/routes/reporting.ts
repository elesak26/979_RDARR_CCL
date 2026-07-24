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
        total_submitted_questions: string;
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
             (SELECT COUNT(*)
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
             (SELECT COUNT(DISTINCT bu_code) FROM question_applicability WHERE cycle_id = $1)     AS total_respondents,
             (SELECT COUNT(*)
              FROM (
                SELECT qa.question_id
                FROM question_applicability qa
                LEFT JOIN responses r
                  ON r.cycle_id = qa.cycle_id AND r.question_id = qa.question_id AND r.bu_code = qa.bu_code
                WHERE qa.cycle_id = $1
                GROUP BY qa.question_id
                HAVING COUNT(DISTINCT qa.bu_code) = COUNT(DISTINCT CASE WHEN r.status = 'submitted' THEN r.bu_code END)
              ) fully_submitted)                                                                   AS total_submitted_questions`,
        [cycleId]
      );

      // ── Scores by thematic area ──────────────────────────────────────────────
      // Two-stage avg: first avg per question (flat over BU×material_risk rows),
      // then avg of those per-question scores per thematic area.
      // Overall = avg of per-area averages.
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
        `WITH per_question AS (
           SELECT
             r.question_id,
             q.thematic_area,
             AVG(r.compliance_score::numeric)   AS compliance_score,
             AVG(v.validation_score::numeric)   AS validation_score
           FROM responses r
           JOIN questions q ON q.id = r.question_id
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
             AND (v.material_risk = r.material_risk OR (v.material_risk IS NULL AND r.material_risk IS NULL))
           WHERE r.cycle_id = $1 AND r.status = 'submitted'${byAreaBuFilter}
           GROUP BY r.question_id, q.thematic_area
         ),
         per_area AS (
           SELECT
             thematic_area,
             AVG(compliance_score)  AS avg_compliance_score,
             AVG(validation_score)  AS avg_validation_score,
             COUNT(*)               AS response_count
           FROM per_question
           GROUP BY thematic_area
         )
         SELECT thematic_area,
                ROUND(avg_compliance_score::numeric, 2) AS avg_compliance_score,
                ROUND(avg_compliance_score::numeric, 2) AS consolidated_compliance_score,
                ROUND(avg_validation_score::numeric, 2) AS avg_validation_score,
                response_count::bigint                  AS response_count
         FROM per_area
         UNION ALL
         SELECT '__overall__',
                ROUND(AVG(avg_compliance_score)::numeric, 2),
                ROUND(AVG(avg_compliance_score)::numeric, 2),
                ROUND(AVG(avg_validation_score)::numeric, 2),
                SUM(response_count)
         FROM per_area
         ORDER BY thematic_area`,
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
             SUM(v.validation_score * COALESCE(r.weight, 1.0))
               / NULLIF(SUM(CASE WHEN v.validation_score IS NOT NULL THEN COALESCE(r.weight, 1.0) ELSE 0 END), 0) AS validation_score
           FROM responses r
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
             AND (v.material_risk = r.material_risk OR (v.material_risk IS NULL AND r.material_risk IS NULL))
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
      // Two-stage avg: first avg per question (flat over BU×material_risk rows),
      // then avg of those per-question scores per principle. No overall row.
      const byBcbsResult = await query<{
        bcbs_principle_name: string | null;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
        sort_null: string;
        sort_num: string | null;
      }>(
        `WITH per_question AS (
           SELECT
             r.question_id,
             TRIM(s)                            AS bcbs_principle_name,
             MIN(q.bcbs_principle_number)       AS sort_num,
             AVG(r.compliance_score::numeric)   AS compliance_score,
             AVG(v.validation_score::numeric)   AS validation_score
           FROM responses r
           JOIN questions q ON q.id = r.question_id
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
             AND (v.material_risk = r.material_risk OR (v.material_risk IS NULL AND r.material_risk IS NULL))
           CROSS JOIN LATERAL unnest(string_to_array(q.bcbs_principle_name, '|')) AS s
           WHERE r.cycle_id = $1 AND r.status = 'submitted'
           GROUP BY r.question_id, TRIM(s)
         ),
         per_principle AS (
           SELECT
             bcbs_principle_name,
             AVG(compliance_score)  AS avg_compliance_score,
             AVG(validation_score)  AS avg_validation_score,
             COUNT(*)               AS response_count,
             MIN(sort_num)          AS sort_num
           FROM per_question
           GROUP BY bcbs_principle_name
         )
         SELECT bcbs_principle_name,
                ROUND(avg_compliance_score::numeric, 2) AS avg_compliance_score,
                ROUND(avg_validation_score::numeric, 2) AS avg_validation_score,
                response_count::bigint                  AS response_count,
                CASE WHEN sort_num IS NULL THEN 1 ELSE 0 END AS sort_null,
                sort_num
         FROM per_principle
         ORDER BY sort_null, sort_num, bcbs_principle_name`,
        [cycleId]
      );

      // ── Scores by BU (avg compliance_score per bu_code) ──────────────────
      // BUs 023 and 006-956 are split by material_risk so each material risk
      // appears as a separate row (same treatment as 961-Market/Liquidity/IRRBB).
      const byBuResult = await query<{
        bu_code: string;
        material_risk: string | null;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
        submitted_count: string;
        validated_count: string;
      }>(
        `WITH per_question_bu AS (
           SELECT
             r.bu_code,
             CASE WHEN r.bu_code IN ('023', '006-956') THEN r.material_risk ELSE NULL END AS material_risk,
             r.question_id,
             -- counts from responses only (no join fan-out)
             COUNT(r.id)                                                                     AS r_count,
             COUNT(CASE WHEN r.status = 'submitted' THEN r.id END)                          AS r_submitted,
             AVG(CASE WHEN r.status = 'submitted' THEN r.compliance_score::numeric END)       AS compliance_score
           FROM responses r
           WHERE r.cycle_id = $1
           GROUP BY r.bu_code,
                    CASE WHEN r.bu_code IN ('023', '006-956') THEN r.material_risk ELSE NULL END,
                    r.question_id
         ),
         per_question_val AS (
           SELECT
             v.bu_code,
             v.question_id,
             AVG(v.validation_score::numeric)                                        AS validation_score,
             MAX(CASE WHEN v.validation_score IS NOT NULL THEN 1 ELSE 0 END)       AS has_validation
           FROM validations v
           WHERE v.cycle_id = $1
           GROUP BY v.bu_code, v.question_id
         )
         SELECT
           p.bu_code,
           p.material_risk,
           ROUND(AVG(p.compliance_score)::numeric, 2)   AS avg_compliance_score,
           ROUND(AVG(pv.validation_score)::numeric, 2)  AS avg_validation_score,
           SUM(p.r_count)                               AS response_count,
           SUM(p.r_submitted)                           AS submitted_count,
           SUM(COALESCE(pv.has_validation, 0))          AS validated_count
         FROM per_question_bu p
         LEFT JOIN per_question_val pv ON pv.bu_code = p.bu_code AND pv.question_id = p.question_id
         GROUP BY p.bu_code, p.material_risk
         ORDER BY p.bu_code, p.material_risk NULLS FIRST`,
        [cycleId]
      );

      // ── Scores by material risk ──────────────────────────────────────────
      // Two-stage avg: first avg per question (flat over BU rows for that risk),
      // then avg of those per-question scores per risk category. No overall row.
      const byMaterialRiskResult = await query<{
        material_risk: string;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
      }>(
        `WITH per_question AS (
           SELECT
             r.question_id,
             CASE TRIM(r.material_risk) WHEN 'IRRBB' THEN 'IRRBB Risk' ELSE TRIM(r.material_risk) END AS material_risk,
             AVG(r.compliance_score::numeric)   AS compliance_score,
             AVG(v.validation_score::numeric)   AS validation_score
           FROM responses r
           LEFT JOIN validations v
             ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
             AND (v.material_risk = r.material_risk OR (v.material_risk IS NULL AND r.material_risk IS NULL))
           WHERE r.cycle_id = $1 AND r.status = 'submitted' AND r.material_risk IS NOT NULL
           GROUP BY r.question_id,
                    CASE TRIM(r.material_risk) WHEN 'IRRBB' THEN 'IRRBB Risk' ELSE TRIM(r.material_risk) END
         )
         SELECT material_risk,
                ROUND(AVG(compliance_score)::numeric, 2) AS avg_compliance_score,
                ROUND(AVG(validation_score)::numeric, 2) AS avg_validation_score,
                COUNT(*)::bigint                          AS response_count
         FROM per_question
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
          total_submitted_questions: parseInt(counts.total_submitted_questions ?? '0', 10),
        },
        scores_by_bcbs_principle: byBcbsResult.rows.map((r) => ({
            bcbs_principle_name:   r.bcbs_principle_name ?? null,
            avg_compliance_score:  r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
            avg_validation_score:  r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
            response_count:        parseInt(r.response_count, 10),
          })),
        scores_by_thematic_area: byAreaResult.rows
          .filter((r) => r.thematic_area !== '__overall__')
          .map((r) => ({
            thematic_area:                r.thematic_area,
            avg_compliance_score:         r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
            consolidated_compliance_score: r.consolidated_compliance_score != null ? parseFloat(r.consolidated_compliance_score) : null,
            avg_validation_score:         r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
            response_count:               parseInt(r.response_count, 10),
          })),
        scores_by_thematic_area_overall: (() => {
          const ov = byAreaResult.rows.find((r) => r.thematic_area === '__overall__');
          return ov ? {
            avg_compliance_score: ov.avg_compliance_score != null ? parseFloat(ov.avg_compliance_score) : null,
            avg_validation_score: ov.avg_validation_score != null ? parseFloat(ov.avg_validation_score) : null,
          } : null;
        })(),
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
          material_risk:        r.material_risk ?? null,
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

// GET /api/reporting/cycle/:cycleId/export/excel — download xlsx (all validations, any status)
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

      // ── Single sheet: one row per submitted response, LEFT JOIN validations for score ───
      const rows = await query<{
        bu_code: string;
        display_name: string;
        item_number: string;
        thematic_area: string;
        bcbs_principle_name: string | null;
        description: string;
        material_risk: string | null;
        self_assessment_score: string | null;
        validation_score: string | null;
      }>(
        `SELECT
           SPLIT_PART(r.bu_code, '-', 1)                                            AS bu_code,
           COALESCE(
             (SELECT display_name FROM users
              WHERE role = 'Responder' AND unit_codes ? SPLIT_PART(r.bu_code, '-', 1)
              LIMIT 1),
             SPLIT_PART(r.bu_code, '-', 1)
           )                                                                        AS display_name,
           q.item_number::text,
           q.thematic_area,
           q.bcbs_principle_name,
           q.requirement                                                            AS description,
           CASE TRIM(r.material_risk) WHEN 'IRRBB' THEN 'IRRBB Risk' ELSE TRIM(r.material_risk) END AS material_risk,
           r.compliance_score::text                                                 AS self_assessment_score,
           v.validation_score::text
         FROM responses r
         JOIN questions q ON q.id = r.question_id
         LEFT JOIN validations v
           ON v.cycle_id = r.cycle_id
          AND v.question_id = r.question_id
          AND v.bu_code = r.bu_code
          AND v.material_risk IS NOT DISTINCT FROM r.material_risk
         WHERE r.cycle_id = $1 AND r.status = 'submitted'
         ORDER BY r.bu_code, q.item_number::int, r.material_risk NULLS FIRST`,
        [cycleId]
      );

      // Build workbook
      const wb = XLSX.utils.book_new();

      const sheetData = [
        ['Respondent (BU Code)', 'Respondent Name', 'Item No.', 'Thematic Area', 'BCBS239 Principle', 'Description', 'Risk Category', 'Self Assessment Score', 'Validation Score'],
        ...rows.rows.map(r => [
          r.bu_code,
          r.display_name,
          r.item_number,
          r.thematic_area,
          r.bcbs_principle_name ?? '',
          r.description,
          r.material_risk ?? '',
          r.self_assessment_score != null ? parseFloat(r.self_assessment_score) : '',
          r.validation_score != null ? parseFloat(r.validation_score) : '',
        ]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      ws['!cols'] = [{ wch: 22 }, { wch: 34 }, { wch: 10 }, { wch: 30 }, { wch: 28 }, { wch: 60 }, { wch: 18 }, { wch: 22 }, { wch: 18 }];
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
