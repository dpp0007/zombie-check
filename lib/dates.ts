const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const M = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const mk = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));

/** Absolute dates found in text (ISO, "Mar 5, 2025", "5 March 2025"), within 2005..now+2d. */
export function extractDates(text: string, now = new Date()): Date[] {
  const out: Date[] = [];
  const add = (d: Date) => {
    if (!isNaN(+d) && d.getUTCFullYear() >= 2005 && +d <= +now + 2 * 864e5) out.push(d);
  };
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})(?!\d)/g)) add(mk(+m[1], +m[2] - 1, +m[3]));
  for (const m of text.matchAll(new RegExp(`\\b${M}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "gi")))
    add(mk(+m[3], MON.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]));
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${M}\\.?,?\\s+(20\\d{2})\\b`, "gi")))
    add(mk(+m[3], MON.indexOf(m[2].slice(0, 3).toLowerCase()), +m[1]));
  return out;
}

/** "3 days ago", "yesterday" ... (only used on pages known to print relative times, e.g. GitHub). */
export function relativeDates(text: string, now = new Date()): Date[] {
  const U: Record<string, number> = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
  const out: Date[] = [];
  for (const m of text.matchAll(/\b(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago\b/gi)) out.push(new Date(+now - +m[1] * U[m[2].toLowerCase()]));
  if (/\byesterday\b/i.test(text)) out.push(new Date(+now - 864e5));
  return out;
}

export const newest = (ds: Date[]) => (ds.length ? new Date(Math.max(...ds.map(Number))) : undefined);
export const iso = (d?: Date) => (d ? d.toISOString().slice(0, 10) : "");
export const ageDays = (d: Date, now = new Date()) => Math.floor((+now - +d) / 864e5);
export function parseDate(s: unknown): Date | undefined {
  if (!s || typeof s !== "string") return;
  const d = extractDates(s)[0] || new Date(s);
  return isNaN(+d) || +d > Date.now() + 2 * 864e5 ? undefined : d;
}
