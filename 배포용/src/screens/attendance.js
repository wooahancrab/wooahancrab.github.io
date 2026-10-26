// 직원(및 매니저 본인) 출퇴근 화면
import { api } from "../lib/api.js";
import { getPosition } from "../lib/geo.js";
import { h, toast, modal, timeInput } from "../lib/ui.js";
import { todayKST, dateOf, fmtHM, fmtDur, minutesBetween, labelMD, monthKey } from "../lib/kst.js";

export const recMinutes = (r) => (r.out_at ? minutesBetween(r.in_at, r.out_at) : null);

export function recBadges(r) {
  const b = [];
  if (r.late_min > 0) b.push(["지각 " + r.late_min + "분", "warn"]);
  if (r.out_source === "self_report" && !r.out_approved) b.push(["직접 입력 · 승인 대기", "info"]);
  else if (r.out_source === "self_report") b.push(["직접 입력", "info"]);
  if (r.out_source === "owner_edit") b.push(["대표 수정", "info"]);
  if (r.out_dist != null && r.out_dist > 100) b.push(["매장 밖 퇴근 " + r.out_dist + "m", "warn2"]);
  return b;
}

export async function renderAttendance(root, profile) {
  let st = null;
  let mine = [];
  let busy = false;
  let err = "";

  const month = monthKey(todayKST());
  const monthStart = month + "-01";

  async function load() {
    try {
      st = await api.attStatus();
      mine = await api.attMine(monthStart);
      err = "";
    } catch (e) { err = e.message; }
    draw();
    if (st?.open && st.stale) askOutReport(st.open);
  }

  const draw = () => {
    const y = scrollY;
    root.replaceChildren(view());
    scrollTo(0, y);
  };

  async function askOutReport(rec) {
    const inp = timeInput("", () => {});
    const content = h("div", { class: "stack" },
      h("p", null, `${labelMD(dateOf(rec.in_at))} ${fmtHM(rec.in_at)}에 출근하고 퇴근을 누르지 않았어요. 몇 시에 퇴근하셨나요?`),
      h("div", { class: "timerow" }, h("span", { class: "tlabel" }, "퇴근시간 :"), inp),
      h("p", { class: "hint" }, "입력한 시각은 대표님 확인 후 확정돼요."));
    for (;;) {
      const ok = await modal("퇴근 시각 입력", content, "입력 완료", "나중에");
      if (!ok) return;
      if (!/^\d{2}:\d{2}$/.test(inp.value)) { toast("시각을 00:00 형식으로 입력해 주세요"); continue; }
      try { await api.attReportOut(rec.id, inp.value); toast("입력했어요. 대표님 확인 후 확정돼요"); await load(); return; } catch (e) { toast(e.message, 5000); }
    }
  }

  async function consent() {
    try { await api.attConsent(); await load(); } catch (e) { toast(e.message, 5000); }
  }

  async function punch(kind) {
    if (busy) return;
    busy = true; draw();
    try {
      let pos = null;
      try { pos = await getPosition(); } catch (e) {
        if (kind === "in") throw e;
        toast("위치를 확인하지 못해 위치 없이 퇴근을 기록해요", 4000); // 퇴근은 위치가 없어도 기록한다
      }
      const res = await api.attPunch(kind, pos);
      if (res?.needs_out_report) { busy = false; await load(); return; }
      toast(kind === "in" ? "출근했어요" : "퇴근했어요. 수고하셨어요!", 3500);
    } catch (e) {
      toast(e.message, 6000);
    }
    busy = false;
    await load();
  }

  function statusCard() {
    const open = st.open && !st.stale ? st.open : null;
    if (open) {
      const el = minutesBetween(open.in_at, st.now);
      return h("section", { class: "card att on" },
        h("div", { class: "att-state" }, "근무 중"),
        h("div", { class: "att-big" }, fmtHM(open.in_at) + " 출근"),
        h("p", { class: "muted" }, `경과 ${fmtDur(el)}` + (open.expected_out ? ` · 예상 퇴근 ${fmtHM(open.expected_out)}` : "")),
        open.late_min > 0 && h("div", { class: "badges" }, h("span", { class: "badge warn" }, `지각 ${open.late_min}분`)),
        h("button", { class: "btn out-btn", disabled: busy, onclick: () => punch("out") }, busy ? "처리 중…" : "퇴근"));
    }
    const today = dateOf(st.now);
    const done = mine.filter((r) => r.work_date === today && r.out_at);
    return h("section", { class: "card att" },
      h("div", { class: "att-state" }, done.length ? "오늘 근무 완료" : "출근 전"),
      done.length > 0 && h("p", { class: "muted" }, done.map((r) => `${fmtHM(r.in_at)} ~ ${fmtHM(r.out_at)}`).join(", ")),
      done.length > 0
        ? h("p", { class: "hint" }, "출퇴근은 하루 한 번만 가능해요. 내일 다시 출근을 눌러 주세요.")
        : [h("button", { class: "btn in-btn", disabled: busy, onclick: () => punch("in") }, busy ? "위치 확인 중…" : "출근"),
           h("p", { class: "hint" }, `매장 ${st.store.radius_m}m 안에서 눌러 주세요. 위치는 버튼을 누른 순간에만 확인해요.`)]);
  }

  function listCard() {
    const total = mine.reduce((s, r) => s + (recMinutes(r) ?? 0), 0);
    const days = new Set(mine.filter((r) => r.out_at).map((r) => r.work_date)).size;
    return h("section", { class: "card" }, h("h2", null, "이번 달 근무"),
      h("p", { class: "att-sum" }, `${days}일 · ${fmtDur(total)}`),
      h("div", { class: "list" }, mine.slice(0, 15).map((r) => {
        const m = recMinutes(r);
        return h("div", { class: "item col static" },
          h("b", null, labelMD(r.work_date)),
          h("span", null, `${fmtHM(r.in_at)} ~ ${r.out_at ? fmtHM(r.out_at) : "퇴근 전"}${m != null ? ` (${fmtDur(m)})` : ""}`),
          recBadges(r).length > 0 && h("span", { class: "badges" }, recBadges(r).map(([t, c]) => h("span", { class: "badge " + c }, t))));
      }),
      !mine.length && h("p", { class: "muted" }, "아직 기록이 없어요")));
  }

  function pushBtn() {
    const on = api.pushEnabled();
    return h("button", { class: "btn " + (on ? "ghost" : "primary") + " slim", onclick: async () => {
      try { await api.enablePush(); toast("알림을 켰어요 (퇴근 확인 알림을 받아요)"); draw(); } catch (e) { toast(e.message, 5000); }
    } }, on ? "🔔 퇴근 알림 켜짐" : "🔔 퇴근 알림 켜기");
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, "불러오기 실패: " + err), h("button", { class: "btn ghost", onclick: load }, "다시 시도"));
    if (!st) return h("div", { class: "page" }, h("p", { class: "muted" }, "불러오는 중…"));
    if (!st.me.consented) {
      return h("div", { class: "page" }, h("h1", null, "위치 정보 수집 동의"),
        h("section", { class: "card" },
          h("p", null, "출근·퇴근 확인을 위해 아래와 같이 위치 정보를 수집해요."),
          h("ul", { class: "plain" },
            h("li", null, "수집 시점: 출근·퇴근 버튼을 누른 순간 한 번만 (계속 추적하지 않아요)"),
            h("li", null, "수집 목적: 매장 안에서 출근했는지, 출퇴근 시각 확인"),
            h("li", null, "보관: 출퇴근 기록과 함께 근로기준법상 보관 기간 동안 보관"),
            h("li", null, "열람: 본인과 대표·매니저만")),
          h("p", { class: "hint" }, "동의하지 않으면 출퇴근 버튼을 사용할 수 없어요."),
          h("button", { class: "btn primary", onclick: consent }, "동의하고 시작")));
    }
    return h("div", { class: "page" },
      !st.store.configured && h("div", { class: "banner" }, "매장 위치가 아직 설정되지 않았어요. 대표님이 설정하면 출근할 수 있어요."),
      statusCard(), pushBtn(), listCard());
  }

  draw();
  await load();
}
