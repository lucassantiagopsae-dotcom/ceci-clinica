// Shared PII normalization + hashing for Meta CAPI user_data.
//
// Extracted from functions/tracker.js (sha256 / normalizePhone / normalizeName)
// so functions/api/crm-event.js doesn't duplicate the hashing logic. tracker.js
// itself is intentionally left untouched — it's the hot path that generates
// today's conversions, and this extraction ships alongside new functionality
// rather than refactoring it. A follow-up PR can point tracker.js at this file.

export async function sha256(value) {
  if (!value) return '';
  const normalized = value.toLowerCase().trim();
  const encoded = new TextEncoder().encode(normalized);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Meta CAPI expects phone digits INCLUDING country code + area code
// (ex: `16505554444` or `5511987654321`). Users typing their own
// number into a lead form almost never include the country code, so
// we prepend a default. `countryCode` defaults to 55 (Brazil);
// set `env.DEFAULT_COUNTRY_CODE` to change it.
//
// Detection is length-based and best-effort. A recipient whose
// audience mixes country codes (rare for the target audience) gets
// marginal mismatches; fixing that requires a real phone-parsing
// library which is too heavy for an edge worker.
export function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const digits = ph.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  // Already starts with the configured country code at a plausible
  // total length → leave as-is.
  if (digits.startsWith(cc) && digits.length >= cc.length + 8 && digits.length <= cc.length + 11) {
    return digits;
  }
  // Plausibly a locally-formatted number (no country code yet) → prepend.
  if (digits.length >= 8 && digits.length <= 11) {
    return cc + digits;
  }
  // Any other length (likely an already-international foreign number
  // whose country code isn't our default) → leave untouched.
  return digits;
}

// Meta Advanced Matching spec for fn/ln is lowercase only — do NOT
// strip punctuation/accents. Meta's graph preserves apostrophes,
// hyphens, and diacritics; stripping them breaks hash matches for
// names like "O'Brien", "Garcia-Rodriguez", "João".
export function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}
