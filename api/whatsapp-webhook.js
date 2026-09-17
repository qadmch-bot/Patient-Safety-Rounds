import { sbGet, sbPatch, sbInsert } from "../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      success: true,
      message: "WhatsApp webhook is ready"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = req.body || {};

    const from = body.From || "";
    const messageBody = (body.Body || "").trim();

    // Twilio may send the quick-reply value in ButtonPayload
    const buttonPayload = (body.ButtonPayload || "").trim();
    const buttonText = (body.ButtonText || "").trim();

    const phone = from.replace("whatsapp:", "").replace("+", "");

    let attendanceStatus = null;

    // Approved quick reply IDs
    if (
      buttonPayload === "attendance_confirmed" ||
      messageBody === "تأكيد الحضور" ||
      buttonText === "تأكيد الحضور"
    ) {
      attendanceStatus = "Confirmed";
    }

    if (
      buttonPayload === "attendance_declined" ||
      messageBody === "تعذر الحضور" ||
      buttonText === "تعذر الحضور"
    ) {
      attendanceStatus = "Declined";
    }

    console.log("WhatsApp inbound:", {
      from,
      phone,
      messageBody,
      buttonPayload,
      buttonText,
      attendanceStatus
    });

    /*
     * For now we confirm that Twilio -> Vercel webhook works.
     * Attendance database linking will be handled after this test,
     * because we must identify the correct round/participant safely.
     */

    return res.status(200).json({
      success: true,
      received: true,
      phone,
      attendance_status: attendanceStatus
    });

  } catch (error) {
    console.error("WhatsApp webhook error:", error);

    return res.status(200).json({
      success: false,
      error: error.message
    });
  }
}
