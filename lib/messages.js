const HOSPITAL_AR = "إدارة الجودة وسلامة المرضى\nمستشفى الولادة والأطفال – حفر الباطن";
const HOSPITAL_EN = "Quality & Patient Safety Management\nMaternity & Children Hospital – Hafr Al Batin";

function fmtDate(d) {
  if (!d) return "-";
  return new Date(d).toISOString().slice(0, 10);
}

function daysRemaining(dueDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / 86400000);
}

// Section 10 of the spec — sent immediately after QPS approves a finding
// that requires a corrective plan.
export function planRequestMessage({ lang, department, roundId, findingSummary, startDate, dueDate, link }) {
  if (lang === "ar") {
    return `🔔 طلب خطة تصحيحية — جولة سلامة المرضى

القسم: ${department}
رقم الجولة: ${roundId}

تم اعتماد ملاحظة/ملاحظات الجولة من قبل إدارة الجودة وسلامة المرضى، ويتطلب استكمال الخطة التصحيحية ضمن الفترة المحددة.
${findingSummary ? `\nالملاحظة: ${findingSummary}\n` : ""}
📅 تاريخ بدء المتابعة:
${fmtDate(startDate)}

⏳ الموعد النهائي:
${fmtDate(dueDate)}

يرجى الدخول عبر الرابط التالي لرفع الخطة التصحيحية والأدلة الداعمة:

${link}

${HOSPITAL_AR}`;
  }
  return `🔔 Corrective Plan Request — Patient Safety Round

Department: ${department}
Round ID: ${roundId}

Quality & Patient Safety has approved a round finding that requires a corrective plan within the specified period.
${findingSummary ? `\nFinding: ${findingSummary}\n` : ""}
Start Date: ${fmtDate(startDate)}
Due Date: ${fmtDate(dueDate)}

Please open the link below to upload the corrective plan and supporting evidence:

${link}

${HOSPITAL_EN}`;
}

// Section 11 — generic reminder used for "before due", "due today", "overdue",
// "revision required", and "evidence requested" (kind changes the heading only).
export function planReminderMessage({ lang, kind, department, roundId, dueDate, link }) {
  const days = daysRemaining(dueDate);
  const headingsAr = {
    before_due: "🔔 تذكير بالخطة التصحيحية",
    due_today: "🔔 الخطة التصحيحية مستحقة اليوم",
    overdue: "🔴 الخطة التصحيحية متأخرة",
    revision: "↺ مطلوب تعديل على الخطة التصحيحية",
    evidence: "📎 مطلوب أدلة إضافية",
  };
  const headingsEn = {
    before_due: "🔔 Corrective Plan Reminder",
    due_today: "🔔 Corrective Plan Due Today",
    overdue: "🔴 Corrective Plan Overdue",
    revision: "↺ Corrective Plan Revision Required",
    evidence: "📎 Additional Evidence Required",
  };
  if (lang === "ar") {
    return `${headingsAr[kind] || headingsAr.before_due}

القسم: ${department}
رقم الجولة: ${roundId}

نذكركم بضرورة استكمال ورفع الخطة التصحيحية الخاصة بملاحظات جولة سلامة المرضى.

⏳ الموعد النهائي:
${fmtDate(dueDate)}

الأيام المتبقية:
${days >= 0 ? days : `متأخرة ${Math.abs(days)} يوم`}

لرفع الخطة والأدلة:
${link}

${HOSPITAL_AR}`;
  }
  return `${headingsEn[kind] || headingsEn.before_due}

Department: ${department}
Round ID: ${roundId}

This is a reminder to complete and upload the corrective plan for the Patient Safety Round finding(s).

Due Date:
${fmtDate(dueDate)}

Days Remaining:
${days >= 0 ? days : `${Math.abs(days)} day(s) overdue`}

To upload the plan and evidence:
${link}

${HOSPITAL_EN}`;
}

// Manual WhatsApp Send — the generic round-notification message an admin
// can trigger on demand for any recipient (spec: "Manual WhatsApp Send").
export function manualRoundMessage({ lang, round, link }) {
  const dateStr = fmtDate(round.planned_date);
  const timeStr = round.planned_time || "";
  if (lang === "ar") {
    return `تذكير بجولة سلامة المرضى

نذكركم بأن جولة سلامة المرضى ستعقد بتاريخ ${dateStr} في تمام الساعة ${timeStr}.

يرجى الدخول عبر الرابط أدناه للمشاركة في الجولة وتسجيل الملاحظات حسب المحور المخصص لكم.

${link}

${HOSPITAL_AR}`;
  }
  return `Patient Safety Round Reminder

This is to remind you that a Patient Safety Round is scheduled on ${dateStr} at ${timeStr}.

Please use the link below to join the round and record observations for your assigned domain.

${link}

${HOSPITAL_EN}`;
}
