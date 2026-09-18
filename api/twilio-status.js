import { sbPatch, setCors, handleConfigError } from "../lib/supabase.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success:false, error:"Method not allowed" });
  try {
    const b = req.body || {};
    const sid = b.MessageSid || b.SmsSid;
    const status = String(b.MessageStatus || b.SmsStatus || "").toLowerCase();
    if (!sid || !status) return res.status(400).json({ success:false, error:"Missing MessageSid/MessageStatus" });
    const patch = { status, updated_at:new Date().toISOString() };
    if (status === "delivered") patch.delivered_at = new Date().toISOString();
    if (status === "read") patch.read_at = new Date().toISOString();
    if (["failed","undelivered"].includes(status)) {
      patch.failed_at = new Date().toISOString();
      patch.error_code = b.ErrorCode || null;
      patch.error_message = b.ErrorMessage || null;
    }
    await sbPatch("whatsapp_reminders", `?twilio_message_sid=eq.${encodeURIComponent(sid)}`, patch).catch(()=>[]);
    await sbPatch("whatsapp_manual_messages", `?message_sid=eq.${encodeURIComponent(sid)}`, patch).catch(()=>[]);
    return res.status(200).json({ success:true });
  } catch (error) {
    if (handleConfigError(res,error)) return;
    return res.status(500).json({ success:false, error:error.message || "Internal server error" });
  }
}
