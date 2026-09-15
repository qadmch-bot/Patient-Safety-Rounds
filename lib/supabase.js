// Shared helper for talking to Supabase's PostgREST API from Vercel
// serverless functions. Uses the SERVICE ROLE key (SUPABASE_SECRET_KEY),
// which lives only in Vercel Environment Variables — never in the browser.
// This file lives outside /api so Vercel does not treat it as a route.

export function getSupabaseEnv() {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    const err = new Error("Supabase environment variables are missing.");
    err.isConfigError = true;
    throw err;
  }
  return { SUPABASE_URL, SUPABASE_SECRET_KEY };
}

export function supabaseHeaders(extra = {}) {
  const { SUPABASE_SECRET_KEY } = getSupabaseEnv();
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// table: postgrest table name, query: string starting with '?' (optional)
export async function sbGet(table, query = "") {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: "GET",
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${await res.text()}`);
  return res.json();
}

export async function sbInsert(table, rows, returning = "representation") {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders({ Prefer: `return=${returning}` }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${table} failed: ${await res.text()}`);
  return returning === "representation" ? res.json() : null;
}

export async function sbUpsert(table, rows, onConflict, returning = "representation") {
  const { SUPABASE_URL } = getSupabaseEnv();
  const url = `${SUPABASE_URL}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders({
      Prefer: `resolution=merge-duplicates,return=${returning}`,
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} failed: ${await res.text()}`);
  return returning === "representation" ? res.json() : null;
}

export async function sbPatch(table, query, patch, returning = "representation") {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: "PATCH",
    headers: supabaseHeaders({ Prefer: `return=${returning}` }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
  return returning === "representation" ? res.json() : null;
}

export async function sbDelete(table, query) {
  const { SUPABASE_URL } = getSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method: "DELETE",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} failed: ${await res.text()}`);
  return true;
}

export async function logAudit({ action, entity_type, entity_id, actor, previous_value, new_value }) {
  try {
    await sbInsert(
      "audit_trail",
      [{ action, entity_type, entity_id: String(entity_id ?? ""), actor: actor || "System", previous_value: previous_value ?? null, new_value: new_value ?? null }],
      "minimal"
    );
  } catch (e) {
    // Audit logging must never break the main request.
    console.error("Audit log failed:", e.message);
  }
}

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function handleConfigError(res, error) {
  if (error && error.isConfigError) {
    res.status(500).json({ success: false, error: error.message });
    return true;
  }
  return false;
}
