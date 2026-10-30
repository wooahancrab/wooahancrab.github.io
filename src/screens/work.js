// 업무 기록(일지·일정·기록함): 담당자가 자기 일을 쌓고, 대표·부대표·전무·경리가 한곳에서 본다.
// 본인 것은 본인만 수정하고, 전체 보기 권한이 없으면 내 기록만 보인다(서버 RLS가 정함 — work-archive.sql).
import { api } from "../lib/api.js";
import { h, toast, modal, confirmDialog, copyText } from "../lib/ui.js";
import { todayKST, labelMD } from "../lib/kst.js";

const TABS = [["log", "📝 일지"], ["ev", "📅 일정"], ["note", "🗂 기록함"]];
const TABLE = { log: "work_logs", ev: "work_events", note: "work_notes" };

const SHORT = { gejang: "게장", ck: "CK", fnb: "F&B" };

export async function renderWork(root, opts = {}) {
  const RO = !!opts.all; // 대표·부대표 보고판용: 전 사업장 보기(새 글 쓰기는 숨김)
  const sn = (r) => (RO ? (SHORT[(opts.stores ?? []).find((s) => s.id === r.store_id)?.app_key] ?? "") + " " : "");
  const prof = await api.getProfile();
  const me = prof.user_id;
  const viewer = prof.role === "owner" || prof.role === "deputy" || !!prof.can_settle;
  const today = todayKST();
  let tab = "log", who = "all", q = "", loading = true, err = "";
  let data = { work_logs: [], work_events: [], work_notes: [] };

  async function load() {
    try {
      const [a, b, c] = await Promise.all(["work_logs", "work_events", "work_notes"].map((t) => api.wkList(t, RO)));
      data = { work_logs: a, work_events: b, work_notes: c }; err = "";
    } catch (e) { err = e.message; }
    loading = false; draw();
  }
  const canEdit = (r) => r.author_id === me || prof.role === "owner";
  const vis = (rows) => rows.filter((r) => who === "all" || r.author_id === who);
  const authors = () => {
    const m = new Map();
    for (const t of Object.values(data)) for (const r of t) m.set(r.author_id, r.author_name || "(이름 없음)");
    return [...m];
  };
  async function save(table, row, okMsg = "저장했어요") {
    try { await api.wkSave(table, row); toast(okMsg, 1800); await load(); return true; } catch (e) { toast(e.message, 5000); return false; }
  }
  async function remove(table, r, what) {
    if (!(await confirmDialog("지울까요?", [what], "취소", "지우기"))) return;
    try { await api.wkDelete(table, r.id); await load(); } catch (e) { toast(e.message, 5000); }
  }
  const field = (label, el) => h("label", { class: "stack", style: "display:block;margin:6px 0" }, h("span", { class: "muted", style: "font-size:12px" }, label), el);
  const area = (v, ph, rows = 3) => { const t = h("textarea", { class: "inp", rows: String(rows), placeholder: ph }); t.value = v ?? ""; return t; };
  const input = (v, ph, type = "text") => { const i = h("input", { class: "inp", type, placeholder: ph }); i.value = v ?? ""; return i; };

  /* 일지 */
  async function editLog(date = today) {
    const mineOn = (d) => data.work_logs.find((r) => r.author_id === me && r.log_date === d);
    const ex = mineOn(date);
    const dt = input(date, "", "date"), done = area(ex?.done, "오늘 한 일", 4), plan = area(ex?.plan, "내일 할 일"), blk = area(ex?.blockers, "막힌 점·요청 (없으면 비워도 돼요)", 2);
    dt.onchange = () => { const o = mineOn(dt.value); done.value = o?.done ?? ""; plan.value = o?.plan ?? ""; blk.value = o?.blockers ?? ""; };
    for (;;) {
      if (!(await modal("업무 일지", h("div", null, field("날짜", dt), field("오늘 한 일", done), field("내일 할 일", plan), field("막힌 점·요청", blk)), "저장", "취소"))) return;
      if (!done.value.trim() && !plan.value.trim()) { toast("한 일이나 할 일을 적어 주세요"); continue; }
      const cur = mineOn(dt.value);
      if (await save("work_logs", { ...(cur ? { id: cur.id } : {}), log_date: dt.value, done: done.value.trim(), plan: plan.value.trim(), blockers: blk.value.trim() })) return;
    }
  }
  const logView = () => {
    const list = vis(data.work_logs).sort((a, b) => b.log_date.localeCompare(a.log_date));
    const todayMine = data.work_logs.find((r) => r.author_id === me && r.log_date === today);
    return [
      !RO && h("button", { class: "btn primary", onclick: () => editLog() }, todayMine ? "✏ 오늘 일지 고치기" : "✏ 오늘 일지 쓰기"),
      !list.length ? h("p", { class: "muted" }, "아직 일지가 없어요. 하루 끝에 한 일·내일 할 일을 몇 줄 남겨 보세요.")
        : list.map((r) => h("div", { class: "card", style: "margin:8px 0;padding:12px;border:1px solid #ddd;border-radius:12px" },
          h("div", { style: "display:flex;justify-content:space-between" }, h("b", null, labelMD(r.log_date)), h("span", { class: "muted" }, sn(r) + r.author_name)),
          r.done && h("div", { style: "white-space:pre-wrap;margin-top:6px" }, h("b", null, "한 일  "), r.done),
          r.plan && h("div", { style: "white-space:pre-wrap;margin-top:4px" }, h("b", null, "내일  "), r.plan),
          r.blockers && h("div", { class: "err", style: "white-space:pre-wrap;margin-top:4px" }, "막힌 점  " + r.blockers),
          canEdit(r) && h("div", { style: "margin-top:6px" },
            h("button", { class: "linkbtn", onclick: () => editLog(r.log_date) }, "수정"), "  ", h("button", { class: "linkbtn", onclick: () => remove("work_logs", r, `${r.log_date} 일지`) }, "삭제")))),
    ];
  };

  /* 일정 */
  async function editEv(ev) {
    const t = input(ev?.title, "제목 (예: ○○유통 미팅)"), d = input(ev?.ev_date ?? today, "", "date"), ed = input(ev?.end_date ?? "", "", "date"), tm = input(ev?.ev_time, "시간 (예: 14:00)"), pl = input(ev?.place, "장소·거래처"), nt = area(ev?.note, "메모", 2);
    // 시작일을 바꿨는데 종료일이 그보다 빠르면 종료일을 비운다(기간 일정이 아니면 비워 둔다)
    d.onchange = () => { if (ed.value && ed.value < d.value) ed.value = ""; };
    for (;;) {
      if (!(await modal(ev ? "일정 수정" : "일정 추가", h("div", null, field("제목", t), field("시작일", d), field("종료일 (며칠에 걸친 일정이면 선택, 하루면 비워 두세요)", ed), field("시간", tm), field("장소·거래처", pl), field("메모", nt)), "저장", "취소"))) return;
      if (!t.value.trim() || !d.value) { toast("제목과 시작일을 넣어 주세요"); continue; }
      if (ed.value && ed.value < d.value) { toast("종료일은 시작일보다 빠를 수 없어요"); continue; }
      if (await save("work_events", { ...(ev ? { id: ev.id } : {}), title: t.value.trim(), ev_date: d.value, end_date: ed.value && ed.value !== d.value ? ed.value : null, ev_time: tm.value.trim(), place: pl.value.trim(), note: nt.value.trim() })) return;
    }
  }
  async function finishEv(ev) {
    const res = area(ev.result, "결과 한 줄 (예: 견적 받기로 함, 다음 주 재방문)", 3);
    if (!(await modal("일정 완료", h("div", null, h("p", { class: "muted" }, ev.title), res), "완료로 기록", "취소"))) return;
    await save("work_events", { id: ev.id, done: true, result: res.value.trim() }, "완료로 기록했어요");
  }
  const evCard = (r) => h("div", { class: "card", style: "margin:8px 0;padding:12px;border:1px solid #ddd;border-radius:12px" + (r.done ? ";opacity:.75" : "") },
    h("div", { style: "display:flex;justify-content:space-between;gap:8px" },
      h("b", null, `${labelMD(r.ev_date)}${r.end_date && r.end_date !== r.ev_date ? " ~ " + labelMD(r.end_date) : ""}${r.ev_time ? " " + r.ev_time : ""} · ${r.title}`), h("span", { class: "muted" }, sn(r) + r.author_name)),
    r.place && h("div", { class: "muted" }, "📍 " + r.place),
    r.note && h("div", { style: "white-space:pre-wrap" }, r.note),
    r.done && h("div", { class: "ok-text", style: "white-space:pre-wrap" }, "✔ " + (r.result || "완료")),
    canEdit(r) && h("div", { style: "margin-top:6px;display:flex;gap:10px;flex-wrap:wrap" },
      !r.done && h("button", { class: "btn ghost slim", onclick: () => finishEv(r) }, "완료·결과 남기기"),
      h("button", { class: "linkbtn", onclick: () => editEv(r) }, "수정"), h("button", { class: "linkbtn", onclick: () => remove("work_events", r, r.title) }, "삭제")));
  const evView = () => {
    const all = vis(data.work_events);
    const endOf = (r) => r.end_date || r.ev_date; // 기간 일정은 종료일까지는 "예정"(진행 중)
    const up = all.filter((r) => !r.done && endOf(r) >= today).sort((a, b) => (a.ev_date + a.ev_time).localeCompare(b.ev_date + b.ev_time));
    const late = all.filter((r) => !r.done && endOf(r) < today).sort((a, b) => a.ev_date.localeCompare(b.ev_date));
    const past = all.filter((r) => r.done).sort((a, b) => b.ev_date.localeCompare(a.ev_date)).slice(0, 40);
    const sec = (t, l, cls = "") => l.length > 0 && h("div", null, h("div", { class: "cat-title " + cls }, t), l.map(evCard));
    return [!RO && h("button", { class: "btn primary", onclick: () => editEv() }, "＋ 일정 추가"),
      !all.length && h("p", { class: "muted" }, "등록된 일정이 없어요. 미팅·납기·마감을 날짜와 함께 넣어 두세요."),
      sec("⚠ 지났는데 결과가 없는 일정", late, "err"), sec("예정", up), sec("완료·지난 일정", past)];
  };

  /* 기록함 */
  async function editNote(n) {
    const t = input(n?.title, "제목 (예: ○○유통 단가 협의)"), b = area(n?.body, "내용·결정사항", 6), tg = input(n?.tags, "태그 (쉼표로 구분, 예: 거래처, 단가)"), lk = area(n?.link, "링크나 NAS 경로를 한 줄에 하나씩\n예) https://…  또는  \\\\NAS\\영업\\단가표.xlsx", 3), d = input(n?.note_date ?? today, "", "date");
    for (;;) {
      if (!(await modal(n ? "기록 수정" : "기록 추가", h("div", null, field("제목", t), field("날짜", d), field("내용", b), field("태그 (자주 쓰는 자료는 '고정'을 넣으면 맨 위에 나와요)", tg), field("자료 위치 (링크·NAS 경로)", lk)), "저장", "취소"))) return;
      if (!t.value.trim()) { toast("제목을 넣어 주세요"); continue; }
      if (await save("work_notes", { ...(n ? { id: n.id } : {}), title: t.value.trim(), body: b.value.trim(), tags: tg.value.trim(), link: lk.value.trim(), note_date: d.value || today })) return;
    }
  }
  // 자료 위치: http 로 시작하면 링크, 아니면 NAS 경로로 보고 복사 버튼을 붙인다
  const locs = (n) => String(n.link ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => /^https?:\/\//i.test(s)
    ? h("div", null, h("a", { href: s, target: "_blank", rel: "noopener" }, "🔗 " + s))
    : h("div", null, "📁 " + s + " ", h("button", { class: "linkbtn", onclick: async () => { toast((await copyText(s)) ? "경로를 복사했어요. 탐색기 주소창에 붙여넣으세요" : "복사하지 못했어요", 3000); } }, "복사")));
  const noteView = () => {
    const key = q.trim().toLowerCase();
    const list = vis(data.work_notes).filter((n) => !key || [n.title, n.body, n.tags, n.author_name].join(" ").toLowerCase().includes(key))
      .sort((a, b) => b.note_date.localeCompare(a.note_date) || b.created_at.localeCompare(a.created_at));
    const search = h("input", { class: "inp", type: "search", placeholder: "검색 (제목·내용·태그)", value: q });
    search.oninput = () => { q = search.value; const pos = search.selectionStart; draw(); const s = root.querySelector('input[type="search"]'); s?.focus(); s?.setSelectionRange(pos, pos); };
    const pinned = vis(data.work_notes).filter((n) => /(^|,)\s*고정\s*(,|$)/.test(n.tags));
    return [!RO && h("button", { class: "btn primary", onclick: () => editNote() }, "＋ 기록 추가"),
      pinned.length > 0 && h("div", { class: "card", style: "margin:8px 0;padding:10px 12px;border:1px solid #ddd;border-radius:12px;background:#fff8ee" },
        h("b", null, "📌 자주 쓰는 자료"), pinned.map((n) => h("div", { style: "margin-top:6px" }, h("div", null, n.title), locs(n)))),
      search,
      !list.length ? h("p", { class: "muted" }, key ? "찾는 기록이 없어요" : "기록이 없어요. 미팅 내용·협의·결정사항을 남겨 두면 나중에 검색해서 찾을 수 있어요.")
        : list.map((n) => h("details", { class: "card", style: "margin:8px 0;padding:10px 12px;border:1px solid #ddd;border-radius:12px" },
          h("summary", null, h("b", null, n.title), h("span", { class: "muted" }, `  ${labelMD(n.note_date)} · ${sn(n)}${n.author_name}`),
            n.tags && h("div", { class: "muted", style: "font-size:12px" }, n.tags.split(",").map((x) => "#" + x.trim()).filter((x) => x.length > 1).join(" "))),
          n.body && h("div", { style: "white-space:pre-wrap;margin-top:6px" }, n.body),
          locs(n),
          canEdit(n) && h("div", { style: "margin-top:6px" }, h("button", { class: "linkbtn", onclick: () => editNote(n) }, "수정"), "  ", h("button", { class: "linkbtn", onclick: () => remove("work_notes", n, n.title) }, "삭제"))))];
  };

  function draw() {
    const y = scrollY;
    const people = authors();
    root.replaceChildren(h("div", { class: "page" },
      opts.onBack && h("button", { class: "linkbtn back", onclick: opts.onBack }, "← 목록"),
      h("h1", null, "🗂 업무 기록"),
      h("p", { class: "muted", style: "font-size:12px" }, viewer ? "전체 기록을 볼 수 있어요. 수정·삭제는 쓴 사람만 해요." : "내가 쓴 기록만 보여요. 대표·전무가 함께 봐요."),
      h("div", { class: "tabs" }, TABS.map(([k, l]) => h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      viewer && people.length > 1 && (() => { const s = h("select", { class: "inp" }, h("option", { value: "all" }, "전체 보기"), people.map(([id, n]) => h("option", { value: id }, n))); s.value = who; s.onchange = () => { who = s.value; draw(); }; return s; })(),
      loading ? h("p", { class: "muted" }, "불러오는 중…")
        : err ? h("p", { class: "err" }, "불러오기 실패: " + err + " (work-archive.sql 실행 여부 확인)")
        : tab === "log" ? logView() : tab === "ev" ? evView() : noteView()));
    scrollTo(0, y);
  }
  draw();
  await load();
}
