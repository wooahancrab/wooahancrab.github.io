// 회사 용어집(대표·부대표): 번역할 때 지킬 회사 용어를 언어별로 정해 두는 화면.
// 표(glossary_terms)를 RLS 로 직접 읽고 쓴다(supabase/glossary.sql) → 모두 api.gl* 를 통해서만(lib/api.js). 화면에는 실제 용어를 넣지 않는다(용어는 DB 에만 있다).
// 사용: renderGlossary(자리 요소, { profile, onBack }) — 자리 안을 스스로 그리고 다시 그린다.
// 사용자가 쓴 글은 모두 글자(textContent)로만 넣는다(innerHTML 안 씀).
// 화면 위치 유지: 저장·삭제·불러오기 뒤 다시 그려도 보던 자리를 그대로 둔다(검색 칸·목록·버튼 줄을 따로 그린다).
import { api } from "../lib/api.js";
import { h, toast, confirmDialog, modal, bigToggle, seg } from "../lib/ui.js";
import { t, tx } from "../lib/i18n.js";

// 용어집을 쓸 수 있는 역할. 서버 SQL 함수 can_manage_glossary()(supabase/glossary.sql) 와 항상 같게 둔다.
// 회장(chairman) 역할이 생기면 여기와 그 SQL 함수에 한 줄씩만 더한다(CLAUDE.md 3단계 목록).
export const GLOSSARY_ROLES = ["owner", "deputy"];
export const canManageGlossary = (role) => GLOSSARY_ROLES.includes(role);

const MAX = { ko: 40, vi: 80, en: 80, note: 120, aliases: 120 }; // 서버 check 와 같게
const COMPOSE_MAX = 1500; // 공지·말로 업무지시가 읽는 합성 글(ai_config.glossary)의 한도. 서버 glossary_rebuild() 와 같게
const BAD = /[<>\u0000-\u001f\u007f]/; // 서버 check 의 '[<>[:cntrl:]]' (프롬프트를 빠져나가는 글자·줄바꿈·탭)
const DRAFT_CAP = 60; // AI 초안을 한 번 눌러 채우는 용어 수 상한(비용 보호)

/* ---------- 순수 함수(시험용으로 내보낸다) ---------- */
export const cpLen = (s) => Array.from(String(s ?? "")).length;
// 합성 글 한 줄에 들어가는 칸: | ; < > 와 공백 덩어리는 한 칸 공백으로(서버 glossary_rebuild 와 같은 규칙)
const flat = (s) => String(s ?? "").replace(/[<>|;\s]+/g, " ").trim();
// 성조·대소문자를 무시하고 찾기(베트남어를 성조 없이 쳐도 찾는다)
export const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").toLowerCase();

/** 합성 글의 한 줄. 서버 glossary_rebuild() 와 같은 모양이어야 한다. 알려 줄 게 없는 용어(번역·메모 없음)는 null */
export function lineOf(r) {
  const ko = flat(r?.ko);
  if (!ko) return null;
  if (r.keep_ko) return `${ko} → 번역하지 않고 그대로 씀;`;
  const parts = [];
  const vi = flat(r.vi), en = flat(r.en), note = flat(r.note);
  if (vi) parts.push("vi: " + vi);
  if (en) parts.push("en: " + en);
  let body = parts.join(" / ");
  if (note) body = (body + " (" + note + ")").trim();
  return body ? `${ko} → ${body};` : null;
}

/** 서버 순서(항상 넣기 → sort → 한국어)로 온 rows 에서 합성 글에 몇 개가 들어가는지 센다: {total, used, empty, cut, len} */
export function composeStats(rows) {
  let len = 0, used = 0, empty = 0, cut = 0, hit = false;
  for (const r of rows ?? []) {
    const ln = lineOf(r);
    if (ln == null) { empty++; continue; }
    if (hit) { cut++; continue; }
    const add = (len ? 1 : 0) + cpLen(ln);
    if (len + add > COMPOSE_MAX) { hit = true; cut++; continue; }
    len += add; used++;
  }
  return { total: (rows ?? []).length, used, empty, cut, len };
}

/** 줄임말: 쉼표(, ， 、)·줄바꿈으로 나눠 앞뒤 공백을 떼고 중복을 지운 뒤 ", " 로 이어 붙인다 */
export function normAliases(s) {
  const seen = new Set(), out = [];
  for (const p of String(s ?? "").split(/[,，、\n]/)) {
    const v = p.trim().replace(/\s+/g, " ");
    const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out.join(", ");
}

const FIELD_NAME = { ko: "한국어", vi: "베트남어", en: "영어", note: "메모", aliases: "줄임말" };
// 한 칸의 값을 검사해 문제가 있으면 화면 언어의 오류 문장, 없으면 ""
export function fieldError(key, value) {
  const v = String(value ?? "").trim();
  const name = t(FIELD_NAME[key]);
  if (key === "ko" && !v) return t("{name}: 꼭 적어 주세요", { name });
  if (BAD.test(v)) return t("{name}: < > 와 줄바꿈은 쓸 수 없어요", { name });
  if (cpLen(v) > MAX[key]) return t("{name}: {n}자까지 쓸 수 있어요", { name, n: MAX[key] });
  return "";
}

/** 붙여넣은 글 읽기: 한 줄에 `한국어 | 베트남어 | 영어`(엑셀에서 복사한 탭도 됨). haveKo = 이미 있는 한국어 목록
 *  돌려주는 값: { ok:[{ko,vi,en}], dup(이미 있어서 건너뜀), bad:[{line,msg}], lines(읽은 줄 수) } */
export function parsePaste(text, haveKo) {
  const have = new Set((haveKo ?? []).map((k) => String(k).toLowerCase()));
  const ok = [], bad = [];
  let dup = 0, lines = 0;
  String(text ?? "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    lines++;
    const cols = line.split(/[|\t]/).map((s) => s.trim());
    while (cols.length > 3 && cols[cols.length - 1] === "") cols.pop(); // 줄 끝에 남은 구분자(| 또는 탭)는 빈 칸이니 무시
    if (cols.length > 3) { bad.push({ line: i + 1, msg: t("칸이 너무 많아요 (한국어 | 베트남어 | 영어)") }); return; }
    const [ko, vi = "", en = ""] = cols;
    const msg = fieldError("ko", ko) || fieldError("vi", vi) || fieldError("en", en);
    if (msg) { bad.push({ line: i + 1, msg }); return; }
    const key = ko.toLowerCase();
    if (have.has(key)) { dup++; return; }
    have.add(key);
    ok.push({ ko, vi, en });
  });
  return { ok, dup, bad, lines };
}

// 오류 문장을 화면 언어로. DB·네트워크가 주는 영어 원문은 알아볼 수 있는 문장으로 바꾼다
function errMsg(e) {
  const m = String(e?.message ?? "");
  if (m && !/[가-힣]/.test(m)) return /failed to fetch|networkerror|load failed|network request failed/i.test(m) ? t("서버에 연결하지 못했어요") : t("처리하지 못했어요");
  return t(m || "처리하지 못했어요");
}

/**
 * 용어집 화면. opts: { profile, onBack }. 권한(GLOSSARY_ROLES)이 없으면 아무것도 불러오지 않고 안내만 보여 준다.
 * 돌려주는 값: { reload() }
 */
export function renderGlossary(root, opts = {}) {
  const { profile, onBack } = opts;
  const backBtn = onBack && h("button", { type: "button", class: "linkbtn back", onclick: onBack }, t("← 목록"));
  if (!canManageGlossary(profile?.role)) {
    root.replaceChildren(h("div", { class: "page" }, backBtn, h("h1", null, t("📖 회사 용어집")),
      h("p", { class: "err", role: "alert" }, t("이 화면은 대표·부대표만 쓸 수 있어요"))));
    return { reload() {} };
  }

  let rows = [], loaded = false, loadErr = "", loadMissing = false;
  let q = "", filter = "all";
  let busy = "", progress = null; // busy: "" | "draft" | "import"
  let editing = false;
  const asking = new Set(); // 지울지 묻는 창이 떠 있는 용어(빠르게 두 번 눌러도 창이 겹치지 않게)

  const sumHost = h("div");
  const barHost = h("div", { class: "gl-bar" });
  const chipHost = h("div", { class: "gl-filter" });
  const listHost = h("div", { class: "gl-list" });
  const searchIn = h("input", { type: "search", class: "inp gl-search", placeholder: t("용어 찾기"), "aria-label": t("용어 찾기"), autocomplete: "off", enterkeyhint: "search" });
  searchIn.addEventListener("input", () => { q = searchIn.value; paintList(); });
  root.replaceChildren(h("div", { class: "page gl-page" }, backBtn,
    h("h1", null, t("📖 회사 용어집")),
    h("p", { class: "muted" }, t("번역할 때 꼭 지킬 회사 용어를 정해 두는 곳이에요. 공지·업무지시 번역에 쓰여요.")),
    sumHost, barHost, searchIn, chipHost, listHost));

  /* ---------- 데이터 ---------- */
  async function load() {
    try { rows = await api.glList(); loaded = true; loadErr = ""; loadMissing = false; }
    catch (e) {
      if (loaded) { toast(errMsg(e), 4000); draw(); return; } // 이미 목록이 있으면 그대로 두고 알리기만(버튼 줄은 다시 그려 '불러오는 중…' 잠금이 남지 않게)
      loadErr = errMsg(e); loadMissing = e?.code === "missing";
    }
    draw();
  }
  const draftable = () => rows.filter((r) => !r.keep_ko && (!r.vi || !r.en));

  /* ---------- 그리기 ---------- */
  // 키보드 포커스 유지: 다시 그리면 눌렀던 버튼이 새로 만들어져 포커스가 사라지므로 data-gk 열쇠로 같은 버튼을 찾아 돌려준다
  const gkOf = () => { const el = document.activeElement; return el && root.contains(el) ? el.getAttribute?.("data-gk") : null; };
  function keepFocus(fn) {
    const k = gkOf();
    fn();
    if (!k) return;
    const el = [...root.querySelectorAll("[data-gk]")].find((e) => e.getAttribute("data-gk") === k);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
  function draw() {
    const y = scrollY;
    keepFocus(() => { paintSum(); paintBar(); paintChips(); paintList(); });
    scrollTo(0, y);
  }

  function paintSum() {
    if (!loaded || !rows.length) { sumHost.replaceChildren(); return; }
    const s = composeStats(rows);
    sumHost.replaceChildren(h("div", { class: "card gl-sum", role: "status" },
      h("b", null, t("용어 {n}개 중 {m}개가 번역에 쓰여요", { n: s.total, m: s.used })),
      s.cut > 0 && h("div", { class: "gl-warn" }, t("글자 수 한도({max}자) 때문에 {n}개는 공지·말로 업무지시에 못 들어가요. 꼭 필요한 말은 '사업 용어'로 두면 앞에 들어가요.", { n: s.cut, max: COMPOSE_MAX })),
      s.empty > 0 && h("div", { class: "muted" }, t("번역 칸이 비어 있는 {n}개는 아직 쓰이지 않아요", { n: s.empty }))));
  }

  function paintBar() {
    const dis = !!busy || !loaded;
    const n = draftable().length;
    barHost.replaceChildren(
      h("button", { type: "button", class: "btn primary", "data-gk": "add", disabled: dis, onclick: () => openEditor(null) }, t("+ 용어 추가")),
      h("div", { class: "gl-bar2" },
        h("button", { type: "button", class: "btn ghost slim", "data-gk": "paste", disabled: dis, onclick: openPaste }, t("여러 줄 붙여넣기")),
        h("button", { type: "button", class: "btn ghost slim", "data-gk": "stores", disabled: dis, onclick: importStores }, busy === "import" ? t("불러오는 중…") : t("사업장 이름 불러오기")),
        h("button", { type: "button", class: "btn ghost slim", "data-gk": "draft", disabled: dis || n === 0, onclick: bulkDraft },
          busy === "draft" && progress ? t("채우는 중… {done}/{total}", { done: progress.done, total: progress.total }) : t("AI 초안으로 빈 칸 채우기 ({n})", { n }))));
  }

  const isUnverified = (r) => !r.keep_ko && !r.verified && !!(r.vi || r.en);
  const FILTERS = [["all", () => true], ["pinned", (r) => r.pinned], ["keep", (r) => r.keep_ko], ["unverified", isUnverified]];
  const FILTER_LABEL = { all: () => t("전체"), pinned: () => t("사업 용어"), keep: () => tx("용어집", "번역 없음"), unverified: () => t("확인 전") };
  function paintChips() {
    if (!loaded || !rows.length) { chipHost.replaceChildren(); return; }
    const opts2 = FILTERS.map(([k, fn]) => [k, `${FILTER_LABEL[k]()} ${rows.filter(fn).length}`]);
    const s = seg(opts2, filter, (v) => { filter = v; keepFocus(() => { paintChips(); paintList(); }); });
    [...s.querySelectorAll(".segbtn")].forEach((b, i) => { b.setAttribute("data-gk", "f:" + opts2[i][0]); b.setAttribute("aria-pressed", opts2[i][0] === filter ? "true" : "false"); });
    chipHost.replaceChildren(s);
  }

  function visible() {
    const fn = FILTERS.find(([k]) => k === filter)?.[1] ?? (() => true);
    const needle = fold(q.trim());
    return rows.filter((r) => fn(r) && (!needle || fold([r.ko, r.vi, r.en, r.note, r.aliases].join(" ")).includes(needle)));
  }

  function trLine(code, text) {
    return h("div", { class: "gl-tr", lang: code }, h("span", { class: "gl-lg", "aria-hidden": "true" }, code), h("span", null, text));
  }
  function card(r) {
    const badges = [];
    if (r.pinned) badges.push(h("span", { class: "badge info" }, t("사업 용어")));
    if (r.keep_ko) badges.push(h("span", { class: "badge" }, tx("용어집", "번역 없음")));
    if (isUnverified(r)) badges.push(h("span", { class: "badge warn" }, t("확인 전")));
    const lab = (text) => `${text}: ${r.ko}`;
    return h("div", { class: "card gl-card", "data-gl": r.id },
      h("div", { class: "gl-top" }, h("b", { class: "gl-ko" }, r.ko), badges.length > 0 && h("span", { class: "badges" }, badges)),
      r.vi && trLine("vi", r.vi),
      r.en && trLine("en", r.en),
      r.keep_ko && h("div", { class: "muted" }, t("번역하지 않고 한국어 그대로 써요")),
      !r.keep_ko && !r.vi && !r.en && h("div", { class: "muted" }, t("번역 칸이 비어 있어요")),
      r.note && h("div", { class: "muted" }, r.note),
      r.aliases && h("div", { class: "muted" }, t("줄임말: {names}", { names: r.aliases })),
      h("div", { class: "gl-acts" },
        h("button", { type: "button", class: "btn ghost slim", "data-gk": "edit:" + r.id, "aria-label": lab(t("고치기")), onclick: () => openEditor(r) }, t("고치기")),
        h("button", { type: "button", class: "btn danger slim", "data-gk": "rm:" + r.id, "aria-label": lab(t("삭제")), onclick: () => removeTerm(r) }, t("삭제"))));
  }

  function paintList() {
    if (loadErr && !loaded) {
      listHost.replaceChildren(...[
        h("p", { class: "err gl-err", role: "alert" }, t("불러오기 실패: {msg}", { msg: loadErr }), " ",
          h("button", { type: "button", class: "linkbtn", onclick: () => { loadErr = ""; paintList(); load(); } }, t("다시 시도"))),
        loadMissing && h("p", { class: "hint" }, t("용어집 SQL(glossary.sql)을 먼저 Run 해야 해요")),
      ].filter(Boolean));
      return;
    }
    if (!loaded) { listHost.replaceChildren(h("p", { class: "muted" }, t("불러오는 중…"))); return; }
    if (!rows.length) {
      listHost.replaceChildren(h("div", { class: "card gl-empty" }, h("b", null, t("아직 용어가 없어요")),
        h("p", { class: "muted" }, t("위의 '용어 추가'로 하나씩 넣거나, '사업장 이름 불러오기'로 사업장 이름을 한꺼번에 넣어 보세요."))));
      return;
    }
    const v = visible();
    listHost.replaceChildren(...(v.length ? v.map(card) : [h("p", { class: "muted" }, t("찾는 용어가 없어요"))]));
  }

  /* ---------- 창(.overlay/.dialog): 저장이 실패해도 닫지 않고 오류를 보여 준다 ---------- */
  // 열 때 창으로 포커스를 옮기고, Tab 이 창 밖으로 나가지 않게 가두며, 닫으면 눌렀던 버튼으로 돌려준다. ov.onEsc 가 있으면 Esc 로 닫는다
  let dlgSeq = 0;
  function dialog(...kids) {
    const box = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", tabindex: "-1" }, ...kids);
    const ov = h("div", { class: "overlay" }, box);
    const hd = box.querySelector("h2");
    if (hd) { hd.id = "gl-dlg-" + (++dlgSeq); box.setAttribute("aria-labelledby", hd.id); }
    box.style.outline = "0";
    const opener = document.activeElement;
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && ov.onEsc) { e.preventDefault(); ov.onEsc(); return; }
      if (e.key !== "Tab") return;
      const f = [...box.querySelectorAll("button, input, select, textarea")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1], cur = document.activeElement;
      if (e.shiftKey ? cur === first || cur === box : cur === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    });
    ov.close = () => { ov.remove(); const k = opener?.getAttribute?.("data-gk"); const el = (k && [...root.querySelectorAll("[data-gk]")].find((e) => e.getAttribute("data-gk") === k)) || (opener?.isConnected ? opener : null); el?.focus?.({ preventScroll: true }); };
    document.body.append(ov);
    box.focus({ preventScroll: true });
    return ov;
  }

  /* ---------- 용어 추가·고치기 ---------- */
  function openEditor(r) {
    if (editing) return;
    editing = true;
    const isNew = !r;
    const init = { ko: r?.ko ?? "", vi: r?.vi ?? "", en: r?.en ?? "", note: r?.note ?? "", aliases: r?.aliases ?? "" };
    let saving = false, drafting = false;
    const inp = (key, ph) => h("input", { type: "text", class: "inp", maxlength: String(MAX[key]), placeholder: ph, autocomplete: "off", "aria-label": t(FIELD_NAME[key]), value: init[key] });
    // 입력칸 안내문은 짧게(360px 폭에서 한 줄에 들어가야 '(선택)'이 보인다). 자세한 설명은 아래의 안내 문장(hint)에 있다
    const ins = {
      ko: inp("ko", t("한국어로 적어 주세요")),
      vi: inp("vi", t("비워 둬도 돼요 (선택)")),
      en: inp("en", t("비워 둬도 돼요 (선택)")),
      note: inp("note", t("뜻 풀이·쓰임 (선택)")),
      aliases: inp("aliases", t("다른 표기 (선택)")),
    };
    const cnt = {};
    const lblRow = (key, label) => { cnt[key] = h("span", { class: "hint" }); return h("div", { class: "gl-lblrow" }, h("span", { class: "lbl" }, label), cnt[key]); };
    const count = () => { for (const k of Object.keys(ins)) cnt[k].textContent = `${cpLen(ins[k].value)}/${MAX[k]}`; };
    for (const k of Object.keys(ins)) ins[k].addEventListener("input", count);

    const tog = (label, on0, onChange) => {
      let on = on0;
      const wrap = h("div");
      const paint = (focus) => {
        const b = bigToggle(label, on, () => { if (saving) return; on = !on; onChange?.(on); paint(true); });
        wrap.replaceChildren(b);
        if (focus) b.focus({ preventScroll: true });
      };
      paint(false);
      return { el: wrap, get: () => on, set: (v) => { if (on !== v) { on = v; paint(false); } } };
    };
    const keepT = tog(t("번역하지 않고 한국어 그대로 두기"), !!r?.keep_ko);
    const pinT = tog(t("번역할 때 항상 넣기 (사업장 이름 같은 말)"), !!r?.pinned);
    const verT = tog(t("원어민이 확인했어요"), !!r?.verified);
    const unverify = () => { if (verT.get() && (ins.vi.value.trim() !== init.vi || ins.en.value.trim() !== init.en)) verT.set(false); }; // 번역을 고치면 확인 표시는 꺼진다
    ins.vi.addEventListener("input", unverify); ins.en.addEventListener("input", unverify);

    const errEl = h("p", { class: "err gl-err", role: "alert", hidden: true });
    const fail = (m) => { errEl.textContent = m; errEl.hidden = false; };
    const saveBtn = h("button", { type: "button", class: "btn primary" }, t("저장"));
    const cancelBtn = h("button", { type: "button", class: "btn ghost" }, t("취소"));
    const draftBtn = h("button", { type: "button", class: "btn weak slim gl-draft" }, t("AI 초안으로 빈 칸 채우기"));
    const lock = (on) => { saving = on; saveBtn.disabled = on || drafting; cancelBtn.disabled = on; draftBtn.disabled = on || drafting; saveBtn.textContent = on ? t("저장하는 중…") : t("저장"); };
    const ov = dialog(
      h("h2", null, isNew ? t("용어 추가") : t("용어 고치기")),
      lblRow("ko", t("한국어 (필수)")), ins.ko,
      lblRow("vi", t("베트남어")), ins.vi,
      lblRow("en", t("영어")), ins.en,
      draftBtn,
      h("p", { class: "hint" }, t("AI 초안은 비어 있는 칸만 채워요. 직접 적은 칸은 그대로예요.")),
      lblRow("note", t("메모 (뜻·쓰임)")), ins.note,
      lblRow("aliases", t("줄임말")), ins.aliases,
      h("p", { class: "hint" }, t("줄임말이나 띄어쓰기를 바꾼 말을 쉼표로 나눠 적어요. 이 말이 글에 있어도 같은 용어로 봐요.")),
      keepT.el, pinT.el, verT.el,
      h("p", { class: "hint" }, t("번역을 고치면 '원어민이 확인했어요'는 꺼져요. 다시 읽어 보고 켜 주세요.")),
      errEl, saveBtn, cancelBtn);
    count();
    const done = () => { ov.close(); editing = false; };
    cancelBtn.addEventListener("click", () => { if (!saving) done(); });
    const dirty = () => Object.keys(ins).some((k) => ins[k].value.trim() !== init[k]);
    ov.onEsc = () => { if (!saving && !dirty()) done(); }; // 쓰던 글이 있으면 Esc 로는 닫지 않는다(실수로 잃지 않게)

    draftBtn.addEventListener("click", async () => {
      if (saving || drafting) return;
      errEl.hidden = true;
      const ko = ins.ko.value.trim();
      const e0 = fieldError("ko", ko);
      if (e0) { fail(e0); ins.ko.focus(); return; }
      const vi = ins.vi.value.trim(), en = ins.en.value.trim();
      if (vi && en) { fail(t("비어 있는 칸이 없어요")); return; }
      drafting = true; draftBtn.disabled = true; saveBtn.disabled = true; draftBtn.textContent = t("만드는 중…");
      try {
        const res = await api.glDraft([{ key: "x", ko, vi, en }]);
        const f = res?.filled?.x ?? {};
        if (!f.vi && !f.en) fail(t("초안을 만들지 못했어요. 잠시 뒤에 다시 해 주세요"));
        else {
          if (f.vi && !ins.vi.value.trim()) ins.vi.value = f.vi;
          if (f.en && !ins.en.value.trim()) ins.en.value = f.en;
          verT.set(false); count();
        }
      } catch (e) { fail(errMsg(e)); }
      drafting = false; draftBtn.textContent = t("AI 초안으로 빈 칸 채우기"); lock(false);
    });

    saveBtn.addEventListener("click", async () => {
      if (saving || drafting) return; // 두 번 눌러도 한 번만
      errEl.hidden = true;
      const v = {};
      for (const k of Object.keys(ins)) v[k] = ins[k].value.trim();
      v.aliases = normAliases(v.aliases);
      for (const k of ["ko", "vi", "en", "note", "aliases"]) {
        const m = fieldError(k, v[k]);
        if (m) { fail(m); ins[k].focus(); return; }
      }
      if (rows.some((x) => x.id !== r?.id && x.ko.toLowerCase() === v.ko.toLowerCase())) { fail(t("이미 같은 한국어 용어가 있어요")); ins.ko.focus(); return; }
      lock(true);
      try {
        await api.glSave({ ...(r ? { id: r.id, sort: r.sort } : {}), ...v, keep_ko: keepT.get(), pinned: pinT.get(), verified: verT.get() });
      } catch (e) { lock(false); fail(errMsg(e)); return; } // 실패하면 창을 닫지 않고 쓴 내용을 그대로 둔다
      done();
      await load();
      toast(t("저장했어요"));
    });
    ins.ko.focus({ preventScroll: true });
  }

  /* ---------- 여러 줄 붙여넣기 ---------- */
  function openPaste() {
    if (editing) return;
    editing = true;
    let saving = false;
    const ta = h("textarea", { class: "inp", rows: "8", autocomplete: "off", spellcheck: "false", "aria-label": t("붙여넣을 용어"),
      placeholder: t("한 줄에 하나씩\n한국어 | 베트남어 | 영어") });
    const prev = h("div", { class: "gl-prev", role: "status" });
    const errEl = h("p", { class: "err gl-err", role: "alert", hidden: true });
    const saveBtn = h("button", { type: "button", class: "btn primary", disabled: true }, t("저장"));
    const cancelBtn = h("button", { type: "button", class: "btn ghost" }, t("취소"));
    let parsed = { ok: [], dup: 0, bad: [], lines: 0 };
    const refresh = () => {
      parsed = parsePaste(ta.value, rows.map((x) => x.ko));
      const kids = [];
      if (parsed.lines) {
        kids.push(h("div", null, t("{n}줄을 읽었어요", { n: parsed.lines })));
        kids.push(h("div", { class: parsed.ok.length ? "ok-text" : "muted" }, t("새 용어 {n}개", { n: parsed.ok.length })));
        if (parsed.dup) kids.push(h("div", { class: "muted" }, t("이미 있어서 건너뛰는 용어 {n}개", { n: parsed.dup })));
        if (parsed.bad.length) {
          kids.push(h("div", { class: "err" }, t("고쳐야 하는 줄 {n}개 (저장할 때 빼요)", { n: parsed.bad.length })));
          for (const b of parsed.bad.slice(0, 5)) kids.push(h("div", { class: "err hint" }, t("{line}번째 줄: {msg}", { line: b.line, msg: b.msg })));
        }
      }
      prev.replaceChildren(...kids);
      saveBtn.disabled = saving || parsed.ok.length === 0;
      saveBtn.textContent = saving ? t("저장하는 중…") : parsed.ok.length ? t("{n}개 저장", { n: parsed.ok.length }) : t("저장");
    };
    ta.addEventListener("input", refresh);
    const ov = dialog(h("h2", null, t("여러 줄 붙여넣기")),
      h("p", { class: "hint" }, t("한 줄에 용어 하나. 칸은 | 로 나눠요. 엑셀에서 복사해 붙여도 돼요. 비워 둔 칸은 나중에 AI 초안으로 채울 수 있어요.")),
      ta, prev, errEl, saveBtn, cancelBtn);
    const done = () => { ov.close(); editing = false; };
    cancelBtn.addEventListener("click", () => { if (!saving) done(); });
    ov.onEsc = () => { if (!saving && !ta.value.trim()) done(); };
    saveBtn.addEventListener("click", async () => {
      if (saving || !parsed.ok.length) return;
      saving = true; cancelBtn.disabled = true; errEl.hidden = true; refresh();
      let res;
      try { res = await api.glAddMany(parsed.ok); }
      catch (e) { saving = false; cancelBtn.disabled = false; refresh(); errEl.textContent = errMsg(e); errEl.hidden = false; return; }
      done();
      await load();
      toast(res.skipped ? t("{n}개를 저장했어요 (이미 있는 {m}개는 건너뛰었어요)", { n: res.added, m: res.skipped }) : t("{n}개를 저장했어요", { n: res.added }), 4000);
    });
    ta.focus({ preventScroll: true });
  }

  /* ---------- 사업장 이름 불러오기 · AI 초안 · 삭제 ---------- */
  async function importStores() {
    if (busy) return;
    busy = "import"; keepFocus(paintBar);
    try {
      const r = await api.glImportStores();
      busy = "";
      await load();
      toast(r.added ? t("사업장 이름 {n}개를 가져왔어요. 번역하지 않는 이름으로 넣었어요", { n: r.added }) : t("새로 가져올 사업장 이름이 없어요"), 4000);
    } catch (e) { busy = ""; keepFocus(paintBar); toast(errMsg(e), 5000); }
  }

  async function bulkDraft() {
    if (busy) return;
    const todo = draftable().slice(0, DRAFT_CAP);
    if (!todo.length) return;
    const yes = await modal(t("AI 초안으로 빈 칸을 채울까요?"),
      h("ul", null, [t("빈 칸이 있는 용어 {n}개의 베트남어·영어 칸만 채워요", { n: todo.length }), t("직접 적은 칸은 그대로 둬요"), t("채운 용어는 '확인 전'이 돼요. 원어민이 읽어 보고 확인해 주세요")].map((s) => h("li", null, s))),
      t("채우기"), t("취소")); // 채우는 쪽이 눈에 띄는 버튼(지우기 확인창과 달리 되돌릴 수 있는 일이다)
    if (!yes || busy) return;
    busy = "draft"; progress = { done: 0, total: todo.length }; keepFocus(paintBar);
    let res;
    try { res = await api.glDraft(todo.map((r) => ({ key: r.id, ko: r.ko, vi: r.vi, en: r.en })), (done, total) => { progress = { done, total }; keepFocus(paintBar); }); }
    catch (e) { busy = ""; progress = null; keepFocus(paintBar); toast(errMsg(e), 5000); return; }
    // 채우는 동안(길면 수십 초) 다른 창·기기에서 사람이 적은 칸이 있을 수 있어서, 저장 직전에 최신 목록을 다시 읽고 '지금' 비어 있는 칸만 채운다
    let fresh = null;
    try { fresh = new Map((await api.glList()).map((x) => [x.id, x])); } catch { fresh = null; }
    if (!fresh) { busy = ""; progress = null; keepFocus(paintBar); toast(t("채우지 못했어요. 잠시 뒤에 다시 해 주세요"), 5000); return; } // 최신 상태를 모르면 사람이 적은 칸을 덮을 수 있어 저장하지 않는다
    let saved = 0, lost = 0;
    for (const r0 of todo) { // 직접 적은 칸은 덮지 않는다: 비어 있던 칸만, 고친 칸만 보낸다
      const r = fresh.get(r0.id);
      if (!r || r.keep_ko) continue; // 그 사이 지워졌거나 '번역하지 않고 그대로 두기'로 바뀐 용어
      const f = res?.filled?.[r0.id];
      if (!f) continue;
      const patch = { id: r.id, verified: false };
      if (!r.vi && f.vi) patch.vi = f.vi;
      if (!r.en && f.en) patch.en = f.en;
      if (!patch.vi && !patch.en) continue;
      try { await api.glSave(patch); saved++; } catch { lost++; }
    }
    busy = ""; progress = null;
    await load();
    if (saved) toast(lost ? t("{n}개를 채웠어요. {m}개는 저장하지 못했어요", { n: saved, m: lost }) : t("{n}개를 채웠어요. 원어민 확인 전이에요", { n: saved }), 5000);
    else toast(t("채우지 못했어요. 잠시 뒤에 다시 해 주세요"), 5000);
  }

  async function removeTerm(r) {
    if (asking.has(r.id)) return;
    asking.add(r.id);
    // confirmDialog 는 내용을 t()로 한 번 더 번역해서, 용어가 화면 문구와 같으면(예: '게장') 용어 대신 그 번역이 보인다 → 눈에 안 보이는 글자(U+200B)를 붙여 사전에서 못 찾게 한다
    const yes = await confirmDialog(t("이 용어를 지울까요?"), [r.ko + "​", t("지우면 번역에서 더 이상 쓰이지 않아요")], t("취소"), t("삭제"));
    asking.delete(r.id);
    if (!yes) return;
    try {
      await api.glDelete(r.id);
      rows = rows.filter((x) => x.id !== r.id);
      draw();
      toast(t("삭제했어요"));
    } catch (e) { toast(errMsg(e), 5000); }
  }

  paintList();
  paintBar();
  load();
  return { reload: () => load() };
}
