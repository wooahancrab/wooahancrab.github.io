// 건의함: 직원은 쓰기만 하고(보낸 뒤에는 다시 못 봄), 읽고 처리하는 건 대표만 한다.
// 사진·파일 첨부(supabase/suggestions-files.sql): 직원이 붙이고, 대표만 본다. 올리기·정리는 api.js(sg*)가, 검사·사진 줄이기·큰 사진 보기는 img.js 가 맡는다.
// 파일 이름은 모두 글자로만 화면에 넣는다(innerHTML 안 씀).
import { api } from "../lib/api.js";
import { h, toast, confirmDialog } from "../lib/ui.js";
import { dateOf, labelMD } from "../lib/kst.js";
import { t } from "../lib/i18n.js";

const CATS = ["업무 개선", "불편·고충", "칭찬·감사", "기타"]; // 값은 그대로 저장하고, 화면에 보일 때만 t()로 감싼다
const MAX_FILES = 5; // 건의 하나에 붙일 수 있는 개수(DB 검사·api.js 와 같게)

// 사진·파일 도우미(img.js)는 첨부를 쓸 때만 불러온다(그 파일에 문제가 있어도 건의 쓰기·읽기는 그대로 동작)
let imgMod = null;
const loadImg = () => (imgMod ??= import("../lib/img.js").catch((e) => { imgMod = null; throw e; }));

// 화면에 보일 이름: 제어문자와 글자 방향을 바꾸는 문자를 지운다
const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "");
const kb = (n) => {
  const v = Number(n) || 0;
  if (v <= 0) return "";
  return v >= 1048576 ? (v / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(v / 1024)) + "KB";
};
const iconOf = (name) => {
  const n = String(name || "").toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n)) return "📊";
  if (/\.(docx?|hwp|hwpx)$/.test(n)) return "📄";
  if (/\.pdf$/.test(n)) return "📕";
  if (/\.pptx?$/.test(n)) return "📙";
  if (/\.(jpe?g|png|gif|webp|heic|heif)$/.test(n)) return "🖼";
  if (/\.zip$/.test(n)) return "🗜";
  if (/\.txt$/.test(n)) return "📃";
  return "📎";
};
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** 직원 화면: 건의 쓰기 */
export function renderSuggest(root) {
  let sent = false, busy = false;
  let picks = []; // 붙이려고 고른 파일 [{ f: File, url: 미리보기 주소, el, x }]
  // 미리보기용 임시 주소(object URL)는 다 읽었거나 빼거나 보낸 뒤에 놓아 준다
  const freePick = (p) => { if (p.url) { try { URL.revokeObjectURL(p.url); } catch { /* ignore */ } p.url = ""; } };
  const clearPicks = () => { picks.forEach(freePick); picks = []; };

  const draw = () => {
    if (sent) return root.replaceChildren(h("div", { class: "page" }, h("h1", null, t("💌 건의함")),
      h("p", null, t("건의가 전달됐어요. 고마워요 🙏")), h("p", { class: "muted" }, t("대표만 읽을 수 있어요.")),
      h("button", { class: "btn ghost", onclick: () => { sent = false; draw(); } }, t("하나 더 쓰기"))));
    const cat = h("select", { class: "inp" }, CATS.map((c) => h("option", { value: c }, t(c))));
    const body = h("textarea", { class: "inp", rows: "7", maxlength: "2000", placeholder: t("회사에 하고 싶은 말을 편하게 적어 주세요. 불편한 점, 개선 아이디어, 고마웠던 일 모두 좋아요.") });
    const anon = h("input", { type: "checkbox" });

    /* ---------- 첨부 ---------- */
    // 카메라·사진첩·파일을 모두 고를 수 있게 image/* 와 사진이 아닌 허용 확장자를 함께 준다(확장자 목록은 img.js 에서 받아 채운다).
    // 사진 확장자(.heic 등)는 일부러 뺐다: image/* 가 이미 사진을 모두 받고, 아이폰 사파리는 image/heic 류를 적으면 사진을 JPEG 로 바꿔 주지 않거나 거꾸로 HEIC 로 바꾸는 경우가 있다
    const fileIn = h("input", { type: "file", multiple: true, style: "display:none", tabindex: "-1", "aria-hidden": "true" });
    loadImg().then((m) => fileIn.setAttribute("accept", "image/*," + [...m.ALLOWED_EXT].filter((e) => !m.isImage({ name: "x." + e })).map((e) => "." + e).join(","))).catch(() => { /* 고를 때 다시 알린다 */ });
    const attBtn = h("button", { type: "button", class: "btn ghost", onclick: () => {
      if (busy) return;
      if (picks.length >= MAX_FILES) return toast(t("첨부는 최대 {max}개까지 붙일 수 있어요", { max: MAX_FILES }));
      fileIn.click();
    } }, t("📎 사진·파일 붙이기"));
    const attInfo = h("div", { class: "sg-attinfo" });
    const attList = h("div", { class: "sg-picks" });
    const attStat = h("div", { class: "muted", role: "status", "aria-live": "polite" });
    const attBox = h("div", { class: "sg-att" }, attBtn, attInfo, attList, attStat, fileIn);

    function makePick(f, m) {
      const p = { f, url: "", el: null, x: null };
      const nm = cleanName(f.name) || t("파일");
      const thumb = h("div", { class: "sg-pth" });
      if (m.isImage(f)) { try { p.url = URL.createObjectURL(f); } catch { p.url = ""; } }
      if (p.url) {
        const im = h("img", { class: "sg-pimg", alt: "", decoding: "async", draggable: "false" });
        im.onload = () => freePick(p); // 그림을 다 읽었으면 주소는 바로 놓아 준다(그림은 그대로 남는다)
        im.onerror = () => { freePick(p); thumb.replaceChildren(h("span", { class: "sg-pico", "aria-hidden": "true" }, "🖼")); }; // 못 읽는 형식(HEIC 등)은 그림 표시만
        im.src = p.url;
        thumb.append(im);
      } else thumb.append(h("span", { class: "sg-pico", "aria-hidden": "true" }, iconOf(f.name)));
      p.x = h("button", { type: "button", class: "sg-x", "aria-label": t("{nm} 빼기", { nm }), onclick: () => removePick(p) }, "✕");
      p.el = h("div", { class: "sg-pick" }, thumb,
        h("div", { class: "sg-pmain" }, h("div", { class: "sg-pname" }, nm), h("div", { class: "muted" }, kb(f.size))), p.x);
      return p;
    }
    function removePick(p) {
      if (busy) return;
      freePick(p);
      picks = picks.filter((x) => x !== p);
      paintPicks();
    }
    function paintPicks() {
      attInfo.replaceChildren(
        h("b", { class: "sg-count" }, t("첨부 {n}/{max}", { n: picks.length, max: MAX_FILES })),
        h("span", { class: "muted" }, t("상황을 보여 주는 사진·파일을 붙여 주세요. 하나에 20MB까지, 대표만 볼 수 있어요.")));
      attList.replaceChildren(...picks.map((p) => p.el));
      attBtn.disabled = busy;
      for (const p of picks) p.x.disabled = busy;
    }
    fileIn.addEventListener("change", async () => {
      const list = Array.from(fileIn.files || []);
      fileIn.value = ""; // 같은 파일을 다시 골라도 반응하게
      if (!list.length || busy) return;
      let m;
      try { m = await loadImg(); } catch { return toast(t("첨부 기능을 불러오지 못했어요. 첨부 없이 보내거나 앱을 다시 열어 주세요"), 5000); }
      const errs = [];
      for (const f of list) {
        if (picks.length >= MAX_FILES) { errs.push(t("첨부는 최대 {max}개까지 붙일 수 있어요", { max: MAX_FILES })); break; }
        const bad = m.checkFile(f);
        if (bad) { errs.push(bad); continue; }
        if (picks.some((x) => sameFile(x.f, f))) continue; // 같은 파일을 또 고른 것은 건너뜀
        picks.push(makePick(f, m));
      }
      paintPicks();
      if (errs.length) toast(errs.slice(0, 2).join(" / ") + (errs.length > 2 ? " " + t("외 {n}건", { n: errs.length - 2 }) : ""), 5000);
    });

    /* ---------- 보내기 ---------- */
    const send = h("button", { class: "btn primary", disabled: busy, onclick: submit }, t("보내기"));
    // 올리는 동안 버튼을 잠가 두 번 눌러 중복으로 보내지 않게 한다
    function lock(on) {
      busy = on;
      send.disabled = on;
      send.textContent = on && picks.length ? t("올리는 중…") : t("보내기");
      if (!on) attStat.textContent = "";
      paintPicks();
    }
    async function submit() {
      if (busy) return;
      if (!body.value.trim()) return toast(t("내용을 적어 주세요"));
      lock(true);
      let ok = false;
      try {
        await api.sgSend({ category: cat.value, body: body.value.trim(), anon: anon.checked, attach: picks.map((p) => p.f) }, {
          onProgress: (s) => { attStat.textContent = s.phase === "save" ? t("보내는 중…") : t("({i}/{n}) 올리는 중…", { i: s.i, n: s.n }); },
        });
        ok = true;
      } catch (e) { toast(t(e.message), 5000); }
      if (ok) { sent = true; clearPicks(); busy = false; draw(); } else lock(false); // 실패하면 쓴 글과 고른 파일을 그대로 두어 다시 보낼 수 있게 한다
    }

    root.replaceChildren(h("div", { class: "page" }, h("h1", null, t("💌 건의함")),
      h("p", { class: "muted" }, t("쓴 내용은 대표만 읽을 수 있어요. 다른 직원이나 관리자는 볼 수 없어요.")),
      cat, body,
      attBox,
      h("label", { style: "display:flex;gap:10px;align-items:center;min-height:44px;margin:8px 0" }, anon, t("이름을 숨기고 보내기")),
      h("p", { class: "muted" }, t("이름 숨김을 고르면 대표 화면에 이름이 보이지 않아요. (시스템 기록에는 남아요)")),
      send));
    paintPicks();
  };
  draw();
}

/** 대표 화면: 받은 건의 읽기·처리 */
export async function renderSuggestAdmin(root, onBack) {
  let list = [], err = "", filter = "새글";
  async function load() { try { list = await api.sgList(); err = ""; } catch (e) { err = e.message; } draw(); }
  async function setStatus(r, status) { try { await api.sgSet(r.id, { status }); await load(); } catch (e) { toast(t(e.message), 4000); } }
  async function del(r) {
    const n = attOf(r).length;
    if (!(await confirmDialog(t("이 건의를 지울까요?"), [r.body.slice(0, 40), n > 0 && t("첨부 {n}개도 함께 지워지고 되돌릴 수 없어요", { n })].filter(Boolean), t("취소"), t("지우기")))) return;
    try { await api.sgDelete(r.id); await load(); } catch (e) { toast(t(e.message), 4000); }
  }

  /* ---------- 첨부 보기 ---------- */
  // 건의 행의 files 는 직원이 쓴 값이라 모양을 확인하고, 이름은 글자로만 쓴다
  const attOf = (r) => (Array.isArray(r.files) ? r.files : []).filter((f) => f && typeof f.path === "string" && f.path && typeof f.name === "string").slice(0, MAX_FILES);
  const isPhoto = (f) => /\.(jpe?g|png|gif|webp)$/i.test(f.path); // 브라우저가 바로 그릴 수 있는 사진만 썸네일. HEIC 등은 파일 칩으로 내려받기

  async function openPhotos(rows, i) {
    try {
      const m = await loadImg();
      m.openLightbox(rows, i, (row, fresh) => api.sgUrl(row.path, { fresh }));
    } catch { toast(t("사진을 불러오지 못했어요"), 4000); }
  }
  async function download(f, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const nm = cleanName(f.name);
      const url = await api.sgUrl(f.path, { download: nm || true });
      const a = h("a", { href: url, download: nm, rel: "noopener" });
      document.body.append(a); a.click(); a.remove();
    } catch { toast(t("파일을 내려받지 못했어요"), 4000); }
    btn.disabled = false;
  }
  function thumbBtn(f, i, rows, imgs) {
    const nm = cleanName(f.name) || t("사진");
    const im = h("img", { class: "sg-img", alt: "", loading: "lazy", decoding: "async", draggable: "false" });
    im.dataset.p = f.path;
    imgs.push(im);
    const b = h("button", { type: "button", class: "sg-ph", "aria-label": t("{nm} 크게 보기", { nm }), onclick: () => openPhotos(rows, i) }, im);
    im.addEventListener("error", () => b.classList.add("broken"));
    return b;
  }
  function chipBtn(f) {
    const nm = cleanName(f.name) || t("파일");
    const b = h("button", { type: "button", class: "sg-chip", "aria-label": t("{nm} 내려받기", { nm }), onclick: () => download(f, b) },
      h("span", { class: "sg-cico", "aria-hidden": "true" }, iconOf(nm)), h("span", { class: "sg-cname" }, nm), kb(f.size) && h("span", { class: "muted sg-csize" }, kb(f.size)));
    return b;
  }
  // 한 건의의 첨부 영역. 첨부가 없으면 null (그 카드는 예전과 똑같이 보인다)
  function filesBlock(r, imgs) {
    const fs = attOf(r);
    if (!fs.length) return null;
    const photos = fs.filter(isPhoto), docs = fs.filter((f) => !isPhoto(f));
    const rows = photos.map((f) => ({ path: f.path, file_name: cleanName(f.name), mime: typeof f.type === "string" ? f.type : "" })); // 큰 사진 보기(img.js openLightbox)용 행
    return h("div", { class: "sg-files", role: "group", "aria-label": t("첨부") },
      photos.length > 0 && h("div", { class: "sg-grid" }, photos.map((f, i) => thumbBtn(f, i, rows, imgs))),
      docs.length > 0 && h("div", { class: "sg-chips" }, docs.map(chipBtn)));
  }
  // 썸네일 주소는 그린 뒤에 한 번에 받는다(주소가 없거나 못 읽으면 그림 표시만)
  async function fillThumbs(imgs) {
    if (!imgs.length) return;
    let urls = null;
    try { urls = await api.sgUrls(imgs.map((im) => im.dataset.p)); } catch { urls = null; }
    for (const im of imgs) {
      const u = urls && urls.get(im.dataset.p);
      if (u) im.src = u; else im.dispatchEvent(new Event("error"));
    }
  }

  function draw() {
    const y = scrollY;
    const imgs = [];
    const shown = list.filter((r) => filter === "all" || r.status === filter);
    const count = (s) => list.filter((r) => r.status === s).length;
    root.replaceChildren(h("div", { class: "page" },
      onBack && h("button", { class: "linkbtn back", onclick: onBack }, t("← 목록")),
      h("h1", null, t("💌 건의함")),
      err && h("p", { class: "err" }, t("불러오기 실패: {err} (suggestions.sql 실행 여부 확인)", { err: t(err) })),
      h("div", { class: "tabs" }, [["새글", t("새 건의 {n}", { n: count("새글") })], ["확인", t("확인 {n}", { n: count("확인") })], ["처리", t("처리 {n}", { n: count("처리") })], ["all", t("전체")]].map(([k, l]) =>
        h("button", { class: "tab" + (filter === k ? " on" : ""), onclick: () => { filter = k; draw(); } }, l))),
      !shown.length ? h("p", { class: "muted" }, t("해당하는 건의가 없어요")) : shown.map((r) => h("div", { class: "card", style: "margin:8px 0;padding:12px" },
        h("div", { style: "display:flex;justify-content:space-between;gap:8px" },
          h("b", null, t(r.category)), h("span", { class: "muted" }, labelMD(dateOf(r.created_at)))),
        h("div", { class: "muted" }, `${r.stores?.display_name ?? r.stores?.name ?? ""} · ${r.anon ? t("이름 숨김") : r.author_name || t("(이름 없음)")}`),
        h("div", { style: "white-space:pre-wrap;margin:8px 0" }, r.body),
        filesBlock(r, imgs),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
          r.status !== "확인" && r.status !== "처리" && h("button", { class: "btn ghost slim", onclick: () => setStatus(r, "확인") }, t("읽었어요")),
          r.status !== "처리" && h("button", { class: "btn ghost slim", onclick: () => setStatus(r, "처리") }, t("처리 완료")),
          r.status !== "새글" && h("button", { class: "linkbtn", onclick: () => setStatus(r, "새글") }, t("새글로")),
          h("button", { class: "linkbtn", onclick: () => del(r) }, t("삭제")))))));
    scrollTo(0, y);
    fillThumbs(imgs);
  }
  draw();
  await load();
}
