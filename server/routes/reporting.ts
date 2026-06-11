import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../db';

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
        total_respondents: string;
      }>(
        `SELECT
           (SELECT COUNT(DISTINCT question_id) FROM question_applicability WHERE cycle_id = $1)::text AS total_questions,
           (SELECT COUNT(DISTINCT question_id) FROM validations WHERE cycle_id = $1)::text            AS total_submitted,
           COUNT(v.id) FILTER (WHERE v.status IN ('in_review','pending_approval'))::text              AS total_validated,
           COUNT(v.id) FILTER (WHERE v.status = 'closed')::text                                      AS total_closed,
           (SELECT COUNT(DISTINCT bu_code) FROM question_applicability WHERE cycle_id = $1)::text    AS total_respondents
         FROM validations v
         WHERE v.cycle_id = $1`,
        [cycleId]
      );

      // ── Scores by thematic area (avg compliance_score per area, optional BU filter) ──
      const byAreaParams: unknown[] = [cycleId];
      const byAreaBuFilter = buCode ? ` AND r.bu_code = $2` : '';
      if (buCode) byAreaParams.push(buCode);
      const byAreaResult = await query<{
        thematic_area: string;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
      }>(
        `SELECT
           q.thematic_area,
           ROUND(AVG(r.compliance_score), 2)::text  AS avg_compliance_score,
           ROUND(AVG(v.validation_score), 2)::text  AS avg_validation_score,
           COUNT(DISTINCT q.id)::text               AS response_count
         FROM responses r
         JOIN questions q ON q.id = r.question_id
         LEFT JOIN validations v ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
         WHERE r.cycle_id = $1 AND r.status = 'submitted'${byAreaBuFilter}
         GROUP BY q.thematic_area
         ORDER BY q.thematic_area`,
        byAreaParams
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
        `SELECT
           TRIM(principle)                          AS bcbs_principle_name,
           ROUND(AVG(r.compliance_score), 2)::text  AS avg_compliance_score,
           ROUND(AVG(v.validation_score), 2)::text  AS avg_validation_score,
           COUNT(r.id)::text                        AS response_count
         FROM responses r
         JOIN questions q ON q.id = r.question_id
         LEFT JOIN validations v ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
         CROSS JOIN LATERAL unnest(string_to_array(q.bcbs_principle_name, ' | ')) AS principle
         WHERE r.cycle_id = $1 AND r.status = 'submitted'
         GROUP BY TRIM(principle)
         ORDER BY MIN(q.bcbs_principle_number) NULLS LAST, TRIM(principle)`,
        [cycleId]
      );

      // ── Scores by BU (avg compliance_score per bu_code) ──────────────────
      const byBuResult = await query<{
        bu_code: string;
        avg_compliance_score: string;
        avg_validation_score: string;
        response_count: string;
        submitted_count: string;
      }>(
        `SELECT
           r.bu_code,
           ROUND(AVG(r.compliance_score) FILTER (WHERE r.status = 'submitted'), 2)::text AS avg_compliance_score,
           ROUND(AVG(v.validation_score), 2)::text                                        AS avg_validation_score,
           COUNT(r.id)::text                                                              AS response_count,
           COUNT(r.id) FILTER (WHERE r.status = 'submitted')::text                       AS submitted_count
         FROM responses r
         LEFT JOIN validations v ON v.cycle_id = r.cycle_id AND v.question_id = r.question_id AND v.bu_code = r.bu_code
         WHERE r.cycle_id = $1
         GROUP BY r.bu_code
         ORDER BY r.bu_code`,
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
           ROUND(AVG(r.compliance_score), 2)::text  AS avg_compliance_score,
           v.validation_score::text                 AS validation_score,
           v.status                                 AS validation_status
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
          total_questions:   parseInt(counts.total_questions   ?? '0', 10),
          total_submitted:   parseInt(counts.total_submitted   ?? '0', 10),
          total_validated:   parseInt(counts.total_validated   ?? '0', 10),
          total_closed:      parseInt(counts.total_closed      ?? '0', 10),
          total_respondents: parseInt(counts.total_respondents ?? '0', 10),
        },
        scores_by_bcbs_principle: byBcbsResult.rows.map((r) => ({
          bcbs_principle_name:   r.bcbs_principle_name ?? null,
          avg_compliance_score:  r.avg_compliance_score != null ? parseFloat(r.avg_compliance_score) : null,
          avg_validation_score:  r.avg_validation_score != null ? parseFloat(r.avg_validation_score) : null,
          response_count:        parseInt(r.response_count, 10),
        })),
        scores_by_thematic_area: byAreaResult.rows.map((r) => ({
          thematic_area:        r.thematic_area,
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
             qc.id::text, qc.name, qc.year::text,
             qc.distributed_at, qc.closed_at,
             ROUND(AVG(v.validation_score) FILTER (WHERE v.validation_score IS NOT NULL), 2)::text AS avg_val_score,
             ROUND(AVG(r.compliance_score) FILTER (WHERE r.compliance_score IS NOT NULL), 2)::text AS avg_comp_score,
             COUNT(DISTINCT v.id) FILTER (WHERE v.status = 'closed')::text                        AS closed_validations,
             COUNT(DISTINCT r.id) FILTER (WHERE r.status = 'submitted')::text                     AS submitted_responses,
             ROUND(EXTRACT(EPOCH FROM (qc.closed_at - qc.distributed_at)) / 86400, 1)::text       AS cycle_duration_days,
             COUNT(DISTINCT r.bu_code)::text                                                       AS bu_count
           FROM questionnaire_cycles qc
           LEFT JOIN validations v ON v.cycle_id = qc.id
           LEFT JOIN responses r ON r.cycle_id = qc.id
           WHERE qc.status = 'closed'${yearFilter}
           GROUP BY qc.id
           ORDER BY qc.distributed_at NULLS LAST, qc.id`
        ),

        // b. BU productivity across closed cycles (filtered by year)
        query<{
          bu_code: string; total_assigned: string; submitted: string;
          submission_pct: string | null; avg_score: string | null;
        }>(
          `SELECT
             r.bu_code,
             COUNT(*)::text                                                                               AS total_assigned,
             COUNT(*) FILTER (WHERE r.status = 'submitted')::text                                        AS submitted,
             ROUND(COUNT(*) FILTER (WHERE r.status = 'submitted')::numeric / NULLIF(COUNT(*), 0) * 100, 1)::text AS submission_pct,
             ROUND(AVG(r.compliance_score) FILTER (WHERE r.compliance_score IS NOT NULL), 2)::text       AS avg_score
           FROM responses r
           JOIN questionnaire_cycles qc ON qc.id = r.cycle_id
           WHERE qc.status = 'closed'${yearFilter}
           GROUP BY r.bu_code
           ORDER BY ROUND(COUNT(*) FILTER (WHERE r.status = 'submitted')::numeric / NULLIF(COUNT(*), 0) * 100, 1) DESC NULLS LAST`
        ),

        // c. Monthly submissions (filtered by year)
        query<{ month: string; submitted_count: string; avg_score: string | null }>(
          `SELECT
             TO_CHAR(DATE_TRUNC('month', submitted_at), 'YYYY-MM') AS month,
             COUNT(*)::text                                          AS submitted_count,
             ROUND(AVG(compliance_score), 2)::text                  AS avg_score
           FROM responses
           WHERE status = 'submitted' AND submitted_at IS NOT NULL${yearParam ? ` AND EXTRACT(YEAR FROM submitted_at) = ${yearParam}` : ''}
           GROUP BY DATE_TRUNC('month', submitted_at)
           ORDER BY DATE_TRUNC('month', submitted_at)`
        ),

        // d. Validation score distribution (filtered by year)
        query<{ validation_score: string; count: string }>(
          `SELECT v.validation_score::text, COUNT(*)::text AS count
           FROM validations v
           JOIN questionnaire_cycles qc ON qc.id = v.cycle_id
           WHERE v.status = 'closed' AND v.validation_score IS NOT NULL${yearFilter}
           GROUP BY v.validation_score ORDER BY v.validation_score`
        ),

        // e. Cycle status distribution (filtered by year)
        query<{ status: string; count: string }>(
          `SELECT status, COUNT(*)::text AS count FROM questionnaire_cycles WHERE 1=1${yearFilterSimple} GROUP BY status`
        ),

        // f. User activity by role
        query<{
          role: string; user_count: string;
          total_logins: string; active_users: string;
        }>(
          `SELECT
             u.role,
             COUNT(DISTINCT u.id)::text                                         AS user_count,
             COUNT(lh.id)::text                                                 AS total_logins,
             COUNT(DISTINCT lh.user_id)::text                                   AS active_users
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
          cycle_duration_days: r.cycle_duration_days ? parseFloat(r.cycle_duration_days) : null,
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
