// 대표 출퇴근 관리: 오늘 현황 / 누락·승인 / 월별 / 설정(매장 위치·직원 근무 방식)
import { api } from "../lib/api.js";
import { getPosition } from "../lib/geo.js";
import { h, toast, modal, timeInput, seg } from "../lib/ui.js";
import { todayKST, addDays, dateOf, fmtHM, fmtDur, kstIso, minutesBetween, labelMD, monthKey, monthLabel, dow } from "../lib/kst.js";
import { recMinutes, recBadges } from "./attendance.js";

const ROLE_KO = { manager: "매니저", staff: "직원" };
const GRACE_MS = 30 * 60000;

export async function renderAttendanceAdmin(root, onBack, opts = {}) {
  const master = opts.master !== false; // 부대표는 매장 위치·근무 방식 설정을 못 본다
  const today = todayKST();
  let tab = "today"; // today | attention | month | settings
  let emps = [];
  let rows = [];
  let store = null;
  let month = monthKey(today);
  let detailUser = null;
  let loading = true;
  let err = "";

  const draw = () => { const y = scrollY; root.replaceChildren(view()); scrollTo(0, y); };

  async function load() {
    loading = true; draw();
    try {
      [emps, rows, store] = await Promise.all([api.attEmployees(), api.attAll(addDays(today, -120)), api.attStore()]);
      err = "";
    } catch (e) { err = e.message; }
    loading = false; draw();
  }

  const empName = (id) => emps.find((e) => e.user_id === id)?.display_name;
  const empTitle = (id) => emps.find((e) => e.user_id === id)?.job_title ?? "";
  const nameOf = (r) => r.user_name || empName(r.user_id) || "(삭제된 계정)";
  const expectedBase = (r) => (r.expected_out ? new Date(r.expected_out).getTime() : new Date(r.in_at).getTime() + 12 * 3600e3);
  const overdue = (r) => !r.out_at && Date.now() > expectedBase(r) + GRACE_MS;
  const badge = (t, c) => h("span", { class: "badge " + c }, t);

  const workText = (e) => e.work_type === "flex"
    ? `시간 자유 · 하루 ${fmtDur(e.daily_minutes ?? 0)}`
    : e.shift_start ? `시간 고정 · ${e.shift_start.slice(0, 5)} ~ ${(e.shift_end ?? "").slice(0, 5)}` : "근무 방식 미설정";

  /* ---------- 오늘 ---------- */
  function todayTab() {
    const nowHM = fmtHM(new Date().toISOString());
    return h("div", { class: "list" }, emps.map((e) => {
      const mine = rows.filter((r) => r.user_id === e.user_id && (r.work_date === today || !r.out_at));
      const open = mine.find((r) => !r.out_at);
      const done = mine.filter((r) => r.out_at && r.work_date === today);
      let state;
      if (open) state = h("span", { class: overdue(open) ? "state-bad" : "state-on" }, overdue(open) ? `퇴근 누락? (${open.work_date === today ? "" : labelMD(open.work_date) + " "}${fmtHM(open.in_at)} 출근)` : `근무 중 · ${open.work_date === today ? "" : labelMD(open.work_date) + " "}${fmtHM(open.in_at)} 출근`);
      else if (done.length) state = h("span", null, done.map((r) => `${fmtHM(r.in_at)}~${fmtHM(r.out_at)} (${fmtDur(recMinutes(r))})`).join(", "));
      else {
        const late = e.work_type === "fixed" && e.shift_start && nowHM > e.shift_start.slice(0, 5);
        state = h("span", { class: late ? "state-bad" : "state-off" }, late ? `미출근 (출근 예정 ${e.shift_start.slice(0, 5)})` : "미출근");
      }
      const rec = open ?? done[done.length - 1];
      return h("div", { class: "empcard" },
        h("div", { class: "top2" }, h("b", null, e.display_name), h("span", { class: "muted" }, [e.job_title, ROLE_KO[e.role] ?? e.role].filter(Boolean).join(" · "))),
        state,
        rec && recBadges(rec).length > 0 && h("div", { class: "badges", style: "justify-content:flex-start" }, recBadges(rec).map(([t, c]) => badge(t, c))),
        h("span", { class: "muted" }, workText(e)));
    }), !emps.length && h("p", { class: "muted" }, "등록된 직원이 없어요. 👤 계정 관리에서 직원을 추가해 주세요."));
  }

  /* ---------- 누락·승인 ---------- */
  function attentionTab() {
    const missing = rows.filter(overdue);
    const pending = rows.filter((r) => r.out_at && !r.out_approved);
    return h("div", { class: "list" },
      h("button", { class: "btn ghost slim", onclick: addRecord }, "+ 빠진 기록 직접 추가"),
      missing.length > 0 && h("h2", { class: "sec-title" }, `퇴근 누락 ${missing.length}건`),
      missing.map((r) => h("div", { class: "empcard" },
        h("div", { class: "top2" }, h("b", null, nameOf(r)), badge("퇴근 누락", "bad")),
        h("span", null, `${labelMD(r.work_date)} ${fmtHM(r.in_at)} 출근` + (r.expected_out ? ` · 예상 퇴근 ${fmtHM(r.expected_out)}` : "")),
        h("button", { class: "btn primary slim", onclick: () => editRecord(r) }, "퇴근 시각 입력"))),
      pending.length > 0 && h("h2", { class: "sec-title" }, `직원이 입력한 퇴근 ${pending.length}건 · 확인 필요`),
      pending.map((r) => h("div", { class: "empcard" },
        h("div", { class: "top2" }, h("b", null, nameOf(r)), badge("승인 대기", "info")),
        h("span", null, `${labelMD(r.work_date)} ${fmtHM(r.in_at)} ~ ${fmtHM(r.out_at)} (${fmtDur(recMinutes(r))})`),
        h("div", { class: "acc-btns" },
          h("button", { class: "btn primary slim", onclick: async () => { try { await api.attApprove(r.id); toast("승인했어요"); await load(); } catch (e) { toast(e.message, 5000); } } }, "승인"),
          h("button", { class: "btn ghost slim", onclick: () => editRecord(r) }, "수정")))),
      !missing.length && !pending.length && h("p", { class: "muted" }, "확인할 항목이 없어요 👍"));
  }

  /* ---------- 월별 ---------- */
  function monthTab() {
    const keys = [0, 1, 2].map((i) => { const [y, m] = today.slice(0, 7).split("-").map(Number); return new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7); });
    return h("div", null,
      h("div", { class: "seg" }, keys.map((k) => h("button", { class: "segbtn" + (month === k ? " on" : ""), onclick: () => { month = k; detailUser = null; draw(); } }, monthLabel(k)))),
      h("button", { class: "btn primary slim", style: "margin-top:10px", onclick: exportExcel }, `📥 ${monthLabel(month)} 출퇴근 엑셀 다운로드`),
      h("div", { class: "list", style: "margin-top:10px" }, emps.map((e) => {
        const mr = rows.filter((r) => r.user_id === e.user_id && monthKey(r.work_date) === month);
        const total = mr.reduce((s, r) => s + (recMinutes(r) ?? 0), 0);
        const days = new Set(mr.filter((r) => r.out_at).map((r) => r.work_date)).size;
        const lates = mr.filter((r) => r.late_min > 0).length;
        const open = detailUser === e.user_id;
        return h("div", { class: "empcard" },
          h("button", { class: "item", onclick: () => { detailUser = open ? null : e.user_id; draw(); } },
            h("b", null, e.display_name),
            h("span", null, `${days}일 · ${fmtDur(total)}` + (lates ? ` · 지각 ${lates}회` : ""))),
          open && h("div", { class: "list" }, mr.map((r) => h("div", { class: "item col static" },
            h("b", null, labelMD(r.work_date)),
            h("span", null, `${fmtHM(r.in_at)} ~ ${r.out_at ? fmtHM(r.out_at) : "퇴근 전"}` + (r.out_at ? ` (${fmtDur(recMinutes(r))})` : "")),
            recBadges(r).length > 0 && h("span", { class: "badges" }, recBadges(r).map(([t, c]) => badge(t, c))),
            h("button", { class: "linkbtn", onclick: () => editRecord(r) }, "수정"))),
          !mr.length && h("p", { class: "muted" }, "기록이 없어요")));
      })));
  }

  /* ---------- 설정 ---------- */
  function settingsTab() {
    const radius = h("input", { type: "number", class: "inp small", min: "30", max: "500", value: String(store?.radius_m ?? 100), "aria-label": "반경(미터)" });
    return h("div", null,
      h("section", { class: "card" }, h("h2", null, "매장 위치"),
        h("p", { class: store?.lat != null ? "" : "err" }, store?.lat != null ? `설정됨 (${store.lat.toFixed(5)}, ${store.lng.toFixed(5)})` : "아직 설정되지 않았어요. 직원이 출근할 수 없어요."),
        h("p", { class: "hint" }, "매장 안에서 이 버튼을 눌러 주세요. 지금 이 폰의 위치가 매장 위치가 돼요."),
        h("button", { class: "btn primary", onclick: setStoreHere }, "📍 현재 위치를 매장 위치로 설정"),
        h("div", { class: "row2" }, h("span", null, "출근 가능 반경"), radius, h("span", null, "m"),
          h("button", { class: "btn ghost slim", style: "margin:0;width:auto;padding:0 16px", onclick: async () => {
            if (store?.lat == null) { toast("먼저 매장 위치를 설정해 주세요"); return; }
            try { await api.attSetStore(store.lat, store.lng, Number(radius.value)); toast("반경을 저장했어요"); await load(); } catch (e) { toast(e.message, 5000); }
          } }, "저장"))),
      h("section", { class: "card" }, h("h2", null, "직원별 근무 방식"),
        h("p", { class: "hint" }, "고정: 기준 출근·퇴근 시각 (늦으면 지각). 자유: 하루 근무시간만 정함 (출근 + 근무시간 = 예상 퇴근)."),
        emps.map((e) => h("div", { class: "empcard" },
          h("div", { class: "top2" }, h("b", null, e.display_name), h("span", { class: "muted" }, ROLE_KO[e.role] ?? e.role)),
          h("span", null, workText(e)),
          h("span", { class: "muted" }, e.consent_at || e.consented ? "위치 동의 완료" : "위치 동의 전"),
          h("button", { class: "btn ghost slim", onclick: () => editWork(e) }, "근무 방식 수정"))),
        !emps.length && h("p", { class: "muted" }, "👤 계정 관리에서 직원 계정을 먼저 추가해 주세요.")));
  }

  async function setStoreHere() {
    let pos;
    try { pos = await getPosition(); } catch (e) { toast(e.message, 5000); return; }
    const poor = pos.acc > 50;
    const ok = await modal("매장 위치로 설정할까요?", h("div", { class: "stack" },
      h("p", null, `현재 위치 (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}) · 정확도 약 ${Math.round(pos.acc)}m`),
      poor && h("p", { class: "err" }, "정확도가 낮아요. 매장 입구 쪽이나 창가에서 다시 해 보시길 권해요."),
      h("p", { class: "hint" }, "지금 매장 안에 계신가요? 이 위치를 기준으로 직원 출근 범위가 정해져요.")), "설정", "취소");
    if (!ok) return;
    try { await api.attSetStore(pos.lat, pos.lng, store?.radius_m ?? 100); toast("매장 위치를 설정했어요"); await load(); } catch (e) { toast(e.message, 5000); }
  }

  async function editWork(e) {
    const s = { type: e.work_type ?? "fixed", start: (e.shift_start ?? "").slice(0, 5), end: (e.shift_end ?? "").slice(0, 5), hours: e.daily_minutes ? String(e.daily_minutes / 60) : "8" };
    const holder = h("div", { class: "stack" });
    const hours = h("input", { type: "number", class: "inp small", step: "0.5", min: "1", max: "20", value: s.hours, "aria-label": "하루 근무시간", oninput: (ev) => (s.hours = ev.target.value) });
    const render = () => holder.replaceChildren(
      seg([["fixed", "시간 고정"], ["flex", "시간 자유"]], s.type, (v) => { s.type = v; render(); }),
      s.type === "fixed"
        ? h("div", { class: "stack" },
            h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "출근시간 :"), timeInput(s.start, (v) => (s.start = v))),
            h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "퇴근시간 :"), timeInput(s.end, (v) => (s.end = v))))
        : h("div", { class: "row2" }, h("span", null, "하루 근무시간"), hours, h("span", null, "시간 (휴게 포함)")));
    render();
    for (;;) {
      if (!(await modal(`${e.display_name} 근무 방식`, holder, "저장", "취소"))) return;
      const f = s.type === "fixed"
        ? { work_type: "fixed", shift_start: s.start, shift_end: s.end }
        : { work_type: "flex", daily_minutes: Math.round(Number(s.hours) * 60) };
      if (s.type === "fixed" && !(/^\d{2}:\d{2}$/.test(s.start) && /^\d{2}:\d{2}$/.test(s.end))) { toast("출근·퇴근 시각을 00:00 형식으로 입력해 주세요"); continue; }
      if (s.type === "flex" && !(f.daily_minutes >= 30)) { toast("하루 근무시간을 입력해 주세요"); continue; }
      try { await api.attSetWork(e.user_id, f); toast("저장했어요"); await load(); return; } catch (er) { toast(er.message, 5000); }
    }
  }

  async function editRecord(r) {
    const inInp = timeInput(fmtHM(r.in_at), () => {});
    const outInp = timeInput(r.out_at ? fmtHM(r.out_at) : "", () => {});
    const reason = h("input", { type: "text", class: "inp", placeholder: "수정 사유 (예: 퇴근 누락 확인)" });
    const content = h("div", { class: "stack" },
      h("p", null, `${nameOf(r)} · ${labelMD(r.work_date)}`),
      h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "출근시간 :"), inInp),
      h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "퇴근시간 :"), outInp),
      reason, h("p", { class: "hint" }, "수정 이력이 남아요."));
    for (;;) {
      if (!(await modal("출퇴근 기록 수정", content, "저장", "취소"))) return;
      if (!/^\d{2}:\d{2}$/.test(inInp.value) || (outInp.value && !/^\d{2}:\d{2}$/.test(outInp.value))) { toast("시각을 00:00 형식으로 입력해 주세요"); continue; }
      if (!reason.value.trim()) { toast("수정 사유를 입력해 주세요"); continue; }
      const f = {};
      const newIn = kstIso(r.work_date, inInp.value);
      if (inInp.value !== fmtHM(r.in_at)) f.in_at = newIn;
      if (outInp.value && outInp.value !== (r.out_at ? fmtHM(r.out_at) : "")) f.out_at = kstIso(dateOf(f.in_at ?? r.in_at), outInp.value, f.in_at ?? r.in_at);
      if (!f.in_at && !f.out_at) { toast("바뀐 내용이 없어요"); continue; }
      try { await api.attEdit(r.id, f, reason.value); toast("수정했어요"); await load(); return; } catch (e) { toast(e.message, 5000); }
    }
  }

  async function addRecord() {
    if (!emps.length) { toast("먼저 직원 계정을 추가해 주세요"); return; }
    const sel = h("select", { class: "inp" }, emps.map((e) => h("option", { value: e.user_id }, e.display_name)));
    const date = h("input", { type: "date", class: "inp", value: addDays(today, -1) });
    const inInp = timeInput("", () => {});
    const outInp = timeInput("", () => {});
    const reason = h("input", { type: "text", class: "inp", placeholder: "사유 (예: 출근 버튼을 못 눌렀음)" });
    const content = h("div", { class: "stack" }, sel, date,
      h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "출근시간 :"), inInp),
      h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "퇴근시간 :"), outInp), reason);
    for (;;) {
      if (!(await modal("빠진 기록 추가", content, "추가", "취소"))) return;
      if (!date.value || !/^\d{2}:\d{2}$/.test(inInp.value) || !/^\d{2}:\d{2}$/.test(outInp.value)) { toast("날짜와 시각을 확인해 주세요"); continue; }
      if (!reason.value.trim()) { toast("사유를 입력해 주세요"); continue; }
      const inAt = kstIso(date.value, inInp.value);
      const outAt = kstIso(date.value, outInp.value, inAt);
      try { await api.attAdd({ user_id: sel.value, in_at: inAt, out_at: outAt, reason: reason.value }); toast("추가했어요"); await load(); return; } catch (e) { toast(e.message, 5000); }
    }
  }

  /* ---------- 엑셀 내려받기 ---------- */
  async function loadXlsx() {
    if (window.XLSX) return window.XLSX;
    await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok;
      s.onerror = () => fail(new Error("엑셀 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요"));
      document.head.append(s);
    });
    return window.XLSX;
  }

  const SRC_KO = { punch: "앱 버튼", self_report: "직원 직접 입력", owner_edit: "대표 수정·추가" };
  const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

  function buildSheets() {
    const mr = rows.filter((r) => monthKey(r.work_date) === month).sort((a, b) => a.in_at.localeCompare(b.in_at));
    const detail = [["날짜", "요일", "이름", "직책", "출근", "퇴근", "근무시간(분)", "근무시간(시간)", "지각(분)", "퇴근 입력 방식", "승인 상태", "매장 밖 퇴근(m)", "비고"]];
    for (const r of mr) {
      const m = recMinutes(r);
      detail.push([
        r.work_date, DOW_KO[dow(r.work_date)], nameOf(r), empTitle(r.user_id), fmtHM(r.in_at), r.out_at ? fmtHM(r.out_at) : "",
        m ?? "", m != null ? Math.round((m / 60) * 100) / 100 : "", r.late_min || 0,
        r.out_at ? (SRC_KO[r.out_source] ?? "") : "", r.out_at ? (r.out_approved ? "확정" : "승인 대기") : "",
        r.out_dist != null && r.out_dist > 100 ? r.out_dist : "",
        !r.out_at ? "퇴근 기록 없음" : "",
      ]);
    }
    const sum = [["이름", "직책", "근무일수", "총 근무시간(분)", "총 근무시간(시간)", "지각 횟수", "지각 합계(분)", "퇴근 기록 없음", "승인 대기"]];
    const names = [...new Set(mr.map((r) => r.user_id ?? nameOf(r)))];
    for (const key of names) {
      const own = mr.filter((r) => (r.user_id ?? nameOf(r)) === key);
      const total = own.reduce((s, r) => s + (recMinutes(r) ?? 0), 0);
      sum.push([
        nameOf(own[0]), empTitle(own[0].user_id), new Set(own.filter((r) => r.out_at).map((r) => r.work_date)).size, total, Math.round((total / 60) * 100) / 100,
        own.filter((r) => r.late_min > 0).length, own.reduce((s, r) => s + (r.late_min || 0), 0),
        own.filter((r) => !r.out_at).length, own.filter((r) => r.out_at && !r.out_approved).length,
      ]);
    }
    return { detail, sum, count: mr.length };
  }

  async function exportExcel() {
    const { detail, sum, count } = buildSheets();
    if (!count) { toast(`${monthLabel(month)}에는 출퇴근 기록이 없어요`); return; }
    try {
      const X = await loadXlsx();
      const wb = X.utils.book_new();
      const s1 = X.utils.aoa_to_sheet(detail);
      s1["!cols"] = [{ wch: 12 }, { wch: 5 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 9 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 16 }];
      const s2 = X.utils.aoa_to_sheet(sum);
      s2["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 9 }, { wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }];
      X.utils.book_append_sheet(wb, s2, "월 요약");
      X.utils.book_append_sheet(wb, s1, "근무 기록");
      X.writeFile(wb, `출퇴근_${month}.xlsx`);
      toast(`출퇴근_${month}.xlsx 를 내려받았어요`, 4000);
    } catch (e) { toast(e.message, 5000); }
  }

  function view() {
    const attn = rows.filter(overdue).length + rows.filter((r) => r.out_at && !r.out_approved).length;
    return h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, "← 목록"),
      h("h1", null, opts.title ?? "출퇴근 관리"),
      h("div", { class: "subtabs" }, [["today", "오늘"], ["attention", "누락·승인" + (attn ? ` (${attn})` : "")], ["month", "월별"], ...(master ? [["settings", "설정"]] : [])].map(([k, l]) =>
        h("button", { class: "tab" + (tab === k ? " on" : ""), onclick: () => { tab = k; draw(); } }, l))),
      loading ? h("p", { class: "muted" }, "불러오는 중…") : err ? h("p", { class: "err" }, "불러오기 실패: " + err) :
        tab === "today" ? todayTab() : tab === "attention" ? attentionTab() : tab === "month" ? monthTab() : settingsTab());
  }

  draw();
  await load();
}
