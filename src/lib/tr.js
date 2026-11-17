// 업무지시 번역·안전 표시 도우미. 공지(notices.js)의 view·needsTr·noteRow 방식을 업무용으로 일반화했다(notices.js 는 건드리지 않는다).
// 열 이름 규칙: 원문 열 <필드> 와 번역 열 <필드>_vi · <필드>_en (예: title · title_vi · title_en). 번역했는지는 translated_at 으로 본다
// (memo 가 빈 글인 지시가 정상이라 memo 로 판단하면 안 된다). title·memo 는 언제나 한국어 원문이다.
// 새 열이 없는 서버(SQL 을 아직 안 돌림)에서는 값이 undefined 라 모두 한국어 원문으로 보인다.
import { h } from "./ui.js";
import { t, lang } from "./i18n.js";

export const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const LETTER = /\p{L}/u;
const HANGUL_ANY = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\uA960-\uA97F\uD7B0-\uD7FF]/;
const FRESH_MS = 30000; // 완료한 지 이 시간 안이면 번역이 아직 끝나지 않았을 수 있다(번역 실패로 보이지 않게)

// 한국어 판정: tasks 함수(supabase/functions/tasks/index.ts)·translate 함수의 '한글 글자 수 ≥ 그 밖의 글자 수면 한국어'(src:auto) 와 같은 정의다.
// 세 곳에 따로 둔다(함수끼리·함수와 화면이 파일을 공유하지 못한다). 한 쪽을 바꾸면 나머지도 같이 바꾼다. 글자가 없는 글(숫자·기호·이모지만)은 0 ≥ 0 이라 한국어(번역할 것 없음)다
export function isKoreanText(s) {
  let ko = 0, other = 0;
  for (const ch of String(s ?? "")) {
    if (!LETTER.test(ch)) continue;
    if (HANGUL_ANY.test(ch)) ko++; else other++;
  }
  return ko >= other;
}

export const flip = (set, id) => { if (!set.delete(id)) set.add(id); };
// 안전 관련 업무: 번역하지 않고 한국어 원문만 쓴다
export const isSafety = (row) => !!row && (row.safety === true || row.tr_state === "safety");

/**
 * 지시(제목·메모)를 내 화면 언어판으로 고른다. base = 고를 필드들(기본 제목·메모), orig = 원문으로 보는 업무 id 의 Set(다시 그리는 함수 밖에 둔다)
 * 돌려주는 값: { values: {필드: 글}, note, safety, lang }
 *   note  ""    = 배지 없음(한국어 화면 · 번역이 없어 한국어를 보여 줌: 실패·번역 불필요·옛 업무는 직원에게 오류로 알리지 않는다)
 *         "tr"  = 자동 번역본
 *         "orig" = 번역이 있지만 한국어 원문을 보는 중
 *   lang  글이 한국어 원문인데 화면 언어가 한국어가 아니면 "ko"(스크린리더 발음), 아니면 null
 */
export function pickTr(row, base = ["title", "memo"], orig = null, lg = lang()) {
  const src = {};
  for (const f of base) src[f] = row?.[f] ?? "";
  const safety = isSafety(row);
  const ko = lg === "ko" ? null : "ko";
  if (lg === "ko" || safety) return { values: src, note: "", safety, lang: ko };
  const first = row[`${base[0]}_${lg}`];
  if (!row.translated_at || !first) return { values: src, note: "", safety, lang: ko };
  if (orig && orig.has(row.id)) return { values: src, note: "orig", safety, lang: ko };
  const values = {};
  for (const f of base) values[f] = row[`${f}_${lg}`] || src[f];
  return { values, note: "tr", safety, lang: null };
}

const lab = (text, title) => (title ? `${text}: ${title}` : text);

/** 번역 배지 + '원문 보기' 토글 줄, 안전 업무 배지(+ 한국어가 아닌 화면에서는 안내). 보여 줄 것이 없으면 null */
export function trNote(row, v, onFlip) {
  if (v.safety) {
    return h("div", { class: "tr-safe" },
      h("span", { class: "badge bad" }, t("⚠ 안전 업무")),
      lang() !== "ko" && h("span", { class: "tr-hint" }, t("안전 업무예요. 한국어 원문만 있어요. 관리자에게 물어보세요")));
  }
  if (!v.note) return null;
  const isTr = v.note === "tr";
  const label = isTr ? t("원문 보기") : t("번역 보기");
  return h("div", { class: "tr-note" },
    h("span", { class: "badge" + (isTr ? " info" : "") }, isTr ? t("자동 번역") : t("한국어 원문")),
    h("button", { type: "button", class: "linkbtn", "aria-label": lab(label, v.values?.title), onclick: onFlip }, label));
}

/* ---------- 완료 메모: 직원이 쓴 글을 지시한 사람이 읽는 말로 ---------- */
// 번역이 필요한 글인가(글자가 있고 한국어가 아니다: 한글 글자 수 < 그 밖의 글자 수)
export const needsKo = (s) => !!s && LETTER.test(s) && !isKoreanText(s);

/**
 * 완료 메모 보기. 한국어 화면에서만 한국어 번역(done_note_ko)을 보여 준다(다른 화면 언어는 원문 그대로).
 * 돌려주는 값: { text, note, lang }
 *   note  ""     = 그대로 보여 줌(한국어 글·번역 불필요·번역 열이 없는 서버·방금 완료해 번역 중)
 *         "tr"   = 자동 번역본(원문 = done_note)   "orig" = 번역이 있지만 원문을 보는 중
 *         "failed" = 번역이 필요한데 번역하지 못함(원문을 보여 주고 '번역하지 못했어요')
 * 실패는 '번역 열이 있는데 done_note_lang 이 비어 있는 것'이다(서버가 번역을 못 하면 lang 을 비워 둔다). lang 이 채워져 있으면
 * (번역 불필요 'other'·tasks2.sql 이 옛 완료 행에 채워 준 값) 번역을 시도한 적이 없거나 할 것이 없는 글이라 그대로 보여 준다.
 */
export function doneNoteView(row, orig = null, lg = lang()) {
  const raw = row?.done_note ?? "";
  const fromLang = row?.done_note_lang === "vi" || row?.done_note_lang === "en" ? row.done_note_lang : null;
  const plain = { text: raw, note: "", lang: fromLang };
  if (!raw || lg !== "ko" || row.done_note_lang === "ko" || !needsKo(raw)) return plain;
  if (row.done_note_ko) {
    return orig && orig.has(row.id) ? { text: raw, note: "orig", lang: fromLang } : { text: row.done_note_ko, note: "tr", lang: null };
  }
  if (row.done_note_lang) return plain;
  const fresh = Date.parse(row.done_at) > Date.now() - FRESH_MS;
  return "done_note_lang" in row && !fresh && !isSafety(row) ? { text: raw, note: "failed", lang: fromLang } : plain;
}

/** 완료 메모 아래 줄: 번역 배지·원문 보기 토글, 또는 '번역하지 못했어요'. 보여 줄 것이 없으면 null */
export function doneNoteBar(row, nv, onFlip) {
  if (nv.note === "failed") return h("div", { class: "tr-note" }, h("span", { class: "tr-fail" }, t("번역하지 못했어요")));
  if (nv.note !== "tr" && nv.note !== "orig") return null;
  const isTr = nv.note === "tr";
  return h("div", { class: "tr-note" },
    h("span", { class: "badge" + (isTr ? " info" : "") }, isTr ? t("자동 번역") : t("원문")),
    h("button", { type: "button", class: "linkbtn", "aria-label": lab(isTr ? t("원문 보기") : t("번역 보기"), row.title), onclick: onFlip }, isTr ? t("원문 보기") : t("번역 보기")));
}

/** 한 줄 보고판용: " — 메모" 와 작은 표시를 이어 붙인 조각들(없으면 빈 배열). 원문 보기 토글은 없다(자세한 화면에서 본다) */
export function doneNoteInline(row) {
  const nv = doneNoteView(row);
  if (!nv.text) return [];
  return [" — ", h("span", { lang: nv.lang }, nv.text),
    nv.note === "tr" ? h("span", { class: "badge info tr-mini" }, t("자동 번역")) : null,
    nv.note === "failed" ? h("span", { class: "tr-fail" }, " " + t("번역하지 못했어요")) : null];
}

/**
 * 지시(제목·메모)의 번역이 없는 업무인가: 번역에 실패했거나(failed), 번역 기능이 켜지기 전에 만든 열린 옛 업무(번역 열이 있는 서버에서 tr_state 가 비어 있음.
 * 반복 업무가 옛 행에서 복사한 null 도 같다). 번역 열이 없는 옛 서버(tr_state 가 undefined)는 번역 기능이 꺼진 것이라 아니다. 안전 업무는 번역하지 않는다
 */
export const trMissing = (row) => !!row && !isSafety(row) && (row.tr_state === "failed" || ("tr_state" in row && row.tr_state == null && row.status === "open"));

/** 관리자 화면의 '다시 번역' 버튼이 필요한가: 지시 번역이 없거나(trMissing) 완료 메모를 번역하지 못함. 안전 업무는 번역하지 않는다 */
export const retryNeeded = (row) => !!row && !isSafety(row) && (trMissing(row) || doneNoteView(row).note === "failed");

/* ---------- 안전 되묻기 ---------- */
/**
 * 서버가 안전과 관련된 말을 찾았을 때(code: safety_suspect) 아무것도 저장되기 전에 한 번만 묻는다.
 * "safe" = 안전 관련으로 보내기(번역 안 함) · "ack" = 아니요, 번역해서 보내기 · null = 돌아가기(보내지 않음)
 */
export function askSafety(words = []) {
  return new Promise((resolve) => {
    const list = (Array.isArray(words) ? words : []).filter((w) => typeof w === "string" && w).slice(0, 8);
    const close = (v) => { ov.remove(); resolve(v); };
    const ov = h("div", { class: "overlay" },
      h("div", { class: "dialog", role: "dialog", "aria-modal": "true" },
        h("h2", null, t("안전과 관련된 내용 같아요")),
        list.length > 0 && h("p", { class: "tr-words" }, t("들어 있는 말: {words}", { words: list.join(", ") })),
        h("p", { class: "muted" }, t("안전 관련으로 보내면 번역하지 않고 한국어 원문만 가요. 번역해서 보내면 기계 번역이라 틀릴 수 있어요.")),
        h("button", { type: "button", class: "btn primary", onclick: () => close("safe") }, t("안전 관련으로 보내기")),
        h("button", { type: "button", class: "btn ghost", onclick: () => close("ack") }, t("아니요, 번역해서 보내기")),
        h("button", { type: "button", class: "btn ghost", onclick: () => close(null) }, t("돌아가기"))));
    document.body.append(ov);
    ov.querySelector("button")?.focus();
  });
}

// 서버가 안전 되묻기로 답했는가 (tkCreate 의 응답)
export const isSafetyAsk = (res) => !!res && res.ok === false && res.code === "safety_suspect";
