// 화면 언어(한국어·베트남어·영어).
// 한국어 문장을 그대로 키로 쓴다: t("출근하기"), t("{n}명 출근", { n: 3 }). 번역이 없으면 한국어가 그대로 나온다(빠뜨려도 화면이 깨지지 않는다).
// 번역 사전은 src/i18n/vi.js · en.js (src/i18n/parts/*.js 를 모은 것). 한국어(ko)일 때는 사전을 불러오지 않는다.
export const LANGS = [["ko", "한국어"], ["vi", "Tiếng Việt"], ["en", "English"]];
const KEY = "woo_lang";
const LOCALE = { ko: "ko-KR", vi: "vi-VN", en: "en-US" };
const DOW = { ko: ["일", "월", "화", "수", "목", "금", "토"], vi: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"], en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };

let cur = "ko";
let dict = {};

export const isLang = (l) => LANGS.some(([k]) => k === l);
export const lang = () => cur;
export const locale = () => LOCALE[cur];
export const dowNames = () => DOW[cur];

/** t("{n}명 출근", { n: 3 }). 사전에 없으면 키(한국어) 그대로. {이름} 자리는 params 로 채운다 */
export function t(key, params) {
  let s = cur === "ko" ? key : (dict[key] ?? key);
  if (params) s = String(s).replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? ""));
  return s;
}

/**
 * 같은 한국어 낱말이 자리에 따라 뜻이 다를 때(예: 탭 '기록'과 점검 버튼 '기록'): tx("점검", "기록")는 사전의 "점검::기록"을 먼저 찾고, 없으면 "기록"을 찾는다.
 * 한국어(ko)에서는 항상 뒤의 한국어 키 그대로.
 */
export function tx(ctx, key, params) {
  if (cur !== "ko" && `${ctx}::${key}` in dict) return t(`${ctx}::${key}`, params);
  return t(key, params);
}

/** 숫자: 언어에 맞는 구분자(1,234 / 1.234) */
export const fmtNum = (n) => (Number.isFinite(n) ? n.toLocaleString(LOCALE[cur]) : "-");

/** 언어를 바꾼다(필요하면 사전을 불러온다). persist=true 면 이 기기에도 기억(로그인 전 화면에 쓴다) */
export async function setLang(l, { persist = true } = {}) {
  if (!isLang(l)) l = "ko";
  if (l === "ko") dict = {};
  else {
    try { dict = (await import(`../i18n/${l}.js`)).default ?? {}; } catch (e) { console.error(e); dict = {}; } // 사전을 못 불러와도 한국어로 보인다
  }
  cur = l;
  document.documentElement.lang = l;
  if (persist) { try { localStorage.setItem(KEY, l); } catch { /* 저장 못 해도 괜찮아요 */ } }
  return cur;
}

/** 이 기기에 기억해 둔 언어(로그인 전 화면용). 없으면 베트남어 폰은 베트남어, 나머지는 한국어 */
export function savedLang() {
  try { const l = localStorage.getItem(KEY); if (isLang(l)) return l; } catch { /* 무시 */ }
  return /^vi\b/i.test(navigator.language ?? "") ? "vi" : "ko";
}
