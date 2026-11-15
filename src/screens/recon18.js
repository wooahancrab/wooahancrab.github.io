// 매출-입금 대조 화면(대표·부대표·회장 전용): 결제수단별로 '매출일 + 정산일수(기본 18일)' 안에 입금됐는지 확인한다.
// 계산은 lib/recon18.js(순수 함수). 지금은 가상 10월 데이터로 화면을 확인하는 단계라, 입력한 자료는 이 화면을 열어 둔 동안만 보관한다.
import { api } from "../lib/api.js";
import { h, toast, modal, confirmDialog } from "../lib/ui.js";
import { todayKST, addDays, labelMD, monthLabel, dow } from "../lib/kst.js";
import { t, tx, lang, dowNames } from "../lib/i18n.js";
import { METHODS, METHOD_LABEL, DEFAULT_DAYS, DEFAULT_TOL, STATUS_KEYS, buildDetail, noteKey, statusLabel, canViewFinance, periodOf, analyze, fromBankDeposits, parseSalesRows, parseDepositRows, fmtMan, fmtPct, fmtWon, fmtDec, roundsToMan, prevMonth, nextMonth, monthEnd, daysBetween, inferMethod } from "../lib/recon18.js";
import { demoData } from "../lib/recon18-demo.js";

const XLSX_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
let xlsxP;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ??= new Promise((ok, no) => {
    const s = h("script", { src: XLSX_URL });
    s.onload = () => (window.XLSX ? ok(window.XLSX) : (xlsxP = null, no(new Error(t("엑셀 읽기 도구가 올바르게 불러와지지 않았어요")))));
    s.onerror = () => { xlsxP = null; no(new Error(t("엑셀 읽기 도구를 불러오지 못했어요. 인터넷을 확인해 주세요"))); };
    document.head.append(s);
  }));
}
// 모든 시트를 2차원 배열의 배열로. CSV 는 UTF-8(BOM 포함)을 먼저, 안 되면 한국 엑셀 기본인 CP949(EUC-KR)로 읽는다
async function readBook(file) {
  const X = await loadXlsx();
  let wb;
  if (/\.csv$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("euc-kr").decode(buf); }
    wb = X.read(text, { type: "string", cellDates: true });
  } else wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  return wb.SheetNames.map((n) => X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }));
}

// 화면에 보이는 이름은 그릴 때마다 화면 언어로 만든다(모듈이 불러와질 때는 아직 한국어라 상수로 두지 않는다)
const stateName = (s) => ({ done: t("완료 확정"), missing: t("누락 의심"), over: t("초과 입금"), partial: t("일부 입금"), waiting: t("입금 대기"), early: t("기한 전 입금") })[s];
const BAND_MARK = { done: "✓", pending: "…", missing: "!" };
const bandName = (b) => ({ done: t("완료 확정"), pending: t("입금 대기"), missing: t("누락 의심") })[b];
const monthYear = (m) => t("{y}년 {m}", { y: m.slice(0, 4), m: monthLabel(m) }); // 2026년 10월 · Tháng 10/2026 · Oct 2026
const monthYearIn = (m) => { const s = monthYear(m); return lang() === "vi" ? s.replace(/^T/, "t") : s; }; // 문장 안에서는 베트남어를 소문자로(tháng 10/2026)
const monthWord = (m) => { const s = monthLabel(m); return lang() === "vi" ? s.replace(/^T/, "t") : s; }; // 10월 · tháng 10 · Oct (문장 안에서)
const dayText = (n) => (n === 1 ? t("1일") : t("{n}일", { n })); // 18일 · 18 days · 18 ngày
const bizDayText = (n) => (n === 1 ? t("1영업일") : t("{n}영업일", { n }));
// 서버·기기가 준 문구를 화면 언어로(한국어에서는 그대로). 영어로 오는 서버·네트워크 오류는 알아볼 수 있는 문장으로
function errText(msg) {
  if (lang() === "ko" || typeof msg !== "string") return msg;
  if (/[가-힣]/.test(msg)) return t(msg);
  if (/forbidden|42501|permission denied|row-level security/i.test(msg)) return t("권한이 없어요");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return t("서버에 연결하지 못했어요");
  if (/jwt|does not exist|schema cache|could not find|violates/i.test(msg)) return t("처리하지 못했어요");
  return msg;
}
const emptyMine = () => ({ sales: [], deposits: [] });
const mineSettings = () => ({ asOf: todayKST(), month: todayKST().slice(0, 7), mode: "calendar", defaultDays: DEFAULT_DAYS, holidays: [], days: {}, contractFee: {}, opening: {} });
const clone = (o) => JSON.parse(JSON.stringify(o));
// 쉼표·'원'·공백만 지우고 숫자만 허용. 소수·부호·글자·1조 초과는 NaN
const parseWon = (v) => { const t = String(v ?? "").replace(/[,\s원]/g, ""); if (!/^\d+$/.test(t)) return NaN; const n = Number(t); return n <= 1e12 ? n : NaN; };
const okDate = (s) => /^20\d{2}-\d{2}-\d{2}$/.test(String(s ?? "")) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

export async function renderRecon18(root, onBack, opts = {}) {
  let prof = opts.profile ?? null;
  if (!prof) { try { prof = await api.getProfile(); } catch { prof = null; } }
  const back = () => onBack && h("button", { type: "button", class: "linkbtn back", onclick: onBack }, t("← 목록"));
  if (!prof || !canViewFinance(prof.role)) {
    root.replaceChildren(h("div", { class: "page" }, back(), h("h1", null, t("🧮 매출-입금 대조")), h("p", { class: "muted" }, t("대표·부대표·회장만 볼 수 있는 화면이에요."))));
    return;
  }

  const demo = demoData();
  // notes: 누락 건별 확인 메모·처리 상태(이 화면을 열어 둔 동안만 보관). open: 펼친 누락 건의 키. last: 마지막으로 계산한 결과(내역서·엑셀용)
  const st = { src: "demo", data: clone({ sales: demo.sales, deposits: demo.deposits }), settings: clone(demo.settings), sel: null, busy: false, bankRange: null, notes: {}, open: null, last: null };
  let shown = null;

  // keep: 다시 그린 뒤에도 화면에서 같은 자리에 두고 싶은 줄의 이름(data-rk)을 우선순위대로. 위쪽 상세가 접히거나 줄이 사라져도 보던 줄이 튀지 않게 한다
  const rkEl = (k) => root.querySelector(`[data-rk="${String(k).replace(/["\\]/g, "\\$&")}"]`);
  function draw(keep) {
    if (shown && (!root.isConnected || root.firstChild !== shown)) return; // 다른 화면으로 넘어갔다
    const y = scrollY;
    const was = keep ? keep.map((k) => rkEl(k)?.getBoundingClientRect().top ?? null) : null;
    let v;
    try { v = view(); } catch (e) { console.error(e); v = h("div", { class: "page" }, back(), h("p", { class: "err" }, t("화면을 그리지 못했어요. 앱을 다시 열어 주세요."))); }
    root.replaceChildren(v);
    shown = v;
    scrollTo(0, y);
    if (was) for (let i = 0; i < keep.length; i++) {
      const el = was[i] == null ? null : rkEl(keep[i]);
      if (el) { scrollBy(0, el.getBoundingClientRect().top - Math.max(was[i], 8)); break; }
    }
  }
  const alive = () => !shown || (root.isConnected && root.firstChild === shown);
  const isDemoSrc = () => st.src === "demo";
  const hasWork = () => st.src === "mine" && (st.data.sales.length || st.data.deposits.length || Object.keys(st.notes).length);
  async function toMine() { st.src = "mine"; st.data = emptyMine(); st.settings = mineSettings(); st.sel = null; st.bankRange = null; st.notes = {}; st.open = null; draw(); }
  async function toDemo() { if (hasWork() && !(await confirmDialog(t("예시 데이터로 바꿀까요?"), [t("지금 넣은 매출·입금·연결·메모가 모두 사라져요")], t("취소"), t("바꾸기")))) return; const d = demoData(); st.src = "demo"; st.data = clone({ sales: d.sales, deposits: d.deposits }); st.settings = clone(d.settings); st.sel = null; st.bankRange = null; st.notes = {}; st.open = null; draw(); }
  const setS = (patch) => {
    const before = st.settings.month;
    Object.assign(st.settings, patch); st.sel = null; draw();
    if (patch.month && patch.month !== before && st.bankRange && !st.busy) loadBank(); // 다른 달을 보면 그 달 구간의 통장 입금을 다시 가져온다
  };

  /* ---------- 자료 넣기 ---------- */
  const methodSelect = (value) => { const s = h("select", { class: "inp", "aria-label": t("결제수단") },METHODS.map(([k, l]) => h("option", { value: k, selected: k === value }, l))); s.value = value; return s; };

  async function addSale() {
    const date = h("input", { type: "date", class: "inp", value: st.settings.asOf, "aria-label": t("매출일") });
    const method = methodSelect("card");
    const amount = h("input", { class: "inp", inputmode: "numeric", placeholder: t("매출액(원)"), "aria-label": t("매출액") });
    const content = h("div", { class: "stack" }, h("label", { class: "lbl" }, t("매출일")), date, h("label", { class: "lbl" }, t("결제수단")), method, h("label", { class: "lbl" }, t("매출액(원)")), amount);
    for (;;) {
      if (!(await modal(t("매출 한 건 넣기"), content, t("넣기"), t("취소")))) return;
      const a = parseWon(amount.value);
      if (!okDate(date.value)) { toast(t("매출일을 확인해 주세요")); continue; }
      if (!(a > 0)) { toast(t("금액은 숫자만 넣어 주세요(쉼표는 괜찮아요)")); continue; }
      const hit = st.data.sales.find((x) => x.date === date.value && x.method === method.value);
      if (hit) hit.amount += a; else st.data.sales.push({ date: date.value, method: method.value, amount: a });
      toast(hit ? t("같은 날·같은 결제수단 매출에 더했어요") : t("매출을 넣었어요"));
      draw();
      return;
    }
  }
  async function addDeposit() {
    const date = h("input", { type: "date", class: "inp", value: st.settings.asOf, "aria-label": t("입금일") });
    const payer = h("input", { class: "inp", placeholder: t("입금처 (예: 카드 정산, 배달앱 정산)"), "aria-label": t("입금처") });
    const method = methodSelect("card");
    payer.addEventListener("input", () => { const m = inferMethod(payer.value); if (m) method.value = m; });
    const amount = h("input", { class: "inp", inputmode: "numeric", placeholder: t("입금액(원)"), "aria-label": t("입금액") });
    const saleDate = h("input", { type: "date", class: "inp", "aria-label": t("매출일(있으면)") });
    const fee = h("input", { class: "inp", inputmode: "numeric", placeholder: t("수수료(원, 있으면)"), "aria-label": t("수수료") });
    const content = h("div", { class: "stack" }, h("label", { class: "lbl" }, t("입금일")), date, h("label", { class: "lbl" }, t("입금처")), payer, h("label", { class: "lbl" }, t("결제수단")), method,
      h("label", { class: "lbl" }, t("입금액(원)")), amount, h("label", { class: "lbl" }, t("매출일 (있으면)")), saleDate, h("label", { class: "lbl" }, t("수수료 (있으면)")), fee);
    for (;;) {
      if (!(await modal(t("입금 한 건 넣기"), content, t("넣기"), t("취소")))) return;
      const a = parseWon(amount.value), f = fee.value.trim() ? parseWon(fee.value) : null;
      if (!okDate(date.value)) { toast(t("입금일을 확인해 주세요")); continue; }
      if (saleDate.value && !okDate(saleDate.value)) { toast(t("매출일을 확인해 주세요")); continue; }
      if (!(a > 0) || (f !== null && !Number.isFinite(f))) { toast(t("금액·수수료는 숫자만 넣어 주세요(쉼표는 괜찮아요)")); continue; }
      st.data.deposits.push({ date: date.value, payer: payer.value.trim(), amount: a, method: method.value, saleDate: saleDate.value || null, fee: f });
      toast(t("입금을 넣었어요"));
      draw();
      return;
    }
  }

  async function upload(kind) {
    const inp = h("input", { type: "file", accept: ".xlsx,.xls,.csv", style: "display:none" });
    inp.onchange = async () => {
      const f = inp.files[0]; inp.remove(); if (!f) return;
      st.busy = true; draw();
      try {
        const sheets = await readBook(f);
        let list = null, lastErr = null;
        for (const rows of sheets) { try { list = kind === "sales" ? parseSalesRows(rows) : parseDepositRows(rows); break; } catch (e) { lastErr = e; } }
        if (!list) throw lastErr ?? new Error(t("읽을 수 있는 표가 없어요"));
        const note = list.dropped ? " " + t("(읽지 못한 {n}행은 뺐어요)", { n: list.dropped }) : "";
        if (kind === "sales") {
          // 같은 날짜+결제수단은 새 파일 값으로 바꾼다(같은 파일을 다시 올려도 두 배가 되지 않게). 취소(음수) 행은 같은 날 합계에서 빠진다
          const sum = new Map();
          for (const s of list) sum.set(s.date + "|" + s.method, (sum.get(s.date + "|" + s.method) ?? 0) + s.amount);
          st.data.sales = st.data.sales.filter((s) => !sum.has(s.date + "|" + s.method));
          let n = 0;
          for (const [k, amount] of sum) { if (amount <= 0) continue; const [date, method] = k.split("|"); st.data.sales.push({ date, method, amount }); n++; }
          toast(t("매출 {n}일·결제수단 단위를 반영했어요", { n }) + note, 5000);
        } else {
          const key = (d) => [d.date, d.payer, d.amount, (d.origSaleDate !== undefined ? d.origSaleDate : d.saleDate) ?? ""].join("|");
          const have = new Map();
          for (const d of st.data.deposits) have.set(key(d), (have.get(key(d)) ?? 0) + 1);
          const used = new Map(), fresh = [];
          for (const d of list) { const k = key(d), u = (used.get(k) ?? 0) + 1; used.set(k, u); if (u > (have.get(k) ?? 0)) fresh.push(d); } // 같은 줄이 여러 번이면 개수까지 비교
          st.data.deposits.push(...fresh);
          toast(t("입금 {total}건 중 새로 {n}건을 반영했어요", { total: list.length, n: fresh.length }) + note, 5000);
        }
      } catch (e) { if (alive()) toast(errText(e.message), 6000); }
      st.busy = false; draw();
    };
    document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
  }

  // 통장 업로드 자료(수금 대조에서 올린 입금)를 재사용: 입금처에 결제수단 단서가 있는 것만 가져온다. 서버 함수가 역할을 확인한다.
  async function loadBank() {
    st.busy = true; draw();
    try {
      const S = st.settings, maxN = Math.max(DEFAULT_DAYS, S.defaultDays ?? 0, ...Object.values(S.days ?? {}).filter(Number.isFinite));
      const per = periodOf(S.month, maxN, S.mode, S.holidays);
      const rows = await api.recon18Deps(per.from, per.depositsTo);
      const r = fromBankDeposits(rows);
      const mine = st.data.deposits.filter((d) => d.from !== "bank");
      // 직접 넣거나 엑셀로 올린 입금과 같은 날·같은 금액(수수료 포함)이면 같은 돈으로 보고 건너뛴다
      const dup = (b) => mine.some((m) => m.date === b.date && (m.amount === b.amount || (m.fee != null && m.amount + m.fee === b.amount)));
      const fresh = r.deposits.filter((b) => !dup(b)), skipped = r.deposits.length - fresh.length;
      // 이전에 가져온 통장 입금에 사람이 한 연결은 (입금일·금액·입금처)가 같으면 이어 붙인다
      const keyOf = (d) => [d.date, d.amount, d.payer].join("|");
      const prevLinked = new Map(st.data.deposits.filter((d) => d.from === "bank" && d.linked).map((d) => [keyOf(d), d]));
      const kept = fresh.map((d) => { const old = prevLinked.get(keyOf(d)); if (!old) return d; prevLinked.delete(keyOf(d)); return { ...d, saleDate: old.saleDate, method: old.method, linked: true, origSaleDate: old.origSaleDate, origMethod: old.origMethod }; });
      st.data.deposits = mine.concat(kept.map((d) => ({ ...d, from: "bank" })));
      if (prevLinked.size && alive()) toast(t("이전에 연결한 통장 입금 {n}건이 이번에 가져온 구간에 없어 연결이 풀렸어요", { n: prevLinked.size }), 6000);
      st.bankRange = { from: per.from, to: per.depositsTo };
      if (!alive()) { st.busy = false; return; }
      toast(skipped ? t("통장 입금 {n}건을 가져왔어요 (결제수단 단서 없는 {u}건, 이미 있는 {s}건은 뺐어요)", { n: fresh.length, u: r.unclassified.length, s: skipped }) : t("통장 입금 {n}건을 가져왔어요 (결제수단 단서 없는 {u}건은 뺐어요)", { n: fresh.length, u: r.unclassified.length }), 6000);
      if (rows.length >= 1000) toast(t("통장 입금이 1,000건 이상이라 일부가 빠졌을 수 있어요. 기간을 줄여 보세요"), 7000);
    } catch (e) { if (alive()) toast(t("통장 입금을 불러오지 못했어요: {msg}", { msg: errText(e.message) }), 6000); }
    st.busy = false; draw();
  }

  /* ---------- 내역서 출력(A4 인쇄·PDF)과 엑셀 내려받기: 열람 권한이 있는 사람만 ---------- */
  // 사람이 눌러 연결한 입금 목록(내역서·엑셀에도 남긴다: 연결로 점검표에서 사라진 건의 흔적)
  const linkedList = () => st.data.deposits.filter((d) => d.linked).map((d) => {
    const n = st.notes[`${d.saleDate}|${d.method}`] ?? {};
    return { date: d.date, payer: d.payer || "", net: d.amount, fee: d.fee ?? 0, gross: d.amount + (d.fee ?? 0), saleDate: d.saleDate, method: d.method, statusText: n.status ? statusLabel(n.status, d.method) : "", memo: n.memo ?? "" };
  });
  const outCtx = () => {
    const from = st.last.res.period.from; // 분석 시작 전 자료 건수(미수금 계산에만 쓴 자료) — 내역서 안내용
    return { res: st.last.res, settings: st.last.eff, isDemo: isDemoSrc(), user: { name: prof.display_name ?? "", role: prof.role }, now: new Date(), notes: st.notes, linked: linkedList(),
      pre: { sales: st.data.sales.filter((s) => s.date < from).length, deposits: st.data.deposits.filter((d) => d.date < from).length } };
  };
  function printSheet() {
    if (!canViewFinance(prof.role) || !st.last) { toast(t("출력 권한이 없어요")); return; }
    import("./recon18-print.js").then((m) => m.openPrintSheet(outCtx())).catch((e) => toast(t("내역서를 열지 못했어요: {msg}", { msg: errText(e.message) }), 5000));
  }
  async function downloadXlsx() {
    if (!canViewFinance(prof.role) || !st.last) { toast(t("다운로드 권한이 없어요")); return; }
    st.busy = true; draw();
    try {
      const [X, m] = await Promise.all([loadXlsx(), import("../lib/recon18-xlsx.js")]);
      const c = outCtx();
      const name = m.downloadXlsx(X, c); // 권한 확인 + 틀 고정까지 넣어 내려받는다
      toast(t("엑셀을 내려받았어요: {name} (금액은 원 단위)", { name }), 5000);
    } catch (e) { if (alive()) toast(t("엑셀을 만들지 못했어요: {msg}", { msg: errText(e.message) }), 6000); }
    st.busy = false; draw();
  }

  /* ---------- 설정 ---------- */
  async function openSettings() {
    const S = st.settings;
    let mode = S.mode ?? "calendar";
    const modeBox = h("div");
    const paintMode = () => modeBox.replaceChildren(h("div", { class: "seg" }, [["calendar", t("달력 기준")], ["business", t("영업일 기준(주말 제외)")]].map(([v, l]) =>
      h("button", { type: "button", class: "segbtn" + (mode === v ? " on" : ""), onclick: () => { mode = v; paintMode(); } }, l))));
    paintMode();
    const fields = METHODS.map(([k, label]) => ({
      k, label,
      days: h("input", { class: "inp", inputmode: "numeric", value: String(S.days?.[k] ?? S.defaultDays ?? DEFAULT_DAYS), "aria-label": t("{label} 정산일수", { label }) }),
      fee: h("input", { class: "inp", inputmode: "decimal", placeholder: t("예: 2.3"), value: S.contractFee?.[k] ? String(+(S.contractFee[k] * 100).toFixed(3)) : "", "aria-label": t("{label} 계약 수수료율(%)", { label }) }),
      open: h("input", { class: "inp", inputmode: "numeric", placeholder: "0", value: (!S.openingMonth || S.openingMonth === S.month) && S.opening?.[k] ? String(S.opening[k]) : "", "aria-label": t("{label} 이월 미수금", { label }) }), // 다른 달에 넣은 값은 채우지 않는다
    }));
    const content = h("div", { class: "stack" },
      h("label", { class: "lbl" }, t("정산일수 계산 방식")), modeBox,
      h("p", { class: "hint" }, t("결제수단마다 '정산일수(매출일 + N일 안에 입금)', '계약 수수료율(%)', '이월 미수금'을 넣어요. 이월 미수금은 올려 둔 매출 자료에 없는, {m} 분석 시작 전 매출 중 아직 못 받은 돈(원)이고 이 달에만 써요. 이미 올린 자료의 매출은 자동으로 셈해요. 매출일이 시작 전으로 적힌 입금은 따로 자동 반영돼서 직접 넣은 값에 더해져요. 수수료 칸이 없는 입금은 계약 수수료율로 역산해요.", { m: monthYearIn(S.month) })),
      fields.map((f) => h("div", { class: "entry" }, h("b", null, f.label),
        h("label", { class: "lbl" }, t("정산일수 (일)")), f.days, h("label", { class: "lbl" }, t("계약 수수료율 (%)")), f.fee, h("label", { class: "lbl" }, t("이월 미수금 (원)")), f.open)));
    for (;;) {
      if (!(await modal(t("정산 설정"), content, t("저장"), t("취소")))) return;
      const days = {}, contractFee = {}, opening = {};
      let bad = "";
      for (const f of fields) {
        const dv = f.days.value.trim();
        if (dv === "") days[f.k] = S.days?.[f.k] ?? S.defaultDays ?? DEFAULT_DAYS;
        else if (/^\d{1,3}$/.test(dv) && Number(dv) <= 120) days[f.k] = Number(dv);
        else { bad = t("{label} 정산일수는 0~120 사이의 숫자로 넣어 주세요", { label: f.label }); break; }
        const fv = f.fee.value.trim().replace(/%/g, "");
        if (fv !== "") { if (/^\d+(\.\d+)?$/.test(fv) && Number(fv) > 0 && Number(fv) < 100) contractFee[f.k] = Number(fv) / 100; else { bad = t("{label} 계약 수수료율은 0~100 사이의 숫자(%)로 넣어 주세요", { label: f.label }); break; } }
        const ov = f.open.value.trim();
        if (ov !== "") { const o = parseWon(ov); if (Number.isFinite(o)) { if (o > 0) opening[f.k] = o; } else { bad = t("{label} 이월 미수금은 숫자만 넣어 주세요(쉼표는 괜찮아요)", { label: f.label }); break; } }
      }
      if (bad) { toast(bad, 4500); continue; }
      setS({ mode, days, contractFee, opening, openingMonth: Object.keys(opening).length ? S.month : undefined });
      return;
    }
  }

  /* ---------- 화면 ---------- */
  // 영어·베트남어는 금액이 한국어(만원 단위)보다 길어서 "KRW"와 숫자 사이에서 줄이 바뀌게 한다(한국어는 그대로 한 줄)
  const wrapNum = () => (lang() === "ko" ? null : "white-space:normal");
  const colNum = () => (lang() === "ko" ? null : "white-space:normal;overflow-wrap:anywhere;font-size:.8rem"); // 3칸 줄은 칸이 좁아서 글자도 조금 줄인다
  const cell = (k, v, cls = "") => h("span", null, h("span", { class: "hint", style: "display:block" }, k), h("b", { class: cls, style: colNum() }, v));

  function sourceBar(res) {
    const per = res.period, T = res.summary.T, dTo = res.asOf < per.depositsTo ? res.asOf : per.depositsTo;
    const exS = st.data.sales.filter((s) => s.date > T).length, exD = st.data.deposits.filter((d) => d.date > dTo).length; // 계산에서 빠진 자료(기준일·분석 끝 뒤)
    const preS = st.data.sales.filter((s) => s.date < per.from).length, preD = st.data.deposits.filter((d) => d.date < per.from).length; // 분석 시작 전 자료: 미수금 계산에만 쓴다
    return h("div", { class: "banner" + (isDemoSrc() ? "" : " plain") },
      isDemoSrc() ? h("span", null, h("b", null, t("예시 데이터")), " · " + t("2026년 10월 가상 자료예요(실제 아님). 일부러 누락 2건을 넣어 두었어요."))
        : h("span", null, h("b", null, t("내 데이터")), " · " + t("매출 {s}건, 입금 {d}건. 지금은 이 화면을 열어 둔 동안만 보관돼요.", { s: st.data.sales.length, d: st.data.deposits.length }),
          st.bankRange && " " + t("통장 입금은 {from}~{to} 구간만 가져왔어요.", { from: labelMD(st.bankRange.from), to: labelMD(st.bankRange.to) }),
          (preS || preD) && " " + t("분석 시작({from}) 전 자료(매출 {s}건·입금 {d}건)는 미수금 계산에만 썼어요.", { from: labelMD(per.from), s: preS, d: preD }),
          (exS || exD) && " " + t("{m} 분석 범위 뒤라 뺀 자료: 매출 {s}건·입금 {d}건.", { m: monthYearIn(res.month), s: exS, d: exD })),
      isDemoSrc() ? h("button", { type: "button", class: "linkbtn", onclick: toMine }, t("내 자료로 시작하기")) : h("button", { type: "button", class: "linkbtn", onclick: toDemo }, t("예시 보기")));
  }

  function controls(res) {
    const S = st.settings, nm = nextMonth(S.month), canNext = monthEnd(S.month) < S.asOf;
    const asOf = h("input", { type: "date", class: "inp", value: S.asOf, "aria-label": t("기준일") });
    asOf.addEventListener("change", () => {
      if (!asOf.value) return;
      if (!okDate(asOf.value)) { toast(t("기준일은 2000년 이후의 올바른 날짜로 넣어 주세요")); asOf.value = S.asOf; return; }
      const m = asOf.value.slice(0, 7); setS({ asOf: asOf.value, month: S.month > m ? m : S.month });
    });
    const applied = !S.openingMonth || S.openingMonth === S.month;
    return h("section", { class: "card" },
      h("div", { class: "rc-bar" },
        h("button", { type: "button", class: "btn ghost slim", "aria-label": t("이전 달"), onclick: () => setS({ month: prevMonth(S.month) }) }, "◀"),
        h("b", { class: "rc-month" }, monthYear(S.month)),
        h("button", { type: "button", class: "btn ghost slim", "aria-label": t("다음 달"), disabled: !canNext, onclick: () => setS({ month: nm }) }, "▶")),
      h("label", { class: "lbl" }, t("기준일 (이 날짜까지 들어온 입금으로 대조)")),
      h("div", { class: "row2" }, asOf, h("button", { type: "button", class: "btn ghost slim", style: "width:auto;flex:none;white-space:nowrap;margin:0;padding:0 16px", onclick: () => setS({ asOf: todayKST(), month: todayKST().slice(0, 7) }) }, t("오늘"))),
      h("p", { class: "hint" }, t("정산일수 {days} · {mode} 기준 · {tol} 이하 차이는 같은 금액으로 봐요", { days: METHODS.filter(([k]) => res.methods.some((m) => m.method === k)).map(([k, l]) => `${l} ${dayText(S.days?.[k] ?? S.defaultDays ?? DEFAULT_DAYS)}`).join(" · ") || t("기본 18일"), mode: S.mode === "business" ? t("영업일") : t("달력"), tol: fmtWon(DEFAULT_TOL) })),
      !applied && Object.keys(S.opening ?? {}).length > 0 && h("p", { class: "hint" }, t("이월 미수금은 {m} 분석용으로 넣은 값이라 이 달에는 쓰지 않았어요.", { m: monthYearIn(S.openingMonth) })),
      h("div", { class: "toprow" },
        h("button", { type: "button", class: "btn ghost slim", onclick: openSettings }, t("⚙ 정산 설정")),
        h("button", { type: "button", class: "btn ghost slim", onclick: printSheet }, t("🖨 내역서 인쇄")),
        h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: downloadXlsx }, t("📊 엑셀 받기")),
        !isDemoSrc() && h("button", { type: "button", class: "btn ghost slim", onclick: addSale }, t("＋ 매출 넣기")),
        !isDemoSrc() && h("button", { type: "button", class: "btn ghost slim", onclick: addDeposit }, t("＋ 입금 넣기")),
        !isDemoSrc() && h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: () => upload("sales") }, t("📥 매출 엑셀")),
        !isDemoSrc() && h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: () => upload("deposits") }, t("📥 입금 엑셀")),
        !isDemoSrc() && h("button", { type: "button", class: "btn ghost slim", disabled: st.busy, onclick: loadBank }, t("🏦 통장 입금 가져오기"))));
  }

  function summary(res) {
    const s = res.summary, partial = s.T < res.period.monthTo, maxN = Math.max(...res.methods.map((m) => m.days), DEFAULT_DAYS);
    const stat = (k, v, sub, warn) => h("div", { class: "rc-stat" + (warn ? " warn" : "") }, h("span", { class: "k" }, k), h("span", { class: "v", style: wrapNum() }, v), h("span", { class: "s" }, sub));
    const nm = nextMonth(res.month);
    return h("section", { class: "sec stack" },
      h("h2", { class: "sec-title" }, t("{m} 요약", { m: monthWord(res.month) })),
      h("div", { class: "rc-grid" },
        stat(t("이번 달 매출"), fmtMan(s.sales), `${labelMD(res.period.monthFrom)} ~ ${labelMD(s.T)}`),
        stat(t("이번 달 입금"), fmtMan(s.net), s.fee ? t("수수료 {amt} 별도", { amt: fmtMan(s.fee) }) : t("수수료 정보 없음")),
        stat(partial ? t("기준일 미수금") : t("월말 미수금"), fmtMan(s.arEnd), s.orphanEnd > 0 ? t("짝 없는 입금 {amt} 별도(안 뺐어요)", { amt: fmtMan(s.orphanEnd) }) : t("전월 말 {amt}에서", { amt: fmtMan(s.arPrev) }), s.overdueAtEnd > 0),
        stat(partial ? t("기준일 이후 입금 예정") : t("{from}~{to} 입금 예정", { from: labelMD(res.period.nextFrom), to: labelMD(res.period.depositsTo) }), fmtMan(s.nextExpectedNet),
          res.asOf > res.period.monthTo ? t("월말 기준 · 그 뒤 입금은 안 뺐어요") : s.nextExpectedNet !== s.nextExpected ? t("수수료 빼기 전 {amt}", { amt: fmtMan(s.nextExpected) }) : t("수수료 정보 없으면 그대로"))),
      s.overdueAtEnd > 0 && h("div", { class: "alert warn" }, partial ? t("기준일 현재 입금 기한이 지난 미수금이 {amt} 있어요.", { amt: fmtMan(s.overdueAtEnd) }) : t("월말에 입금 기한이 지난 미수금이 {amt} 있어요.", { amt: fmtMan(s.overdueAtEnd) })),
      h("p", { class: "hint" }, t("검산: 입금 {net} = 전월 말 미수 {prev} + 매출 {sales} − {endLabel} 미수 {end} − 수수료 {fee}", { net: fmtMan(s.net), prev: fmtMan(s.arPrev), sales: fmtMan(s.sales), endLabel: partial ? tx("검산", "기준일") : t("월말"), end: fmtMan(s.arEnd), fee: fmtMan(s.fee) })
        + (s.orphanDelta ? " + " + t("짝 없는 입금 늘어난 몫 {amt}", { amt: fmtMan(s.orphanDelta) }) : "") + " " + (s.formulaOk ? t("✓ 맞아요") : t("✕ 안 맞아요(자료 확인)"))
        + (roundsToMan() ? " · " + t("만원 반올림이라 화면 숫자끼리는 1~2만원 어긋나 보일 수 있어요(계산은 원 단위로 정확).") : "")),
      h("div", { class: "rowlist" }, res.methods.map((m) => h("div", { class: "item col static" },
        h("b", null, `${METHOD_LABEL[m.method]}`, h("span", { class: "muted" }, "  " + t("정산 {d}", { d: dayText(m.days) }) + (m.contractFee ? " · " + t("계약 {r}", { r: fmtPct(m.contractFee) }) : ""))),
        h("div", { class: "rc-cols" }, cell(t("매출"), fmtMan(m.salesMonth)), cell(t("입금"), fmtMan(m.netMonth)), cell(t("미수"), fmtMan(m.arEnd), m.arEnd < 0 ? "err" : ""))))));
  }

  // 경고·안내: 짝 없는 입금이 남음 / 시작 전 매출 중 못 받은 돈 / 이월 미수금 자동 반영. 이월 미수금 입력칸(⚙ 정산 설정)으로 안내한다.
  function warnings(res) {
    const ws = res.warnings ?? [], out = [];
    const by = {}; for (const d of res.unmatchedDeposits) by[d.method] = (by[d.method] ?? 0) + d.amount;
    const curOpening = () => (st.settings.openingMonth && st.settings.openingMonth !== st.settings.month ? {} : { ...(st.settings.opening ?? {}) }); // 다른 달에 넣은 이월은 이 달에 안 쓴다
    const put = async () => { // 짝 없는 입금을 이월 미수금으로 넣는다(내 자료 모드에서 사람이 확인한 뒤에만)
      const items = [t("{m} 분석 시작 전 매출의 입금일 때만 넣어요", { m: monthYearIn(res.month) }), ...Object.entries(by).map(([m, v]) => `${METHOD_LABEL[m]} ${fmtMan(v)}`), t("통장 입금과 엑셀 입금이 겹쳐 생긴 것이면 넣지 말고 겹친 자료를 먼저 정리해요")];
      if (!(await confirmDialog(t("이월 미수금으로 넣을까요?"), items, t("취소"), t("넣기")))) return;
      const o = curOpening(); for (const [m, v] of Object.entries(by)) o[m] = (o[m] ?? 0) + v;
      setS({ opening: o, openingMonth: st.settings.month });
    };
    for (const w of ws) {
      if (w.code === "orphan") out.push(h("div", { class: "alert warn stack" },
        h("b", null, t("짝 없는 입금 {n}건({amt})이 있어요", { n: w.n, amt: fmtMan(w.amount) })),
        h("span", null, t("아직 미수금에서 빼지 않았어요(월말 미수금이 실제보다 크게 보일 수 있어요). 누락 점검표의 ‘후보 입금’에서 맞는 매출에 연결하거나, 분석 시작 전 매출의 입금이면 이월 미수금에 넣어 주세요.")),
        h("div", { class: "acc-btns" },
          h("button", { type: "button", class: "btn ghost slim", onclick: openSettings }, t("⚙ 이월 미수금 입력")),
          !isDemoSrc() && h("button", { type: "button", class: "btn ghost slim", onclick: put }, t("짝 없는 입금을 이월로 넣기")))));
      else if (w.code === "orphanBig") out.push(h("div", { class: "alert warn" }, t("{methods}: 짝 없는 입금이 못 받은 매출보다 {amt} 더 커요. 입금이 겹쳐 들어갔거나 이월 미수금이 빠졌을 수 있어요.", { methods: w.methods.map((m) => METHOD_LABEL[m]).join("·"), amt: fmtMan(w.amount) })));
      else if (w.code === "pre") out.push(h("div", { class: "alert warn" }, t("분석 시작 전 매출 중 못 받은 돈이 {amt} 있어요(누락 점검표에는 안 보여요). 앞선 달에서 확인해 주세요.", { amt: fmtMan(w.amount) })));
      else if (w.code === "autoOpening") out.push(h("div", { class: "banner plain" }, t("분석 시작 전 매출의 입금 {amt}({methods})를 이월 미수금으로 자동 반영했어요. 직접 넣으려면 ⚙ 정산 설정의 ‘이월 미수금’에 넣어요.", { amt: fmtMan(w.amount), methods: w.methods.map((m) => METHOD_LABEL[m]).join("·") })));
    }
    return out.length ? h("div", { class: "stack" }, out) : null;
  }

  /* ---------- 누락 건 상세 / 후보 입금 연결 / 메모·처리 상태 ---------- */
  // 후보 입금을 눌러 그 매출에 연결한다 = 그 입금에 매출일을 지정한다(되돌릴 수 있게 원래 매출일·결제수단을 적어 둔다)
  function linkDeposit(c, r) {
    const dep = st.data.deposits[c.idx];
    if (!dep) { toast(t("입금을 찾지 못했어요. 화면을 다시 열어 주세요")); return; }
    if (!("origSaleDate" in dep)) { dep.origSaleDate = dep.saleDate ?? null; dep.origMethod = dep.method; } // 원래 값을 그대로 적어 둔다(결제수단이 없었으면 없던 대로 되돌린다)
    dep.saleDate = r.date; dep.linked = true; dep.method = r.method;
    st.open = null;
    toast(t("{dep} 입금을 {sale} {method} 매출에 연결했어요", { dep: labelMD(dep.date), sale: labelMD(r.date), method: METHOD_LABEL[r.method] }), 3500);
    draw(["m:" + noteKey(r), "miss"]); // 상세가 접히고 줄이 사라져도 점검표 자리에 머문다
  }
  function unlinkDeposit(idx) {
    const dep = st.data.deposits[idx]; if (!dep) return;
    const rk = "m:" + dep.saleDate + "|" + dep.method; // 풀면 이 매출 줄이 점검표로 되돌아오고 위쪽에 경고가 생기기도 해서, 보던 줄(없으면 점검표 위치)에 머문다
    dep.saleDate = dep.origSaleDate ?? null;
    if (dep.origMethod === undefined) delete dep.method; else dep.method = dep.origMethod;
    dep.linked = false;
    delete dep.origSaleDate; delete dep.origMethod;
    toast(t("연결을 풀었어요"), 2500);
    draw([rk, "miss"]);
  }
  const setNote = (key, patch) => { st.notes[key] = { ...(st.notes[key] ?? {}), ...patch }; };

  function noteBox(d) {
    const seg = h("div", { class: "seg" }, STATUS_KEYS.map((k) =>
      h("button", { type: "button", class: "segbtn" + (d.status === k ? " on" : ""), "aria-pressed": d.status === k ? "true" : "false", onclick: () => { setNote(d.key, { status: k }); draw(); } }, statusLabel(k, d.method))));
    const ta = h("textarea", { class: "inp", rows: "3", maxlength: "300", placeholder: t("확인한 내용을 적어 두세요 (예: 카드사에 문의함, 회신 대기)"), "aria-label": t("확인 메모") });
    ta.value = d.memo;
    ta.addEventListener("input", () => setNote(d.key, { memo: ta.value })); // 글자를 칠 때마다 저장만 한다(다시 그리지 않아 입력이 끊기지 않는다)
    return h("div", { class: "stack" }, seg, ta, h("p", { class: "hint" }, t("메모와 처리 상태는 이 화면을 열어 둔 동안만 보관돼요. 내역서·엑셀에는 함께 나와요.")));
  }

  function detailView(r, d, res) {
    const sec = (title, ...kids) => h("div", { class: "rc-sec" }, h("h4", { class: "rc-h" }, title), ...kids);
    const line = (k, v, cls) => h("div", { class: "lrow" }, h("span", null, k), h("span", { class: "num" + (cls ? " " + cls : ""), style: lang() === "ko" ? null : "white-space:normal;overflow-wrap:normal" }, v)); // 영어·베트남어: 낱말(Smartstore 등)이 글자 중간에서 끊기지 않게
    const c = d.cause;
    const causeExtra = !c ? "" : c.code === "fee_high" ? t("실효 수수료율 {eff} (계약 {contract}). 입금이 계약율로 역산한 값이라 실제 수수료가 더 많이 떼였을 수 있어요.", { eff: fmtPct(c.impliedFee), contract: fmtPct(c.contract) })
      : c.code === "partial" ? t("부족한 금액 {amt}.", { amt: fmtMan(c.amount) }) + (c.noFeeInfo ? " " + t("수수료 정보가 없어 수수료만큼도 섞여 있을 수 있어요.") : "")
      : c.code === "none" ? t("받지 못한 금액 {amt}.", { amt: fmtMan(c.amount) }) : t("초과 입금 {amt}.", { amt: fmtMan(c.amount) });
    const feeText = (p) => (p.feeSource === "none" ? t("정보 없음") : fmtMan(p.fee) + (p.feeSource === "contract" ? " " + t("(역산)") : ""));
    const partView = (p) => h("div", { class: "entry" },
      h("b", null, `${labelMD(p.date)} · ${p.payer || t("입금처 없음")}`),
      h("div", { class: "rc-cols" }, cell(t("입금액"), fmtMan(p.net)), cell(t("수수료"), feeText(p)), cell(t("합계"), fmtMan(p.gross))),
      h("span", { class: "hint" }, p.modeText),
      p.mode === "manual" && h("button", { type: "button", class: "linkbtn", onclick: () => unlinkDeposit(p.idx) }, t("연결 해제")));
    const candView = (cd) => h("div", { class: "entry" },
      h("b", null, `${labelMD(cd.date)} · ${cd.payer || t("입금처 없음")}`),
      h("div", { class: "rc-cols" }, cell(t("입금액"), fmtMan(cd.net)), cell(t("수수료"), cd.fee ? fmtMan(cd.fee) : t("없음")), cell(t("합계"), fmtMan(cd.amount))),
      h("span", { class: "badges", style: "justify-content:flex-start" },
        cd.amountHit && h("span", { class: "badge" }, t("금액 ±5% 이내")),
        cd.dateHit && h("span", { class: "badge" }, cd.dueGap === 0 ? t("기한 당일") : t("기한 {d} 차이", { d: dayText(cd.dueGap) })),
        !cd.sameMethod && h("span", { class: "badge warn" }, t("{method} 입금", { method: METHOD_LABEL[cd.method] }))),
      h("span", { class: "hint" }, t("이 입금이 그 매출 것일 수 있어요. 맞으면 눌러서 연결하세요(나중에 풀 수 있어요).")),
      h("button", { type: "button", class: "btn ghost slim", "aria-label": t("{dep} {payer}을(를) {sale} {method} 매출에 연결", { dep: labelMD(cd.date), payer: cd.payer || t("입금"), sale: labelMD(r.date), method: METHOD_LABEL[r.method] }), onclick: () => linkDeposit(cd, r) }, t("이 매출에 연결")));
    return h("div", { class: "rc-detail" },
      sec(t("그날 매출"), line(t("결제수단"), METHOD_LABEL[d.method]), line(t("금액"), fmtMan(d.amount)), line(t("입금 기한"), t("{due} (매출일 + {n})", { due: labelMD(d.due), n: res.mode === "business" ? bizDayText(d.days) : dayText(d.days) })), line(t("기한 경과"), dayText(d.lateDays))),
      sec(t("이 매출에 배정된 입금"), d.parts.length ? d.parts.map(partView) : h("p", { class: "muted" }, t("배정된 입금이 없어요.")),
        d.estimated && h("p", { class: "hint" }, t("‘오래된 매출부터 채운 추정’은 입금에 매출일이 없어서 순서대로 채운 거예요. 실제 연결과 다를 수 있어요."))),
      sec(t("차이와 원인 추정"), line(t("차이"), (r.state === "over" ? "+" : "") + fmtMan(r.state === "over" ? -d.diff : d.diff), "err"), c && h("p", { class: "rc-cause" }, c.text), causeExtra && h("p", { class: "hint" }, causeExtra)),
      sec(t("후보 입금 (아직 짝이 없는 입금)"), d.candidates.length ? d.candidates.map(candView) : h("p", { class: "muted" }, t("짝이 없는 입금 중 금액이 비슷(±5%)하거나 입금 기한 앞뒤 3일에 들어온 입금이 없어요."))),
      sec(t("확인 메모 · 처리 상태"), noteBox(d)));
  }

  // 직접 연결한 입금(풀 수 있다)
  function linkedBox() {
    const list = st.data.deposits.map((d, i) => ({ d, i })).filter(({ d }) => d.linked);
    if (!list.length) return null;
    return h("div", { class: "stack" },
      h("h3", { class: "sub-title" }, t("직접 연결한 입금 {n}건", { n: list.length })),
      h("div", { class: "rowlist" }, list.map(({ d, i }) => h("div", { class: "item col static" },
        h("b", null, `${labelMD(d.date)} · ${d.payer || t("입금처 없음")}`),
        h("span", { class: "hint" }, t("→ {sale} {method} 매출에 연결", { sale: labelMD(d.saleDate), method: METHOD_LABEL[d.method] })),
        h("button", { type: "button", class: "btn ghost slim", "aria-label": t("{dep} {payer}의 연결 해제", { dep: labelMD(d.date), payer: d.payer || t("입금") }), onclick: () => unlinkDeposit(i) }, t("연결 해제"))))));
  }

  function missingTable(res) {
    const rows = res.missing.map((r) => {
      const d = buildDetail(r, res, st.notes), isOpen = st.open === d.key, over = r.state === "over";
      return h("div", { class: "rc-miss" + (isOpen ? " open" : ""), "data-rk": "m:" + d.key },
        h("button", { type: "button", class: "rc-miss-head", "aria-expanded": isOpen ? "true" : "false", onclick: () => { st.open = isOpen ? null : d.key; draw(["m:" + d.key]); } }, // 다른 줄이 열려 있어도 누른 줄이 제자리에 있게
          h("div", { class: "rc-row1" }, h("b", null, `${labelMD(r.date)} · ${METHOD_LABEL[r.method]}`),
            h("span", { class: "badges" }, h("span", { class: "badge bad" }, over ? t("초과 입금") : t("누락 의심")), r.est && h("span", { class: "badge" }, t("추정")),
              d.status !== "pre" && h("span", { class: "badge " + (d.status === "done" ? "ok" : "warn") }, d.statusText),
              h("span", { class: "rc-caret", "aria-hidden": "true" }, isOpen ? "▴" : "▾"))),
          h("div", { class: "rc-cols" }, cell(t("매출"), fmtMan(r.amount)), cell(t("입금+수수료"), fmtMan(r.paid)), cell(t("차이"), (over ? "+" : "") + fmtMan(over ? -r.diff : r.diff), "err")),
          h("span", { class: "hint" }, t("입금 기한 {due} · {late} 지남 · {act}", { due: labelMD(r.due), late: dayText(d.lateDays), act: isOpen ? t("누르면 접혀요") : t("눌러서 상세 보기") }))),
        isOpen && detailView(r, d, res));
    });
    const needFee = res.feeRates.some((f) => f.feeDone === 0 && f.salesDone > 0 && f.method !== "cash");
    const confirmed = res.rows.filter((r) => r.confirmed), anyEst = confirmed.some((r) => r.est && !r.explicit);
    return h("section", { class: "sec stack", "data-rk": "miss" },
      h("h2", { class: "sec-title" }, t("누락 점검표") + " " + (res.missing.length ? t("({n}건)", { n: res.missing.length }) : "")),
      h("p", { class: "hint" }, t("입금 기한이 지났는데 입금이 안 맞는 매출이에요. 차이는 빨간색.")),
      res.missing.length ? h("div", { class: "rowlist" }, rows)
        : !res.rows.length ? h("p", { class: "muted" }, t("이 달 분석 범위에 매출 자료가 없어요."))
        : !confirmed.length ? h("p", { class: "muted" }, t("입금 기한이 지난 매출이 아직 없어요."))
        : h("p", { class: "ok-text" }, t("✓ 입금 기한이 지난 매출은 모두 입금과 맞아요.")),
      linkedBox(),
      anyEst && h("p", { class: "hint" }, t("매출일이 없는 입금(현금·배달앱 묶음 입금 등)은 오래된 매출부터 채운 추정이라, 누락이 있어도 뒤에 들어온 입금이 앞 매출을 채워 가려질 수 있어요. 결제수단별 합계(요약)를 같이 보세요. 자료 시작 전 매출 중 못 받은 돈은 이월 미수금에 넣어야 해요.")),
      res.missing.some((r) => r.est) && h("p", { class: "hint" }, t("‘추정’은 매출일 없는 입금을 오래된 매출부터 채워서 계산한 거예요. 날짜는 어긋날 수 있고, 결제수단별 합계는 정확해요.")),
      needFee && h("p", { class: "hint" }, t("수수료 정보가 없는 결제수단은 수수료만큼도 ‘차이’로 보여요. 계약 수수료율을 넣으면 정확해져요(⚙ 정산 설정).")));
  }

  function timeline(res) {
    const S = st.settings, byDate = new Map(res.days.map((d) => [d.date, d]));
    const first = res.period.from, last = res.summary.T < res.period.monthTo ? res.summary.T : res.period.monthTo;
    const cells = [];
    for (let i = 0; i < dow(first); i++) cells.push(h("span", { class: "rc-day blank", "aria-hidden": "true" }));
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const row = byDate.get(d);
      const label = d === first || d.endsWith("-01") ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : String(Number(d.slice(8)));
      if (!row) { cells.push(h("span", { class: "rc-day blank" }, h("span", { class: "n" }, label))); continue; }
      cells.push(h("button", { type: "button", class: `rc-day ${row.band}` + (st.sel === d ? " sel" : ""), "aria-label": `${labelMD(d)} ${bandName(row.band)}`, "aria-pressed": st.sel === d ? "true" : "false", onclick: () => { st.sel = st.sel === d ? null : d; draw(); } },
        h("span", { class: "n" }, label), h("span", { class: "m" }, BAND_MARK[row.band])));
    }
    const sel = st.sel && byDate.get(st.sel);
    return h("section", { class: "sec stack" },
      h("h2", { class: "sec-title" }, t("일별 타임라인")),
      h("p", { class: "hint" }, t("매출일 기준이에요. 입금 기한(매출일 + 정산일수)이 기준일 {asOf} 이전이면 입금이 끝났어야 해서 ‘완료 확정’ 구간이에요. 결제수단 중 하나라도 안 맞으면 그날은 ‘누락 의심’이에요.", { asOf: labelMD(S.asOf) })),
      h("div", { class: "rc-legend" }, ["done", "pending", "missing"].map((b) => h("span", { class: `rc-key ${b}` }, `${BAND_MARK[b]} ${bandName(b)}`))),
      h("div", { class: "rc-wd", "aria-hidden": "true" }, dowNames().map((w) => h("span", null, w))),
      h("div", { class: "rc-days" }, cells),
      sel && h("div", { class: "card sub" },
        h("h3", null, t("{date} 매출 {sales} · 입금+수수료 {paid}", { date: labelMD(sel.date), sales: fmtMan(sel.sales), paid: fmtMan(sel.paid) })),
        sel.methods.map((m) => {
          const r = res.rows.find((x) => x.date === sel.date && x.method === m.method);
          return h("div", { class: "lrow" }, h("span", null, `${METHOD_LABEL[m.method]} · ${stateName(m.state)}`), h("span", { class: "num" + (r && (m.state === "missing" || m.state === "over") ? " err" : ""), style: wrapNum() }, `${fmtMan(m.amount)} → ${fmtMan(m.paid)}`));
        }),
        h("span", { class: "hint" }, t("입금 기한 {due}", { due: labelMD(sel.due) }) + (sel.methods.some((m) => res.rows.find((x) => x.date === sel.date && x.method === m.method)?.est) ? " · " + t("입금은 오래된 매출부터 채운 추정") : ""))));
  }

  function feeSection(res) {
    const rows = res.feeRates.filter((f) => f.salesDone > 0);
    return h("section", { class: "sec stack" },
      h("h2", { class: "sec-title" }, t("수수료율")),
      h("p", { class: "hint" }, t("입금 기한이 지난 ‘완료 구간’만으로 (매출 − 입금) ÷ 매출을 계산해요. 누락 의심인 날이 섞이면 그만큼 높게 나오니, 그런 날을 뺀 값도 같이 보여 줘요.")),
      rows.length ? h("div", { class: "rowlist" }, rows.map((f) => {
        const useClean = f.missingN > 0 && f.rateClean != null, base = useClean ? f.rateClean : f.rate;
        const diffPP = f.contract != null && base != null ? (base - f.contract) * 100 : null;
        const verdict = diffPP == null ? null : Math.abs(diffPP) < 0.05 ? [t("계약과 같아요"), ""] : diffPP > 0 ? [t("계약보다 {pp}%p 높아요", { pp: fmtDec(diffPP, 2) }), "bad"] : [t("계약보다 {pp}%p 낮아요", { pp: fmtDec(-diffPP, 2) }), "ok"];
        return h("div", { class: "item col static" },
          h("div", { class: "rc-row1" }, h("b", null, METHOD_LABEL[f.method]), verdict && h("span", { class: `badge ${verdict[1]}` }, verdict[0])),
          h("div", { class: "rc-cols" }, cell(t("실효 수수료율"), fmtPct(f.rate)), cell(t("계약"), f.contract != null ? fmtPct(f.contract) : t("미입력")), cell(t("누락 제외"), f.missingN > 0 && f.rateClean != null ? fmtPct(f.rateClean) : "-")),
          h("span", { class: "hint" }, t("완료 구간 매출 {sales} → 입금 {net}", { sales: fmtMan(f.salesDone), net: fmtMan(f.netDone) }) + (useClean ? " · " + t("계약과 비교는 누락 제외 값") : "")),
          f.derived && h("span", { class: "hint" }, t("수수료 칸이 없어 계약 수수료율로 역산한 입금이에요. 실제 수수료가 계약보다 높으면 ‘누락 의심’으로 보일 수 있어요.")));
      })) : h("p", { class: "muted" }, t("입금 기한이 지난 매출이 아직 없어요.")));
  }

  function view() {
    const S = st.settings;
    const eff = S.openingMonth && S.openingMonth !== S.month ? { ...S, opening: {} } : S; // 이월 미수금은 넣은 달에만 쓴다
    let res;
    try { res = analyze(st.data, eff); } catch (e) { console.error(e); return h("div", { class: "page" }, back(), h("p", { class: "err" }, t("계산하지 못했어요: {msg}", { msg: errText(e.message) }))); }
    st.last = { res, eff }; // 내역서·엑셀이 화면과 같은 결과를 쓰게 한다
    const empty = !isDemoSrc() && !st.data.sales.length && !st.data.deposits.length;
    return h("div", { class: "page" },
      back(), h("h1", null, t("🧮 매출-입금 대조")),
      sourceBar(res), controls(res),
      // 엑셀 열 이름(일자·결제수단·매출액 …)은 올린 파일에서 알아보는 한국어 낱말이라 번역하지 않고 자리표시자로 그대로 보여 준다
      empty ? h("div", { class: "card" }, h("p", { style: "margin:0" }, t("아직 넣은 자료가 없어요. 위 버튼으로 매출과 입금을 넣거나 엑셀을 올려 주세요.")), h("p", { class: "hint" }, t("엑셀 열 이름: 매출 = {sales} / 입금 = {deps}.", { sales: "일자·결제수단·매출액", deps: "입금일·입금처·입금액(·매출일·수수료)" }))) : [warnings(res), summary(res), missingTable(res), timeline(res), feeSection(res)]);
  }

  draw();
}
