import { dowNames, lang } from "./i18n.js";

// 언어별 표기: 시간·분 단위, 영어 달 이름
const DUR_UNIT = { ko: ["시간", "분"], vi: [" giờ", " phút"], en: ["h", "min"] };
const EN_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const kstNow = () => new Date(Date.now() + 9 * 3600e3);
export const todayKST = () => kstNow().toISOString().slice(0, 10);
export const parseDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const dow = (s) => parseDate(s).getUTCDay();
export const labelMD = (s) => {
  const [, m, d] = s.split("-").map(Number);
  return `${m}/${d}(${dowNames()[dow(s)]})`; // 월/일 순서는 그대로, 요일만 화면 언어로 (11/13(금) · 11/13(T6) · 11/13(Fri))
};
// 한국어 요일로 고정한 날짜 표시(화면 언어와 상관없이 한국어로 나가는 글 — 카톡 보고문 등 — 에 쓴다)
export const labelMDKo = (s) => {
  const [, m, d] = s.split("-").map(Number);
  return `${m}/${d}(${["일", "월", "화", "수", "목", "금", "토"][dow(s)]})`;
};
// 한국어로만 쓰는 관리자 화면용(화면 언어가 베트남어·영어여도 한국어 문장 안에 외국어 조각이 섞이지 않게)
export const monthLabelKo = (k) => `${Number(k.slice(5))}월`;
export const fmtDurKo = (min) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}` : `${m}분`;
};
export const addDays = (s, n) => {
  const t = parseDate(s);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
export const monthKey = (s) => s.slice(0, 7);
export const monthLabel = (k) => {
  const n = Number(k.slice(5)), l = lang();
  return l === "vi" ? `Tháng ${n}` : l === "en" ? (EN_MONTH[n - 1] ?? String(n)) : `${n}월`; // 11월 · Tháng 11 · Nov
};

// 시각 도우미 (모두 한국시간 기준)
export const dateOf = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
export const fmtHM = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(11, 16);
export const fmtDur = (min) => {
  const m = Math.max(0, Math.round(min));
  const [uh, um] = DUR_UNIT[lang()] ?? DUR_UNIT.ko; // 2시간 30분 · 2 giờ 30 phút · 2h 30min
  return m >= 60 ? `${Math.floor(m / 60)}${uh}${m % 60 ? ` ${m % 60}${um}` : ""}` : `${m}${um}`;
};
// 'YYYY-MM-DD' + 'HH:MM'(한국시간) → ISO. notBefore보다 이르면 하루 뒤(밤샘 근무)로 본다.
export const kstIso = (date, hhmm, notBefore) => {
  let d = new Date(`${date}T${hhmm}:00+09:00`);
  if (notBefore && d <= new Date(notBefore)) d = new Date(d.getTime() + 24 * 3600e3);
  return d.toISOString();
};
export const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
