const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export const kstNow = () => new Date(Date.now() + 9 * 3600e3);
export const todayKST = () => kstNow().toISOString().slice(0, 10);
export const parseDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const dow = (s) => parseDate(s).getUTCDay();
export const labelMD = (s) => {
  const [, m, d] = s.split("-").map(Number);
  return `${m}/${d}(${DOW[dow(s)]})`;
};
export const addDays = (s, n) => {
  const t = parseDate(s);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const monthKey = (s) => s.slice(0, 7);
export const monthLabel = (k) => `${Number(k.slice(5))}월`;

// 시각 도우미 (모두 한국시간 기준)
export const dateOf = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const fmtHM = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(11, 16);
export const fmtDur = (min) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;
};
// 'YYYY-MM-DD' + 'HH:MM'(한국시간) → ISO. notBefore보다 이르면 하루 뒤(밤샘 근무)로 본다.
export const kstIso = (date, hhmm, notBefore) => {
  let d = new Date(`${date}T${hhmm}:00+09:00`);
  if (notBefore && d <= new Date(notBefore)) d = new Date(d.getTime() + 24 * 3600e3);
  return d.toISOString();
};
export const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
