import { getSupabaseEnv } from "./supabase.js";

// All calls use the service-role key via the Storage REST API. This file
// only ever runs inside Vercel serverless functions — SUPABASE_SECRET_KEY
// never reaches the browser. Buckets are private; the only way a browser
// ever gets a working file URL is a short-lived signed URL generated here.

export const BUCKETS = {
  PLANS: "corrective-plans",
  EVIDENCE: "evidence",
};

let bucketsEnsured = new Set();

// Idempotent — creates the bucket as PRIVATE if it doesn't already exist.
// Safe to call on every upload; a 400 "already exists" is ignored.
export async function ensureBucket(bucket) {
  if (bucketsEnsured.has(bucket)) return;
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = getSupabaseEnv();
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        apikey: SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    // Ignore the response either way (already-exists is a normal 400 here);
    // downstream upload/sign calls will surface a real error if the bucket
    // genuinely can't be used.
  } catch (e) {
    // Network hiccup creating the bucket shouldn't block the upload attempt.
  }
  bucketsEnsured.add(bucket);
}

// Uploads a base64-encoded file to `${bucket}/${path}`. Returns { bucket, path }.
export async function uploadToStorage(bucket, path, base64, contentType) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = getSupabaseEnv();
  await ensureBucket(bucket);

  const buffer = Buffer.from(base64, "base64");
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      apikey: SUPABASE_SECRET_KEY,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Storage upload failed: ${text}`);
  }
  return { bucket, path };
}

// Generates a signed URL valid for `expiresIn` seconds (default 1 hour).
// This is the ONLY way the browser ever gets a working link to a private file.
export async function getSignedUrl(bucket, path, expiresIn = 3600) {
  if (!path) return null;
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = getSupabaseEnv();
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeURI(path)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      apikey: SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.signedURL) return null;
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}
