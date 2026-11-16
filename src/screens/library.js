// 서식·자료함: 권한이 있는 사람이 앱에서 바로 파일을 올리고, 공개 범위 안의 직원이 열어 보거나 내려받는다.
// 파일 본체는 Supabase Storage(비공개) — 열 때마다 60초짜리 임시 주소를 받아서 연다(library.sql).
// 언어판(library2.sql): 문서 한 장 = 원본 + 그 번역본들(번역본의 doc_id 가 원본을 가리킨다). 카드에는 내 언어판을 먼저, 다른 언어판은 작은 칩으로 보여 준다.
import { api } from "../lib/api.js";
import { h, toast, modal, confirmDialog } from "../lib/ui.js";
import { dateOf, labelMD } from "../lib/kst.js";
import { t, tx, lang, LANGS, isLang } from "../lib/i18n.js";

const AUD = { all: "전 직원", store: "사업장", admin: "관리자" }; // 보일 때 t(AUD[...])로 감싼다
const TOP_ROLES = ["owner", "deputy"]; // 자료를 올리고 사업장을 고를 수 있는 직책. 회장(chairman) 역할이 생기면 여기에 한 줄 추가(서버는 library.sql 의 my_role() in (...) 도 같이)
const LANG_NAME = Object.fromEntries(LANGS); // 배지·칩·고르는 칸의 언어 이름은 그 나라 글자 그대로 보인다(번역하지 않는다)
const LANG_SAY = { ko: "한국어", vi: "베트남어", en: "영어" }; // 문장 속 언어 이름은 보는 사람 언어로 풀어 쓴다(한국어 문장에 'Tiếng Việt판', 영어 문장에 '한국어 version'이 끼지 않게)
const sayLang = (k) => tx("언어 이름", LANG_SAY[k]);
const FOLDER_FIRST = "매뉴얼"; // 폴더 줄·폴더 입력 목록에서 맨 앞
const FOLDER_COMMON = new Set(["매뉴얼", "서식", "규정", "안전", "계약", "인사"]); // 흔한 폴더 이름은 '보여 줄 때만' 번역한다(저장되는 값은 한국어 그대로)
const folderLabel = (n) => (FOLDER_COMMON.has(n) ? tx("자료함", n) : n);
// 올리기 양식에서 '새 문서'(원본 연결 없음)의 언어 기본값은 늘 한국어다. 마지막 선택을 기억하면 한국어 문서가 베트남어로 올라가기 쉽다
const vLang = (f) => (isLang(f.lang) ? f.lang : "ko"); // 언어 표시가 없는 옛 파일은 한국어
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");
const iconOf = (f) => {
  const n = (f.file_name || "").toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n)) return "📊"; if (/\.(docx?|hwp|hwpx)$/.test(n)) return "📄"; if (/\.pdf$/.test(n)) return "📕";
  if (/\.(pptx?)$/.test(n)) return "📙"; if (/\.(jpe?g|png|gif|webp|heic)$/.test(n)) return "🖼"; if (/\.(zip|7z)$/.test(n)) return "🗜"; return "📎";
};
const audLabel = (f) => (f.audience === "store" ? (f.stores?.display_name ?? f.stores?.name ?? t(AUD.store)) : t(AUD[f.audience]));

// 문서 한 장 = 원본 + 그 번역본들. doc_id 가 가리키는 원본이 목록에 없으면(지웠거나 내가 못 보는 문서) 그 파일이 곧 원본이다.
// 순서는 원본이 올라온 순서(목록은 새 것이 먼저), 한 문서 안에서는 원본 → 한국어·베트남어·영어 순
export function groupDocs(files) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const rootOf = (f) => { // 원본까지 따라 올라간다(서로 가리키는 이상한 연결은 거기서 멈춘다)
    const seen = new Set([f.id]); let cur = f;
    while (cur.doc_id && byId.has(cur.doc_id) && !seen.has(cur.doc_id)) { cur = byId.get(cur.doc_id); seen.add(cur.id); }
    return cur;
  };
  const groups = new Map(), rest = [];
  for (const f of files) { if (rootOf(f) === f) groups.set(f.id, { root: f, versions: [f] }); else rest.push(f); }
  for (const f of rest) {
    const g = groups.get(rootOf(f).id);
    if (g) g.versions.push(f); else groups.set(f.id, { root: f, versions: [f] }); // 이상한 연결로 원본이 없으면 따로 보여 준다
  }
  const ord = (f) => LANGS.findIndex(([k]) => k === vLang(f));
  for (const g of groups.values()) g.versions.sort((a, b) => (a === g.root ? -1 : b === g.root ? 1 : ord(a) - ord(b)));
  return [...groups.values()];
}
// 보는 사람 언어판이 있으면 그 판, 없으면 원본
const shownOf = (g) => g.versions.find((v) => vLang(v) === lang()) ?? g.root;

export async function renderLibrary(root, opts = {}) {
  const prof = await api.getProfile();
  const top = TOP_ROLES.includes(prof.role);
  const canUpload = top || !!prof.can_settle;
  const canManage = (f) => f.uploaded_by === prof.user_id || prof.role === "owner"; // 고치기·지우기(서버 정책 lib_upd·lib_del 과 같게)
  let files = [], err = "", loading = true, folder = "all", q = "";
  let stores = [];

  async function load() {
    try { files = await api.libList(); err = ""; } catch (e) { err = e.message; }
    loading = false; draw();
  }

  async function open(f, download = false) {
    const w = download ? null : window.open("", "_blank"); // 팝업 차단을 피하려고 먼저 창을 연다
    try {
      const url = await api.libUrl(f, download);
      if (download) { const a = h("a", { href: url, download: f.file_name || "" }); document.body.append(a); a.click(); a.remove(); } else if (w) w.location = url; else location.href = url;
    } catch (e) { w?.close(); toast(t(e.message), 5000); }
  }
  async function remove(f) {
    const kids = files.some((x) => x.doc_id === f.id); // 원본을 지워도 번역본은 남는다(서버가 연결만 비운다)
    const items = [f.title, t("지우면 되돌릴 수 없어요")];
    if (kids) items.push(t("다른 언어판은 지워지지 않고, 따로 떨어진 문서가 돼요"));
    if (!(await confirmDialog(t("파일을 지울까요?"), items, t("취소"), t("지우기")))) return;
    try { await api.libDelete(f); toast(t("지웠어요"), 1800); await load(); } catch (e) { toast(t(e.message), 5000); }
  }

  // 한 문서(원본 rootId)에 이미 그 언어판이 있는가. exceptId = 지금 고치는 줄(자기 자신은 빼고 센다)
  const hasLang = (rootId, l, exceptId) => files.some((x) => (x.id === rootId || x.doc_id === rootId) && x.id !== exceptId && vLang(x) === l);
  const dupMsg = (l) => t("이 문서에는 이미 {lang}판이 있어요. 다른 언어를 고르거나, '원본 문서'를 '연결 안 함'으로 바꿔 주세요", { lang: sayLang(l) }); // 화면의 칸 이름과 같은 말로 알려 줘야 어느 칸을 만지는지 바로 알아요
  const langSelect = (value, usedLangs) => {
    const s = h("select", { class: "inp" }, LANGS.map(([k, n]) => h("option", { value: k, disabled: !!usedLangs && usedLangs.has(k) }, n)));
    s.value = value; return s;
  };
  const lbl = (s) => h("span", { class: "lbl" }, t(s));

  // 올리기 양식. addTo = 언어판을 더할 원본 행(없으면 그냥 새 파일 올리기: 원본은 같은 폴더 문서 중에서 고른다)
  async function upload(addTo = null) {
    if (top && !stores.length) stores = await api.listStores().catch(() => []);
    const used = addTo ? new Set(files.filter((x) => x.id === addTo.id || x.doc_id === addTo.id).map(vLang)) : null;
    const free = LANGS.map(([k]) => k).filter((k) => !used || !used.has(k));
    const mine = "ko";
    const file = h("input", { type: "file", class: "inp" });
    const title = h("input", { class: "inp", placeholder: t("이름 (예: 연차 신청서)"), maxlength: "60" });
    const folderIn = h("input", { class: "inp", placeholder: t("폴더 (예: 서식, 계약, 인사)"), maxlength: "20", list: "lib-folders" });
    const names = [...new Set([FOLDER_FIRST, ...files.map((f) => f.folder)])]; // 폴더 입력 목록: 매뉴얼이 맨 앞
    const dl = h("datalist", { id: "lib-folders" }, names.map((x) => h("option", { value: x })));
    folderIn.value = addTo ? addTo.folder : folder !== "all" ? folder : "서식"; // 폴더 이름은 사용자 데이터(저장되는 값)라 번역하지 않는다
    const picks = h("div", { class: "chips lb-picks" }); // 자주 쓰는 폴더를 눌러서 고른다(글자를 지우지 않아도 매뉴얼을 고를 수 있게)
    const drawPicks = () => picks.replaceChildren(...names.slice(0, 6).map((n) =>
      h("button", { type: "button", class: "chip" + (folderIn.value.trim() === n ? " on" : ""), onclick: () => { folderIn.value = n; folderChanged(); } }, folderLabel(n))));
    const note = h("input", { class: "inp", placeholder: t("설명 (선택)"), maxlength: "100" });
    const aud = h("select", { class: "inp" }, [["all", "전 직원이 볼 수 있어요"], ["store", "선택한 사업장 직원만"], ["admin", "대표·부대표·정산 권한자만"]].map(([v, l]) => h("option", { value: v }, t(l))));
    const st = h("select", { class: "inp" }, stores.map((s) => h("option", { value: s.id }, s.display_name ?? s.name)));
    const stRow = h("div", { style: "display:none" }, st);
    aud.onchange = () => { stRow.style.display = aud.value === "store" && top ? "" : "none"; };
    file.onchange = () => { if (!title.value && file.files[0]) title.value = file.files[0].name.replace(/\.[^.]+$/, ""); };

    const langSel = langSelect(addTo ? free[0] : mine, used); // 그냥 올리기는 마지막에 고른 언어, 언어판 추가는 남은 첫 언어
    const dflt = langSel.value;
    let langTouched = false; // 사람이 언어를 직접 골랐는가. 안 골랐으면 원본을 고를 때 그 원본에 없는 언어로 알아서 맞춰 준다(경고부터 뜨지 않게)
    const docSel = h("select", { class: "inp" });
    const warn = h("p", { class: "hint err", hidden: true }); // 같은 언어 중복 안내
    const check = () => {
      const dup = !!docSel.value && hasLang(docSel.value, langSel.value);
      warn.textContent = dup ? dupMsg(langSel.value) : ""; warn.hidden = !dup;
    };
    const autoLang = () => {
      if (langTouched) return;
      langSel.value = dflt;
      if (docSel.value && hasLang(docSel.value, dflt)) { const nx = LANGS.map(([k]) => k).find((k) => !hasLang(docSel.value, k)); if (nx) langSel.value = nx; }
    };
    const fillDocs = () => { // 원본 후보: 같은 폴더의 원본 문서(번역본이 아닌 것)
      const keep = docSel.value, f = folderIn.value.trim();
      const cand = files.filter((x) => !x.doc_id && x.folder === f);
      docSel.replaceChildren(h("option", { value: "" }, t("연결 안 함 (새 문서)")), ...cand.map((x) => h("option", { value: x.id }, `${x.title} · ${LANG_NAME[vLang(x)]}`)));
      docSel.value = cand.some((x) => x.id === keep) ? keep : "";
      autoLang(); check();
    };
    const folderChanged = () => { fillDocs(); drawPicks(); };
    langSel.onchange = () => { langTouched = true; check(); };
    docSel.onchange = () => { autoLang(); check(); };
    if (addTo) { // 문서 카드의 '언어판 추가': 원본·폴더·공개 범위를 미리 채우고 바꾸지 못하게 한다
      folderIn.disabled = true;
      docSel.replaceChildren(h("option", { value: addTo.id }, `${addTo.title} · ${LANG_NAME[vLang(addTo)]}`));
      docSel.value = addTo.id; docSel.disabled = true;
      aud.value = addTo.audience;
      if (addTo.audience === "store" && addTo.store_id && stores.some((s) => s.id === addTo.store_id)) st.value = addTo.store_id;
      stRow.style.display = aud.value === "store" && top ? "" : "none";
    } else { folderIn.oninput = folderChanged; folderChanged(); }

    // 순서: 파일 → 이름 → 폴더 → 원본 → 언어(중복 경고는 언어 바로 아래). 언어판 추가는 원본·폴더가 정해져 있어서 그 칸들을 빼고 '원본: …' 한 줄로 알려 준다(폰에서 양식이 짧아진다)
    const content = h("div", { class: "stack" },
      addTo && h("p", { class: "hint" }, t("원본: {title}", { title: `${addTo.title} · ${folderLabel(addTo.folder)}` })),
      lbl("파일 (20MB까지)"), file, lbl("이름"), title, addTo && h("p", { class: "hint" }, t("이 언어판에서 보일 이름이에요")),
      !addTo && [lbl("폴더"), folderIn, dl, picks,
        lbl("원본 문서 (번역본일 때만)"), docSel, h("p", { class: "hint" }, t("같은 폴더의 문서 중에서 골라요"))],
      lbl("언어"), langSel, warn,
      lbl("설명"), note, lbl("보는 사람"), aud, stRow);
    for (;;) {
      if (!(await modal(addTo ? t("언어판 추가") : t("파일 올리기"), content, t("올리기"), t("취소")))) return;
      const f = file.files[0];
      if (!f) { toast(t("파일을 골라 주세요")); continue; }
      if (!title.value.trim() || !folderIn.value.trim()) { toast(t("이름과 폴더를 넣어 주세요")); continue; }
      const store_id = aud.value === "store" ? (top ? st.value : prof.store_id) : null;
      if (aud.value === "store" && !store_id) { toast(t("사업장을 골라 주세요")); continue; }
      const doc_id = docSel.value || null, lg = langSel.value;
      if (doc_id && hasLang(doc_id, lg)) { toast(dupMsg(lg), 6000); check(); continue; } // 같은 언어를 한 원본에 두 번 잇지 않는다
      toast(t("올리는 중…"), 20000);
      try {
        await api.libUpload(f, { title: title.value.trim(), folder: folderIn.value.trim(), note: note.value.trim(), audience: aud.value, store_id, lang: lg, doc_id });
        toast(t("올렸어요"), 2000); await load(); return;
      } catch (e) { toast(t(e.message), 6000); }
    }
  }

  // 이름·언어·원본 연결 고치기(올린 사람·대표)
  async function edit(f) {
    const mineKids = files.some((x) => x.doc_id === f.id); // 번역본이 붙어 있는 원본은 다른 원본에 붙일 수 없다
    const title = h("input", { class: "inp", maxlength: "60", value: f.title });
    const langSel = langSelect(vLang(f));
    const docSel = h("select", { class: "inp" });
    const cand = files.filter((x) => !x.doc_id && x.id !== f.id && x.folder === f.folder);
    docSel.replaceChildren(h("option", { value: "" }, t("연결 안 함 (새 문서)")), ...cand.map((x) => h("option", { value: x.id }, `${x.title} · ${LANG_NAME[vLang(x)]}`)));
    docSel.value = f.doc_id && cand.some((x) => x.id === f.doc_id) ? f.doc_id : "";
    docSel.disabled = mineKids;
    const startLang = langSel.value, startDoc = docSel.value; // 사용자가 건드린 것만 보낸다(안 보이는 원본에 붙어 있던 연결을 실수로 끊지 않게)
    const warn = h("p", { class: "hint err", hidden: true });
    const rootFor = () => (docSel.value !== startDoc ? docSel.value : f.doc_id) || f.id; // 고친 뒤 이 줄이 속할 원본(연결이 없으면 자기 자신이 원본)
    const check = () => {
      const dup = hasLang(rootFor(), langSel.value, f.id);
      warn.textContent = dup ? dupMsg(langSel.value) : ""; warn.hidden = !dup;
    };
    langSel.onchange = check; docSel.onchange = check;
    const content = h("div", { class: "stack" },
      lbl("이름"), title, lbl("언어"), langSel,
      lbl("원본 문서 (번역본일 때만)"), docSel, mineKids && h("p", { class: "hint" }, t("이 문서에는 다른 언어판이 붙어 있어서 다른 원본에 연결할 수 없어요")), warn);
    for (;;) {
      if (!(await modal(t("언어·이름 고치기"), content, t("저장"), t("취소")))) return;
      const name = title.value.trim();
      if (!name) { toast(t("이름을 넣어 주세요")); continue; }
      const patch = {};
      if (name !== f.title) patch.title = name;
      if (langSel.value !== startLang) patch.lang = langSel.value;
      if (docSel.value !== startDoc) patch.doc_id = docSel.value || null;
      if (!Object.keys(patch).length) return;
      if (("lang" in patch || "doc_id" in patch) && hasLang(rootFor(), langSel.value, f.id)) { toast(dupMsg(langSel.value), 6000); check(); continue; } // 새 자리의 원본에 같은 언어판이 이미 있으면 막는다
      try { await api.libUpdate(f, patch); toast(t("저장했어요"), 1800); await load(); return; } catch (e) { toast(t(e.message), 6000); }
    }
  }

  // 문서 카드 하나: 제목(내 언어판 제목)·언어 배지·내 언어판을 여는 큰 버튼·다른 언어판 칩·올리는 사람용 줄
  function docCard(g) {
    const shown = shownOf(g), own = vLang(shown) === lang();
    const marked = g.versions.some((v) => v.lang != null); // 언어 표시가 있는 서버(library2.sql 이후)인가. 옛 파일은 표시·안내 없이 이전처럼 보인다
    const multi = g.versions.length > 1;
    const others = g.versions.filter((v) => v !== shown);
    const mng = g.versions.filter(canManage);
    const room = LANGS.some(([k]) => !g.versions.some((v) => vLang(v) === k)); // 더할 언어가 남았는가
    const openName = (v) => t("{lang}판 열기", { lang: sayLang(vLang(v)) });
    return h("div", { class: "card lb-doc" },
      h("div", { class: "lb-head" }, h("b", { class: "lb-title" }, `${iconOf(shown)} ${shown.title}`),
        h("span", { class: "badges" }, marked && h("span", { class: "badge" }, LANG_NAME[vLang(shown)]), h("span", { class: "badge info" }, audLabel(shown)))),
      h("div", { class: "muted" }, `${folderLabel(g.root.folder)} · ${kb(shown.size)} · ${shown.uploaded_name} · ${labelMD(dateOf(shown.created_at))}`),
      shown.note && h("div", null, shown.note),
      h("button", { class: "btn ghost lb-open", onclick: () => open(shown) }, multi || (marked && !own) ? openName(shown) : t("열기")), // 내 언어판이 없을 때도 어느 언어판이 열리는지 버튼에 적는다
      marked && !own && h("div", { class: "banner plain lb-miss" }, t("내 언어판은 아직 없어요")), // 번역이 없는 건 경고가 아니라 안내라서 노란색 대신 차분한 바탕
      others.length > 0 && h("div", { class: "lb-langs" }, h("span", { class: "muted" }, t("다른 언어판")),
        others.map((v) => h("button", { class: "chip", "aria-label": openName(v), onclick: () => open(v) }, LANG_NAME[vLang(v)]))),
      h("div", { class: "toprow lb-actions" },
        h("button", { class: "btn ghost slim", onclick: () => open(shown, true) }, t("내려받기")),
        canUpload && room && h("button", { class: "btn ghost slim", onclick: () => upload(g.root) }, t("언어판 추가"))),
      mng.length > 0 && h("div", { class: "lb-manage" }, mng.map((v) => h("div", { class: "lb-mrow" },
        h("span", { class: "lb-mlang" }, multi ? LANG_NAME[vLang(v)] : ""),
        h("button", { class: "linkbtn", onclick: () => edit(v) }, t("수정")),
        h("button", { class: "linkbtn bad-text", onclick: () => remove(v) }, t("삭제"))))));
  }

  // 목록 칸(.lb-list) 안: 불러오는 중 / 실패 / 비었음 / 문서 카드들
  const listBody = (list) => (loading ? [h("p", { class: "muted" }, t("불러오는 중…"))]
    : err ? [h("p", { class: "err" }, t("불러오기 실패: {err} (library.sql 실행 여부 확인)", { err: t(err) }))]
    : !list.length ? [h("p", { class: "muted" }, files.length ? t("찾는 파일이 없어요") : t("아직 올린 파일이 없어요"))]
    : list.map(docCard));

  // listOnly = 검색 입력 때: 검색칸·폴더 줄은 그대로 두고 목록만 바꾼다(한글 입력 중에 칸이 새로 만들어져 글자가 끊기지 않게)
  function draw(listOnly = false) {
    const y = scrollY, barX = root.querySelector(".chips-bar")?.scrollLeft ?? 0; // 같은 화면을 다시 그려도 세로 위치와 폴더 줄을 옆으로 민 위치를 그대로 둔다
    const groups = groupDocs(files);
    const rest = [...new Set(groups.map((g) => g.root.folder))].sort();
    const folders = rest.includes(FOLDER_FIRST) ? [FOLDER_FIRST, ...rest.filter((x) => x !== FOLDER_FIRST)] : rest; // 매뉴얼 폴더를 맨 앞에, 나머지는 기존 순서
    if (folder !== "all" && !folders.includes(folder)) folder = "all"; // 고른 폴더가 비면(마지막 파일을 지움) 전체로
    const key = q.trim().toLowerCase();
    const list = groups.filter((g) => (folder === "all" || g.root.folder === folder) && (!key
      || [shownOf(g).title, ...g.versions.flatMap((v) => [v.title, v.file_name, v.note, v.uploaded_name]), g.root.folder, folderLabel(g.root.folder)].join(" ").toLowerCase().includes(key))); // 보이는 제목이 기준(다른 언어판 이름으로도 찾는다)
    const box = listOnly && root.querySelector(".lb-list");
    if (box) { box.replaceChildren(...listBody(list)); scrollTo(0, y); return; }
    const search = h("input", { class: "inp", type: "search", placeholder: t("검색 (이름·설명·폴더)"), value: q });
    search.oninput = () => { q = search.value; draw(true); };
    root.replaceChildren(h("div", { class: "page" },
      opts.onBack && h("button", { class: "linkbtn back", onclick: opts.onBack }, t("← 목록")),
      h("h1", null, t("📁 서식·자료함")),
      canUpload && h("button", { class: "btn primary", onclick: () => upload() }, t("⬆ 파일 올리기")),
      !canUpload && h("p", { class: "muted" }, t("파일을 열어 보거나 내려받을 수 있어요. 올리기는 관리자만 해요.")),
      h("div", { class: "chips-bar", style: "margin:8px 0" }, [["all", t("전체")], ...folders.map((x) => [x, folderLabel(x)])].map(([k, l]) =>
        h("button", { class: "chip" + (folder === k ? " on" : ""), onclick: () => { folder = k; draw(); } }, l))),
      search,
      h("div", { class: "lb-list" }, listBody(list))));
    scrollTo(0, y);
    const bar = root.querySelector(".chips-bar"); if (bar && barX) bar.scrollLeft = barX;
  }
  draw();
  await load();
}
