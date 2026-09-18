import { sbGet } from "./supabase.js";

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Mirrors the frontend's planTargetDateStr(): start = day after the round;
// due = one day before the next scheduled round for the same department,
// no due date is invented when no future round exists for that department.
export async function computePlanDates(roundPlannedDate, department) {
  const startDate = addDays(roundPlannedDate, 1);

  // Postgres array-contains filter via PostgREST: departments=cs.{DEPT}
  const candidates = await sbGet(
    "rounds",
    `?departments=cs.{${encodeURIComponent(department)}}&status=eq.Scheduled&planned_date=gt.${roundPlannedDate}&order=planned_date.asc&limit=1`
  );

  if (candidates.length) {
    let due = addDays(candidates[0].planned_date, -1);
    if (due <= startDate) return { startDate, dueDate: null, nextRoundId: candidates[0].id };
    return { startDate, dueDate: due, nextRoundId: candidates[0].id };
  }
  return { startDate, dueDate: null, nextRoundId: null };
}
