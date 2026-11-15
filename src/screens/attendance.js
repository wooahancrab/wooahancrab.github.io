// 직원(및 매니저 본인) 출퇴근 화면
import { api } from "../lib/api.js";
import { getPosition } from "../lib/geo.js";
import { h, toast, modal, timeInput } from "../lib/ui.js";
import { todayKST, dateOf, fmtHM, minutesBetween, monthKey, dow } from "../lib/kst.js";
import { t, lang, dowNames } from "../lib/i18n.js";

export const recMinutes = (r) => (r.out_at ? minutesBetween(r.in_at, r.out_at) : null);

// 날짜·시간 길이 표기는 화면 언어에 맞춘다. 한국어일 때는 kst.js 의 labelMD·fmtDur 와 똑같은 모양이다.
const mdLabel = (s) => {
  const [, m, d] = s.split("-").map(Number);
  return `${m}/${d}(${dowNames()[dow(s)]})`;
};
const durText = (min) => {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return t("{m}분", { m });
  return m % 60 ? t("{h}시간 {m}분", { h: Math.floor(m / 60), m: m % 60 }) : t("{h}시간", { h: Math.floor(m / 60) });
};

// 서버·기기가 준 한국어 오류 문구를 화면 언어로. 숫자가 들어간 문구는 틀을 찾아 숫자를 채운다.
const ERR_PATTERNS = [
  [/^위치 정확도가 낮아요\(약 (\d+)m\)\. 창가나 건물 밖에서 다시 눌러 주세요$/, "위치 정확도가 낮아요(약 {n}m). 창가나 건물 밖에서 다시 눌러 주세요", ["n"]],
  [/^매장에서 약 (\d+)m 떨어져 있어요\. 매장 (\d+)m 안에서 눌러 주세요$/, "매장에서 약 {d}m 떨어져 있어요. 매장 {r}m 안에서 눌러 주세요", ["d", "r"]],
  [/^계정 확인에 실패했어요: ([\s\S]*)$/, "계정 확인에 실패했어요: {msg}", ["msg"]],
];
function errText(msg) {
  if (lang() === "ko" || typeof msg !== "string") return msg;
  for (const [re, key, names] of ERR_PATTERNS) {
    const m = re.exec(msg);
    if (m) return t(key, Object.fromEntries(names.map((k, i) => [k, m[i + 1]])));
  }
  return t(msg);
}

// ko=true 면 화면 언어와 상관없이 한국어(한국어로만 쓰는 관리자 화면용)
const fillKo = (k, p) => k.replace(/\{(\w+)\}/g, (_, n) => p?.[n] ?? "");
export function recBadges(r, ko = false) {
  const tt = ko ? fillKo : t;
  const b = [];
  if (r.late_min > 0) b.push([tt("지각 {n}분", { n: r.late_min }), "warn"]);
  if (r.out_source === "self_report" && !r.out_approved) b.push([tt("직접 입력 · 승인 대기"), "info"]);
  else if (r.out_source === "self_report") b.push([tt("직접 입력"), "info"]);
  if (r.out_source === "owner_edit") b.push([tt("대표 수정"), "info"]);
  if (r.out_dist != null && r.out_dist > 100) b.push([tt("매장 밖 퇴근 {n}m", { n: r.out_dist }), "warn2"]);
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
      h("p", null, t("{date} {time}에 출근하고 퇴근을 누르지 않았어요. 몇 시에 퇴근하셨나요?", { date: mdLabel(dateOf(rec.in_at)), time: fmtHM(rec.in_at) })),
      h("div", { class: "timerow" }, h("span", { class: "tlabel" }, t("퇴근시간 :")), inp),
      h("p", { class: "hint" }, t("입력한 시각은 대표님 확인 후 확정돼요.")));
    for (;;) {
      const ok = await modal(t("퇴근 시각 입력"), content, t("입력 완료"), t("나중에"));
      if (!ok) return;
      if (!/^\d{2}:\d{2}$/.test(inp.value)) { toast(t("시각을 00:00 형식으로 입력해 주세요")); continue; }
      try { await api.attReportOut(rec.id, inp.value); toast(t("입력했어요. 대표님 확인 후 확정돼요")); await load(); return; } catch (e) { toast(errText(e.message), 5000); }
    }
  }

  async function consent() {
    try { await api.attConsent(); await load(); } catch (e) { toast(errText(e.message), 5000); }
  }

  async function punch(kind) {
    if (busy) return;
    busy = true; draw();
    try {
      let pos = null;
      try { pos = await getPosition(); } catch (e) {
        if (kind === "in") throw e;
        toast(t("위치를 확인하지 못해 위치 없이 퇴근을 기록해요"), 4000); // 퇴근은 위치가 없어도 기록한다
      }
      const res = await api.attPunch(kind, pos);
      if (res?.needs_out_report) { busy = false; await load(); return; }
      toast(kind === "in" ? t("출근했어요") : t("퇴근했어요. 수고하셨어요!"), 3500);
    } catch (e) {
      toast(errText(e.message), 6000);
    }
    busy = false;
    await load();
  }

  function statusCard() {
    const open = st.open && !st.stale ? st.open : null;
    if (open) {
      const el = minutesBetween(open.in_at, st.now);
      return h("section", { class: "card att on" },
        h("div", { class: "att-state" }, t("근무 중")),
        h("div", { class: "att-big" }, t("{time} 출근", { time: fmtHM(open.in_at) })),
        h("p", { class: "muted" }, t("경과 {dur}", { dur: durText(el) }) + (open.expected_out ? " · " + t("예상 퇴근 {time}", { time: fmtHM(open.expected_out) }) : "")),
        open.late_min > 0 && h("div", { class: "badges" }, h("span", { class: "badge warn" }, t("지각 {n}분", { n: open.late_min }))),
        h("button", { class: "btn out-btn", disabled: busy, onclick: () => punch("out") }, busy ? t("처리 중…") : t("퇴근")));
    }
    const today = dateOf(st.now);
    const done = mine.filter((r) => r.work_date === today && r.out_at);
    return h("section", { class: "card att" },
      h("div", { class: "att-state" }, done.length ? t("오늘 근무 완료") : t("출근 전")),
      done.length > 0 && h("p", { class: "muted" }, done.map((r) => `${fmtHM(r.in_at)} ~ ${fmtHM(r.out_at)}`).join(", ")),
      done.length > 0
        ? h("p", { class: "hint" }, t("출퇴근은 하루 한 번만 가능해요. 내일 다시 출근을 눌러 주세요."))
        : [h("button", { class: "btn in-btn", disabled: busy, onclick: () => punch("in") }, busy ? t("위치 확인 중…") : t("출근")),
           h("p", { class: "hint" }, t("매장 {r}m 안에서 눌러 주세요. 위치는 버튼을 누른 순간에만 확인해요.", { r: st.store.radius_m }))]);
  }

  function listCard() {
    const total = mine.reduce((s, r) => s + (recMinutes(r) ?? 0), 0);
    const days = new Set(mine.filter((r) => r.out_at).map((r) => r.work_date)).size;
    return h("section", { class: "sec stack" }, h("h2", { class: "sec-title" }, t("이번 달 근무")),
      h("p", { class: "att-sum" }, t("{days}일 · {dur}", { days, dur: durText(total) })),
      h("div", { class: mine.length ? "rowlist" : "list" }, mine.slice(0, 15).map((r) => {
        const m = recMinutes(r);
        return h("div", { class: "item col static" },
          h("b", null, mdLabel(r.work_date)),
          h("span", null, `${fmtHM(r.in_at)} ~ ${r.out_at ? fmtHM(r.out_at) : t("퇴근 전")}${m != null ? ` (${durText(m)})` : ""}`),
          recBadges(r).length > 0 && h("span", { class: "badges" }, recBadges(r).map(([label, c]) => h("span", { class: "badge " + c }, label))));
      }),
      !mine.length && h("p", { class: "muted" }, t("아직 기록이 없어요"))));
  }

  function pushBtn() {
    const on = api.pushEnabled();
    return h("button", { class: "btn " + (on ? "ghost" : "weak") + " slim", onclick: async () => {
      try { await api.enablePush(); toast(t("알림을 켰어요 (퇴근 확인 알림을 받아요)")); draw(); } catch (e) { toast(errText(e.message), 5000); }
    } }, "🔔 " + (on ? t("퇴근 알림 켜짐") : t("퇴근 알림 켜기")));
  }

  function view() {
    if (err) return h("div", { class: "page" }, h("p", { class: "err" }, t("불러오기 실패: {msg}", { msg: errText(err) })), h("button", { class: "btn ghost", onclick: load }, t("다시 시도")));
    if (!st) return h("div", { class: "page" }, h("p", { class: "muted" }, t("불러오는 중…")));
    if (!st.me.consented) {
      return h("div", { class: "page" }, h("h1", null, t("위치 정보 수집 동의")),
        h("section", { class: "card" },
          h("p", null, t("출근·퇴근 확인을 위해 아래와 같이 위치 정보를 수집해요.")),
          h("ul", { class: "plain" },
            h("li", null, t("수집 시점: 출근·퇴근 버튼을 누른 순간 한 번만 (계속 추적하지 않아요)")),
            h("li", null, t("수집 목적: 매장 안에서 출근했는지, 출퇴근 시각 확인")),
            h("li", null, t("보관: 출퇴근 기록과 함께 근로기준법상 보관 기간 동안 보관")),
            h("li", null, t("열람: 본인과 대표·매니저만"))),
          h("p", { class: "hint" }, t("동의하지 않으면 출퇴근 버튼을 사용할 수 없어요.")),
          h("button", { class: "btn primary", onclick: consent }, t("동의하고 시작"))));
    }
    return h("div", { class: "page" },
      !st.store.configured && h("div", { class: "banner" }, t("매장 위치가 아직 설정되지 않았어요. 대표님이 설정하면 출근할 수 있어요.")),
      statusCard(), pushBtn(), listCard());
  }

  draw();
  await load();
}
