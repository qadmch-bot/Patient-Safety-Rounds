import { sbGet, sbInsert } from "../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      success: true,
      message: "WhatsApp webhook is active",
    });
  }

  try {
    const body = req.body || {};

    const from = String(body.From || "")
      .replace("whatsapp:", "")
      .replace(/\D/g, "");

    const message = String(body.Body || "").trim();

    // رد زر Quick Reply من Twilio/WhatsApp إن وُجد
    const buttonPayload =
      body.ButtonPayload ||
      body.ButtonText ||
      "";

    let attendanceStatus = null;

    if (
      buttonPayload === "attendance_confirmed" ||
      message.includes("تأكيد الحضور")
    ) {
      attendanceStatus = "Confirmed";
    }

    if (
      buttonPayload === "attendance_declined" ||
      message.includes("تعذر الحضور")
    ) {
      attendanceStatus = "Declined";
    }

    // حفظ الرسالة الواردة في سجل التدقيق
    await sbInsert(
      "audit_trail",
      [
        {
          action: "whatsapp_inbound",
          details: JSON.stringify({
            from,
            message,
            button_payload: buttonPayload,
            attendance_status: attendanceStatus,
            received_at: new Date().toISOString(),
          }),
        },
      ],
      "minimal"
    ).catch(() => {});

    /*
      محاولة معرفة العضو من رقم الجوال.
      لا نوقف الـWebhook إذا لم نجد العضو.
    */
    let member = null;

    try {
      const members = await sbGet(
        "round_members",
        `mobile=eq.${encodeURIComponent(from)}&active=eq.true`
      );

      if (Array.isArray(members) && members.length) {
        member = members[0];
      }
    } catch (e) {
      // تجاهل خطأ البحث حتى يستمر استقبال WhatsApp
    }

    console.log("WhatsApp inbound:", {
      from,
      message,
      buttonPayload,
      attendanceStatus,
      memberId: member?.id || null,
    });

    // Twilio يحتاج استجابة ناجحة وسريعة
    res.setHeader("Content-Type", "text/xml");

    return res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`
    );
  } catch (error) {
    console.error("WhatsApp webhook error:", error);

    res.setHeader("Content-Type", "text/xml");
    return res
      .status(200)
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
}
