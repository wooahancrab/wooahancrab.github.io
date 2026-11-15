import { api } from "../lib/api.js";
import { h, toast, confirmDialog, copyText, seg, bigToggle, timeInput } from "../lib/ui.js";
import { todayKST, labelMD, fmtHM } from "../lib/kst.js";
import { normalize, validate, kakaoText, OPEN_ITEMS, TRASH, STORE_NAME, blankAbsent, blankLate, blankClaim } from "../lib/report.js";
import { t, tx, lang } from "../lib/i18n.js";

// 서버·네트워크 오류를 화면 언어로. 한국어가 아닌 화면에서 영어 원문(Failed to fetch, JWT expired 등)은 알아볼 수 있는 문장으로 바꾼다
function errShown(e) {
  const m = String(e?.message || e);
  if (lang() !== "ko" && !/[가-힣]/.test(m)) {
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return t("서버에 연결하지 못했어요");
    if (/jwt|row-level security|violates|does not exist|permission denied|schema cache/i.test(m)) return t("처리하지 못했어요");
  }
  return t(m);
}

export async function renderManager(root, ctx) {
  const date = todayKST();
  let existing = null;
  // 기존 보고를 못 불러오면 빈 폼으로 진행하지 않는다(제출하면 이미 낸 보고를 덮어쓰게 되므로)
  try { existing = await api.getReport(date); } catch (e) {
    root.replaceChildren(h("div", { class: "page" }, h("p", { class: "err" }, t("오늘 보고를 불러오지 못했어요: {msg}", { msg: errShown(e) })),
      h("button", { class: "btn primary", onclick: () => renderManager(root, ctx) }, t("다시 시도"))));
    return;
  }
  // 작성 중인 내용은 폰에 임시저장해 두었다가, 탭을 옮기거나 앱을 다시 열어도 복원한다
  const draftKey = "woo_draft_" + (ctx?.user_id ?? "me") + "_" + date;
  const saveDraft = () => { try { localStorage.setItem(draftKey, JSON.stringify(d)); } catch { /* 저장소를 못 쓰면 무시 */ } };
  const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch { /* 무시 */ } };
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey)); } catch { /* 무시 */ }
  let d = normalize(draft ?? existing?.data, date);
  if (draft) toast(t("작성 중이던 내용을 불러왔어요"), 3000);
  // 출퇴근 기록에서 오늘 지각한 사람 (있으면 지각 칸으로 불러올 수 있게)
  let lateCands = [];
  try { lateCands = (await api.attAll(date)).filter((r) => r.work_date === date && r.late_min > 0); } catch { /* 출퇴근 기능을 안 쓰면 무시 */ }
  let submitted = !!existing;
  let doneView = false;
  let busy = false;

  const draw = () => {
    const y = window.scrollY;
    root.replaceChildren(doneView ? doneScreen() : form());
    window.scrollTo(0, y);
    saveDraft();
  };
  root.addEventListener("input", () => saveDraft()); // 글자를 칠 때마다(화면을 다시 그리지 않는 입력 포함)
  const set = (fn) => () => { fn(); draw(); };

  async function doCopy() {
    toast((await copyText(kakaoText(date, d))) ? t("복사했어요. 카톡에 붙여넣기 하세요") : t("복사 실패 — 화면 글자를 길게 눌러 복사하세요"));
  }

  async function submit() {
    if (busy) return;
    const miss = validate(d, date);
    if (miss.length) {
      const go = await confirmDialog(t("비어 있는 칸이 있어요"), miss, t("돌아가서 채우기"), t("그래도 제출")); // 빈 칸 목록(report.js 의 한국어 문구)은 confirmDialog 가 화면 언어로 바꿔 보여 준다
      if (!go) return;
    }
    if (todayKST() !== date) { toast(t("날짜가 바뀌었어요. 앱을 다시 열어 주세요")); return; }
    busy = true; draw();
    try {
      await api.saveReport(date, d);
      submitted = true; doneView = true; clearDraft();
    } catch (e) {
      toast(t("제출 실패: {msg} — '카톡으로 복사'로 먼저 보내 주세요", { msg: errShown(e) }), 6000);
    }
    busy = false; draw();
  }

  function doneScreen() {
    return h("div", { class: "page" },
      h("div", { class: "done" }, h("div", { class: "bigcheck" }, "✓"), h("h2", null, t("제출 완료")), h("p", null, t("대표님께 전달됐어요"))),
      h("pre", { class: "kakao" }, kakaoText(date, d)), // 카톡으로 보내는 보고문은 화면 언어와 상관없이 한국어
      h("button", { class: "btn primary", onclick: doCopy }, t("카톡으로 복사")),
      h("button", { class: "btn ghost", onclick: () => { doneView = false; draw(); } }, t("수정하기")));
  }

  // 여러 건을 추가할 수 있는 입력 묶음 (결원·지각·클레임 공통)
  const entry = (title, canRemove, onRemove, ...kids) =>
    h("div", { class: "entry" },
      h("div", { class: "entry-head" }, h("span", null, title),
        canRemove && h("button", { type: "button", class: "x", "aria-label": t("삭제"), onclick: onRemove }, "×")),
      ...kids);

  const addBtn = (label, onAdd) => h("button", { type: "button", class: "btn ghost slim", onclick: onAdd }, label);

  function form() {
    const a = d.att, c = d.claim, k = d.chk;
    return h("div", { class: "page" },
      h("div", { class: "datebar" }, h("b", null, labelMD(date)), h("span", null, STORE_NAME)),
      submitted && h("div", { class: "banner" }, t("오늘 보고는 이미 제출됐어요. 고치고 다시 제출하면 덮어써요.")),

      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("1. 근태")),
        h("label", { class: "lbl" }, tx("일일보고", "결원")),
        seg([["none", t("결원 없음")], ["has", t("결원 있음")]], a.absent, (v) => set(() => (a.absent = v))()),
        a.absent === "has" && h("div", { class: "stack" },
          a.absents.map((x, i) => entry(t("결원 {n}", { n: i + 1 }), a.absents.length > 1, set(() => a.absents.splice(i, 1)),
            h("input", { type: "text", class: "inp", placeholder: t("이름"), value: x.name, "aria-label": t("결원자 이름"), oninput: (e) => (x.name = e.target.value) }),
            h("input", { type: "text", class: "inp", placeholder: t("내용 (예: 개인 사정, 병가)"), value: x.note, "aria-label": t("결원 내용"), oninput: (e) => (x.note = e.target.value) }))),
          addBtn(t("+ 결원 추가"), set(() => a.absents.push(blankAbsent())))),
        h("label", { class: "lbl" }, tx("일일보고", "지각")),
        lateCands.length > 0 && h("button", { type: "button", class: "btn ghost slim", onclick: set(() => {
          a.late = "has";
          a.lates = lateCands.map((r) => ({ name: r.user_name, time: fmtHM(r.in_at) }));
        }) }, t("출근 기록에서 지각자 불러오기 ({n}명)", { n: lateCands.length })),
        seg([["none", t("지각 없음")], ["has", t("지각 있음")]], a.late, (v) => set(() => (a.late = v))()),
        a.late === "has" && h("div", { class: "stack" },
          a.lates.map((l, i) => entry(t("지각자 {n}", { n: i + 1 }), a.lates.length > 1, set(() => a.lates.splice(i, 1)),
            h("input", { type: "text", class: "inp", placeholder: t("이름"), value: l.name, "aria-label": t("지각자 이름"), oninput: (e) => (l.name = e.target.value) }),
            h("div", { class: "timerow" }, h("span", { class: "tlabel" }, t("출근시간 :")), timeInput(l.time, (v) => (l.time = v))))),
          addBtn(t("+ 지각자 추가"), set(() => a.lates.push(blankLate()))))),

      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("2. 클레임·특이사항")),
        seg([["none", tx("일일보고", "없음")], ["has", tx("일일보고", "있음")]], c.state, (v) => set(() => (c.state = v))()),
        c.state === "has" && h("div", { class: "stack" },
          c.items.map((x, i) => entry(t("클레임 {n}", { n: i + 1 }), c.items.length > 1, set(() => c.items.splice(i, 1)),
            h("label", { class: "lbl" }, t("내용")),
            h("textarea", { class: "inp", rows: "3", placeholder: t("어떤 일이 있었나요"), oninput: (e) => (x.content = e.target.value) }, x.content),
            h("label", { class: "lbl" }, t("처리 결과")),
            h("textarea", { class: "inp", rows: "2", placeholder: t("어떻게 처리했나요"), oninput: (e) => (x.result = e.target.value) }, x.result))),
          addBtn(t("+ 클레임 추가"), set(() => c.items.push(blankClaim()))))),

      h("h2", { class: "sec-title" }, t("3. 점검 결과")),

      h("section", { class: "card sub" }, h("h3", null, t("① 조회")),
        bigToggle(t("조회 완료"), k.reviewDone, (v) => set(() => (k.reviewDone = v))()),
        h("input", { type: "text", class: "inp", placeholder: t("오늘 조회 주제"), value: k.topic, "aria-label": t("조회 주제"), oninput: (e) => (k.topic = e.target.value) })),

      h("section", { class: "card sub" }, h("h3", null, t("② 오픈 준비 체크 (빠진 항목 선택)")),
        bigToggle(t("오픈 체크 완료"), k.openDone, (v) => set(() => (k.openDone = v))()),
        h("p", { class: "hint" }, t("빠진 항목이 있으면 눌러 주세요. 없으면 그대로 두세요.")),
        h("div", { class: "olist" }, OPEN_ITEMS.map((it) => {
          const miss = k.openMissing.includes(it);
          return h("button", { type: "button", class: "oitem" + (miss ? " miss" : ""), "aria-pressed": miss ? "true" : "false",
            onclick: set(() => { k.openMissing = miss ? k.openMissing.filter((x) => x !== it) : [...k.openMissing, it]; }) },
            h("span", { class: "oname" }, tx("보고 항목", it)), // 저장되는 값은 한국어 그대로, 보이는 글자만 번역
            h("span", { class: "ostate" }, miss ? t("✕ 빠짐") : t("✓ 이상 없음")));
        }))),

      h("section", { class: "card sub" }, h("h3", null, t("③ 마당 청소")),
        bigToggle(t("마당 청소 완료"), k.yard, (v) => set(() => (k.yard = v))())),

      h("section", { class: "card sub" }, h("h3", null, t("④ 쓰레기장 물청소")),
        h("p", { class: "hint" }, t("꽃게 종량제봉투 장소")),
        seg(Object.entries(TRASH).map(([v, label]) => [v, tx("보고 항목", label)]), k.trash, (v) => set(() => (k.trash = v))())),

      h("section", { class: "card sub" }, h("h3", null, t("⑤ 마감 점검")),
        bigToggle(t("마감 점검 완료 (불·가스 끄기, 문단속)"), k.closing, (v) => set(() => (k.closing = v))())),

      h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("4. 요청사항")),
        h("textarea", { class: "inp", rows: "3", placeholder: t("대표님께 전달할 요청사항 (없으면 비워 두세요)"), "aria-label": t("요청사항"), oninput: (e) => (d.request = e.target.value) }, d.request)),

      h("div", { class: "actions" },
        h("button", { class: "btn primary", disabled: busy, onclick: submit }, busy ? t("제출 중…") : submitted ? t("다시 제출(수정)") : tx("일일보고", "제출")),
        h("button", { class: "btn ghost", onclick: doCopy }, t("카톡으로 복사"))));
  }

  draw();
}
