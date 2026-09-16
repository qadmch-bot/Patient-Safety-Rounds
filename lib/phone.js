// Normalizes a Saudi or international mobile number to E.164 (+9665XXXXXXXX
// style). Returns null if the input can't reasonably be normalized.
export function normalizeToE164(input) {
  if (!input) return null;
  let digits = String(input).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    digits = "+" + digits.slice(1).replace(/\D/g, "");
  } else {
    digits = digits.replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.startsWith("966")) digits = "+" + digits;
    else if (digits.startsWith("05") && digits.length === 10) digits = "+966" + digits.slice(1);
    else if (digits.startsWith("5") && digits.length === 9) digits = "+966" + digits;
    else digits = "+" + digits;
  }
  // Basic sanity check: E.164 is +[country code][number], 8-15 digits total.
  if (!/^\+\d{8,15}$/.test(digits)) return null;
  return digits;
}
