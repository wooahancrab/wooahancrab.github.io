// 서식·자료함: 권한이 있는 사람이 앱에서 바로 파일을 올리고, 공개 범위 안의 직원이 열어 보거나 내려받는다.
// 파일 본체는 Supabase Storage(비공개) — 열 때마다 60초짜리 임시 주소를 받아서 연다(library.sql).
import { api } from "../lib/api.js";
import { h, toast, modal, confirmDialog } from "../lib/ui.js";
import { dateOf, labelMD } from "../lib/kst.js";

const AUD = { all: "전 직원", store: "사업장", admin: "관리자" };
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB");
const iconOf = (f) => {
  const n = (f.file_name || "").toLowerCase();
  if (/\.(xlsx?|csv)$/.test(n)) return "📊"; if (/\.(docx?|hwp|hwpx)$/.test(n)) return "📄"; if (/\.pdf$/.test(n)) return "📕";
  if (/\.(pptx?)$/.test(n)) return "📙"; if (/\.(jpe?g|png|gif|webp|heic)$/.test(n)) return "🖼"; if (/\.(zip|7z)$/.test(n)) return "🗜"; return "📎";
};

export async function renderLibrary(root, opts = {}) {
  const prof = await api.getProfile();
  const top = prof.role === "owner" || prof.role === "deputy";
  const canUpload = top || !!prof.can_settle;
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
    } catch (e) { w?.close(); toast(e.message, 5000); }
  }
  async function remove(f) {
    if (!(await confirmDialog("파일을 지울까요?", [f.title, "지우면 되돌릴 수 없어요"], "취소", "지우기"))) return;
    try { await api.libDelete(f); toast("지웠어요", 1800); await load(); } catch (e) { toast(e.message, 5000); }
  }

  async function upload() {
    if (top && !stores.length) stores = await api.listStores().catch(() => []);
    const file = h("input", { type: "file", class: "inp" });
    const title = h("input", { class: "inp", placeholder: "이름 (예: 연차 신청서)", maxlength: "60" });
    const folderIn = h("input", { class: "inp", placeholder: "폴더 (예: 서식, 계약, 인사)", maxlength: "20", list: "lib-folders" });
    const dl = h("datalist", { id: "lib-folders" }, [...new Set(files.map((f) => f.folder))].map((x) => h("option", { value: x })));
    folderIn.value = folder !== "all" ? folder : "서식";
    const note = h("input", { class: "inp", placeholder: "설명 (선택)", maxlength: "100" });
    const aud = h("select", { class: "inp" }, [["all", "전 직원이 볼 수 있어요"], ["store", "선택한 사업장 직원만"], ["admin", "대표·부대표·정산 권한자만"]].map(([v, l]) => h("option", { value: v }, l)));
    const st = h("select", { class: "inp" }, stores.map((s) => h("option", { value: s.id }, s.display_name ?? s.name)));
    const stRow = h("div", { style: "display:none" }, st);
    aud.onchange = () => { stRow.style.display = aud.value === "store" && top ? "" : "none"; };
    file.onchange = () => { if (!title.value && file.files[0]) title.value = file.files[0].name.replace(/\.[^.]+$/, ""); };
    const lbl = (t) => h("span", { class: "muted", style: "font-size:12px" }, t);
    for (;;) {
      if (!(await modal("파일 올리기", h("div", { class: "stack" }, lbl("파일 (20MB까지)"), file, lbl("이름"), title, lbl("폴더"), folderIn, dl, lbl("설명"), note, lbl("보는 사람"), aud, stRow), "올리기", "취소"))) return;
      const f = file.files[0];
      if (!f) { toast("파일을 골라 주세요"); continue; }
      if (!title.value.trim() || !folderIn.value.trim()) { toast("이름과 폴더를 넣어 주세요"); continue; }
      const store_id = aud.value === "store" ? (top ? st.value : prof.store_id) : null;
      if (aud.value === "store" && !store_id) { toast("사업장을 골라 주세요"); continue; }
      toast("올리는 중…", 20000);
      try {
        await api.libUpload(f, { title: title.value.trim(), folder: folderIn.value.trim(), note: note.value.trim(), audience: aud.value, store_id });
        toast("올렸어요", 2000); await load(); return;
      } catch (e) { toast(e.message, 6000); }
    }
  }

  function draw() {
    const y = scrollY;
    const folders = [...new Set(files.map((f) => f.folder))].sort();
    const key = q.trim().toLowerCase();
    const list = files.filter((f) => (folder === "all" || f.folder === folder) && (!key || [f.title, f.file_name, f.note, f.folder, f.uploaded_name].join(" ").toLowerCase().includes(key)));
    const search = h("input", { class: "inp", type: "search", placeholder: "검색 (이름·설명·폴더)", value: q });
    search.oninput = () => { q = search.value; const pos = search.selectionStart; draw(); const s = root.querySelector('input[type="search"]'); s?.focus(); s?.setSelectionRange(pos, pos); };
    root.replaceChildren(h("div", { class: "page" },
      opts.onBack && h("button", { class: "linkbtn back", onclick: opts.onBack }, "← 목록"),
      h("h1", null, "📁 서식·자료함"),
      canUpload && h("button", { class: "btn primary", onclick: upload }, "⬆ 파일 올리기"),
      !canUpload && h("p", { class: "muted", style: "font-size:12px" }, "파일을 열어 보거나 내려받을 수 있어요. 올리기는 관리자만 해요."),
      h("div", { class: "chips-bar", style: "margin:8px 0" }, [["all", "전체"], ...folders.map((x) => [x, x])].map(([k, l]) =>
        h("button", { class: "chip" + (folder === k ? " on" : ""), onclick: () => { folder = k; draw(); } }, l))),
      search,
      loading ? h("p", { class: "muted" }, "불러오는 중…")
        : err ? h("p", { class: "err" }, "불러오기 실패: " + err + " (library.sql 실행 여부 확인)")
        : !list.length ? h("p", { class: "muted" }, files.length ? "찾는 파일이 없어요" : "아직 올린 파일이 없어요")
        : list.map((f) => h("div", { class: "card", style: "margin:8px 0;padding:12px;border:1px solid #ddd;border-radius:12px" },
          h("div", { style: "display:flex;justify-content:space-between;gap:8px" }, h("b", null, `${iconOf(f)} ${f.title}`),
            h("span", { class: "badge info" }, f.audience === "store" ? (f.stores?.display_name ?? f.stores?.name ?? AUD.store) : AUD[f.audience])),
          h("div", { class: "muted", style: "font-size:12px" }, `${f.folder} · ${kb(f.size)} · ${f.uploaded_name} · ${labelMD(dateOf(f.created_at))}`),
          f.note && h("div", { style: "margin-top:4px" }, f.note),
          h("div", { style: "display:flex;gap:10px;margin-top:8px;flex-wrap:wrap" },
            h("button", { class: "btn ghost slim", onclick: () => open(f) }, "열기"),
            h("button", { class: "btn ghost slim", onclick: () => open(f, true) }, "내려받기"),
            (f.uploaded_by === prof.user_id || prof.role === "owner") && h("button", { class: "linkbtn", onclick: () => remove(f) }, "삭제"))))));
    scrollTo(0, y);
  }
  draw();
  await load();
}
