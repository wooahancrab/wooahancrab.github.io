// 업무지시 관리(대표·부대표): 업무를 지시하고, 담당자별 진행·밀림을 본다
// 지시 제목·메모는 지시한 사람이 쓴 한국어 원문 그대로 보여 준다. 완료 메모는 직원이 쓴 글이라 한국어 화면에서는 한국어 번역을 먼저 보여 주고 원문을 볼 수 있다.
import { api } from "../lib/api.js";
import { h, toast, modal, seg, bigToggle } from "../lib/ui.js";
import { labelMD, dateOf, fmtHM, todayKST } from "../lib/kst.js";
import { t, tx } from "../lib/i18n.js";
import { REPEAT_KO } from "./tasks.js";
import { isSafety, flip, doneNoteView, doneNoteBar, retryNeeded, trMissing, askSafety, isSafetyAsk } from "../lib/tr.js";

const SHORT = { gejang: "게장", ck: "CK", fnb: "F&B" };

// opts.all: 대표·부대표가 사업장 구분 없이 전 직원에게 지시(담당자 목록이 사업장별로 묶여 나옴)
export async function renderTasksAdmin(root, onBack, opts = {}) {
  const ALL = !!opts.all;
  let data = null, people = [], err = "";
  let tab = "open";
  let stores = [];
  let sending = null; // 지시를 보내는 중이면 { i, n } — 버튼을 잠가 같은 지시가 두 번 가지 않게 한다(번역 때문에 몇 초 걸릴 수 있다)
  const origNote = new Set(); // 완료 메모를 원문으로 보는 업무 id (다시 그려도 그대로 두려고 draw 밖에 둔다)
  const retrying = new Set(); // 다시 번역하는 중인 업무 id
  const shortName = (storeId) => t(SHORT[stores.find((s) => s.id === storeId)?.app_key] ?? ""); // 사업장 약칭(전 직원 모드에서만 쓴다)

  async function load() {
    try {
      [data, people] = await Promise.all([api.tkAll(ALL), api.tkPeople(ALL).then((r) => r.people)]);
      if (ALL && !stores.length) stores = await api.listStores().catch(() => []);
      err = "";
    } catch (e) { err = e.message; }
    draw();
  }
  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 2000); await load(); return true; } catch (e) { toast(e.message, 4000); return false; } };

  // 한 명씩 차례로 지시한다. 돌려주는 값: "ok" 다 보냄 · "back" 되묻기에서 돌아감(아무것도 저장 안 됨) · "fail" 하나도 못 보냄 · "partial" 일부만 보냄
  async function sendAll(ids, f) {
    sending = { i: 0, n: ids.length };
    draw();
    let made = 0, flag = {};
    try {
      for (const id of ids) {
        sending.i++;
        draw();
        for (;;) {
          const res = await api.tkCreate({ ...f, assignee_id: id, ...flag }, ALL);
          if (!isSafetyAsk(res)) break;
          // 서버가 안전과 관련된 말을 찾았다 = 아무것도 저장되지 않았다. 첫 사람에서만 되묻고, 답을 전원에게 같은 플래그로 보낸다
          if (made > 0 || flag.safety || flag.safety_ack) throw new Error("저장하지 못했어요");
          const pick = await askSafety(res.words);
          if (!pick) return "back";
          flag = pick === "safe" ? { safety: true } : { safety_ack: true };
        }
        made++;
      }
      return "ok";
    } catch (e) {
      if (made > 0) { toast(t("{n}명에게는 지시됐고, 나머지는 보내지 못했어요. 목록을 확인해 주세요", { n: made }), 5000); return "partial"; }
      toast(e.message, 4000);
      return "fail";
    } finally {
      sending = null;
      draw();
    }
  }

  async function create() {
    if (sending) return;
    if (!people.length) { toast(t("이 사업장에 담당자로 지정할 직원 계정이 아직 없어요")); return; }
    const title = h("input", { type: "text", class: "inp", placeholder: t("업무 내용 (예: 이번 주 송장 발행)"), maxlength: "60" });
    const memo = h("textarea", { class: "inp", rows: "2", maxlength: "200", placeholder: t("자세한 설명 (선택)") });
    const opt = (p) => h("option", { value: p.user_id }, `${p.display_name}${p.job_title ? " (" + p.job_title + ")" : ""}`);
    // 전 직원 모드: 사업장별로 묶어서 보여준다
    const groups = ALL ? [...new Set(people.map((p) => p.store_id))] : [];
    // 전 직원 모드: 사업장별로 묶인 체크 목록 — 여러 명을 고르면 한 명씩 따로(개별로) 지시된다
    const boxes = [];
    const who = ALL
      ? h("div", { class: "stack", style: "max-height:240px;overflow:auto;border:1px solid var(--line-ctl);border-radius:var(--r-md);padding:var(--s2)" }, ...groups.map((sid) => {
        const s = people.find((p) => p.store_id === sid)?.stores, mine = people.filter((p) => p.store_id === sid);
        const bs = mine.map((p) => { const b = h("input", { type: "checkbox", value: p.user_id }); boxes.push(b); return h("label", { style: "display:flex;gap:10px;align-items:center;min-height:44px" }, b,`${p.display_name}${p.job_title ? " (" + p.job_title + ")" : ""}`); });
        const all = h("input", { type: "checkbox" }); all.onchange = () => mine.forEach((_, i) => { bs[i].firstChild.checked = all.checked; });
        return h("div", null, h("label", { style: "display:flex;gap:10px;align-items:center;min-height:44px;font-weight:700" }, all,s?.display_name ?? s?.name ?? t("사업장")), ...bs);
      }))
      : h("select", { class: "inp" }, ...people.map(opt));
    const picked = () => (ALL ? boxes.filter((b) => b.checked).map((b) => b.value) : [who.value]);
    const due = h("input", { type: "date", class: "inp", value: todayKST() });
    let repeat = "none";
    const repBox = h("div", { class: "stack" });
    const drawRep = () => repBox.replaceChildren(h("label", { class: "lbl" }, t("반복")), seg([["none", t("한 번")], ["daily", t("매일")], ["weekly", t("매주")], ["monthly", t("매달")]], repeat, (v) => { repeat = v; drawRep(); }));
    drawRep();
    // 안전 관련: 켜면 번역하지 않고 한국어 원문만 보낸다(락스 희석 비율·보관 온도처럼 틀리면 위험한 내용). 끄고 보내도 서버가 안전 관련 말을 찾으면 한 번 되묻는다
    let safety = false;
    const safeBox = h("div", { class: "stack" });
    const drawSafe = () => safeBox.replaceChildren(
      bigToggle(t("안전 관련 (자동 번역 안 함)"), safety, (v) => { safety = v; drawSafe(); }),
      h("p", { class: "hint" }, t("락스 희석 비율·보관 온도처럼 틀리면 위험한 내용이면 켜 주세요. 번역하지 않고 한국어로만 보내요.")));
    drawSafe();
    const content = h("div", { class: "stack" }, title, memo, h("label", { class: "lbl" }, t("담당자")), who, h("label", { class: "lbl" }, t("마감일 (반복이면 첫 마감일)")), due, repBox, safeBox);
    for (;;) {
      if (!(await modal(t("업무 지시"), content, t("지시하기"), t("취소")))) return;
      if (!title.value.trim()) { toast(t("업무 내용을 입력해 주세요")); continue; }
      const ids = picked();
      if (!ids.length) { toast(t("담당자를 한 명 이상 골라 주세요")); continue; }
      const r = await sendAll(ids, { title: title.value, memo: memo.value, due_date: due.value, repeat, ...(safety ? { safety: true } : {}) });
      if (r === "ok") { toast(ids.length > 1 ? t("{n}명에게 각각 지시했어요. 알림이 가요", { n: ids.length }) : t("지시했어요. 담당자에게 알림이 가요"), 2000); await load(); return; }
      if (r === "partial") { await load(); return; } // 일부는 이미 지시됐다. 같은 사람에게 또 보내지 않게 폼을 닫고 목록을 새로 읽는다
      // "back"·"fail": 아무것도 저장되지 않았으니 입력한 내용 그대로 폼을 다시 연다
    }
  }

  // 번역에 실패한 업무(지시 번역·완료 메모 번역)를 다시 번역한다. 다시 그려도 보던 자리를 유지한다
  async function retranslate(tk) {
    if (retrying.has(tk.id)) return;
    retrying.add(tk.id);
    draw();
    try {
      const r = await api.tkRetranslate(tk.id, ALL);
      toast(r?.translated ? t("번역했어요") : t("번역하지 못했어요. 잠시 뒤에 다시 해 주세요"), 3000);
    } catch (e) { toast(e.message, 4000); }
    retrying.delete(tk.id);
    await load();
  }

  function row(tk) {
    const late = tk.due_date && tk.due_date < data.today;
    const nv = tk.status === "done" ? doneNoteView(tk, origNote) : null;
    const nvBar = nv ? doneNoteBar(tk, nv, () => { flip(origNote, tk.id); draw(); }) : null;
    const again = retryNeeded(tk);
    return h("div", { class: "item col" },
      h("b", null, tk.title, late ? h("span", { class: "badge bad", style: "margin-left:6px" }, t("밀림")) : null, isSafety(tk) ? h("span", { class: "badge bad", style: "margin-left:6px" }, t("⚠ 안전 업무")) : null),
      h("span", { class: "muted" }, `${ALL ? shortName(tk.store_id) + " · " : ""}${t("담당 {name}", { name: tk.assignee_name || t("(삭제된 계정)") })} · ${tk.due_date ? t("마감 {d}", { d: labelMD(tk.due_date) }) : t("마감 없음")}${tk.repeat !== "none" ? " · " + t("{repeat} 반복", { repeat: t(REPEAT_KO[tk.repeat]) }) : ""}`),
      tk.memo && h("span", null, tk.memo),
      trMissing(tk) && h("span", { class: "tr-fail" }, t("번역 없음")), // 번역 실패 + 번역 기능이 켜지기 전에 만든 열린 업무(옛 업무·거기서 복사된 반복 업무). 둘 다 아래 '다시 번역'으로 채운다
      tk.status === "done" && h("span", { class: "ok-text", lang: nv.lang }, `✓ ${tk.done_by_name} ${labelMD(dateOf(tk.done_at))} ${fmtHM(tk.done_at)}${nv.text ? " — " + nv.text : ""}`),
      nvBar,
      h("div", { class: "acc-btns" },
        tk.status === "open" && h("button", { class: "btn ghost slim danger", onclick: () => act(() => api.tkCancel(tk.id, ALL), t("취소했어요")) }, t("지시 취소")),
        tk.status === "done" && h("button", { class: "btn ghost slim", onclick: () => act(() => api.tkReopen(tk.id, ALL), t("다시 열었어요")) }, t("다시 열기")),
        again && h("button", { class: "btn ghost slim", disabled: retrying.has(tk.id), onclick: () => retranslate(tk) }, retrying.has(tk.id) ? t("번역하는 중…") : t("다시 번역"))));
  }

  function view() {
    const list = data ? (tab === "open" ? data.open : data.done) : [];
    // 담당자별 열린 업무·밀림 요약
    const sum = new Map();
    for (const tk of data?.open ?? []) {
      const k = (ALL ? shortName(tk.store_id) + " " : "") + (tk.assignee_name || t("(삭제된 계정)"));
      const s = sum.get(k) ?? { open: 0, late: 0 };
      s.open++; if (tk.due_date && tk.due_date < data.today) s.late++;
      sum.set(k, s);
    }
    return h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, t("← 목록")),
      h("h1", null, ALL ? t("업무지시 (전 직원)") : t("업무지시")),
      h("button", { class: "btn primary", disabled: !!sending, onclick: create }, sending ? t("지시하는 중… ({i}/{n})", { i: sending.i, n: sending.n }) : t("+ 업무 지시")),
      err && h("p", { class: "err" }, t("불러오기 실패: {msg}", { msg: t(err) })),
      sum.size > 0 && h("section", { class: "card" }, h("h2", null, t("담당자별")),
        [...sum].map(([k, s]) => h("div", { class: "lrow" }, h("span", null, k), h("b", null, tx("업무", "{n}건", { n: s.open }), s.late ? h("span", { class: "badge bad", style: "margin-left:6px" }, t("밀림 {n}", { n: s.late })) : null)))),
      h("div", { class: "tabs" }, [["open", tx("업무", "진행 중")], ["done", t("최근 완료")]].map(([k, l]) => h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      !data ? h("p", { class: "muted" }, t("불러오는 중…")) : !list.length ? h("p", { class: "muted" }, tab === "open" ? t("진행 중인 업무가 없어요") : t("최근 완료한 업무가 없어요")) : h("div", { class: "list" }, list.map(row)));
  }

  draw();
  await load();
}
