// 프로젝트 아카이브 호출 모음 (supabase/projects.sql). 화면은 api.pj() 로 이 객체를 받아 쓴다.
// 읽고 쓰기는 앱이 표·보관함에 직접 하고, 누가 볼 수 있는지는 DB 접근 규칙(RLS)이 막는다.
// 모든 메서드는 실패하면 한국어 메시지의 Error 를 던진다. 화면 코드는 여기에 없다.
import { checkFile, isImage, resizeImage, signedUrls } from "./img.js";

const BUCKET = "projects";
const NOT_READY = "프로젝트 기능이 아직 준비되지 않았어요 (projects.sql 실행이 필요해요)";
const NO_PERM = "권한이 없어요";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 보관함(projects)이 받는 파일 종류(supabase/projects.sql 6번의 allowed_mime_types 와 같게 유지).
// 브라우저가 알려 주는 종류가 이 밖이면(한글·압축 프로그램이 따로 등록한 값 등) octet-stream 으로 올린다
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp", "application/vnd.hancom.hwpx", "application/hwp+zip",
  "text/plain", "text/csv", "application/csv",
  "application/zip", "application/x-zip-compressed",
  "application/octet-stream",
]);
// 같은 종류의 옛 이름
const MIME_ALIAS = { "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };

// 우리가 직접 만든 한국어 오류. mapErr 를 다시 거쳐도 그대로 나간다
function kerr(msg, extra) {
  return Object.assign(new Error(msg), { pjKorean: true }, extra);
}

// Supabase 오류(Postgrest·Storage)·네트워크 오류 → 한국어 Error
function mapErr(e, fallback = "처리하지 못했어요") {
  if (e && e.pjKorean) return e;
  const code = String(e?.code ?? "");
  const status = String(e?.status ?? e?.statusCode ?? "");
  const raw = String(e?.message ?? e ?? "");
  let msg;
  if (/[가-힣]/.test(raw)) msg = raw; // 서버 함수가 한국어로 준 안내문(예: 고정은 5개까지)은 그대로
  else if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || status === "404"
    || /could not find the (table|function)|relation .* does not exist|function .* does not exist|bucket not found/i.test(raw)) msg = NOT_READY;
  else if (code === "42501" || status === "403" || /permission denied|row-level security|not authorized|unauthorized|forbidden/i.test(raw)) msg = NO_PERM;
  else if (status === "401" || /jwt expired|invalid jwt/i.test(raw)) msg = "로그인이 만료됐어요. 다시 로그인해 주세요";
  else if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) msg = "인터넷 연결을 확인하고 다시 시도해 주세요";
  else msg = `${fallback} (${raw.slice(0, 140)})`;
  return kerr(msg, { code, cause: e });
}

// 검색어에서 PostgREST 필터·LIKE 를 깨는 글자를 지운다
const cleanQ = (q) => String(q ?? "").replace(/[,()%*_"\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 50);

const extOf = (name) => (String(name ?? "").match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
const clampLimit = (n, def) => Math.min(Math.max(parseInt(n, 10) || def, 1), 100);

// 제목+본문의 #태그 → 소문자, 중복 없이 최대 10개, 각 20자 이하. 주소 안의 #(앞이 / 등)와 숫자만 있는 것은 제외
function extractTags(text) {
  const out = [];
  for (const m of String(text).matchAll(/(^|[\s(\[{"'“‘>])#([\p{L}\p{N}_]+)/gu)) {
    const t = m[2].toLowerCase();
    if (t.length > 20 || !/\p{L}/u.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

export function makePj({ sb, me }) {
  // 로그인한 사람 id: 로컬 세션에서 바로 읽어서 항상 정확하다(경로 규칙이 이 id 에 묶여 있음)
  async function myId() {
    const { data } = await (await sb()).auth.getSession();
    const id = data?.session?.user?.id;
    if (!id) throw kerr("다시 로그인해 주세요");
    return id;
  }

  let prof = null, profAt = 0;
  async function profile() {
    if (prof && Date.now() - profAt < 30000) return prof;
    const p = await me();
    if (!p) throw kerr("다시 로그인해 주세요");
    prof = p; profAt = Date.now();
    return p;
  }

  const isTopRole = (p) => p.role === "owner" || p.role === "deputy";

  async function isAdmin(pid) {
    if (isTopRole(await profile())) return true;
    return (await myMembership(pid))?.role === "admin";
  }

  /* ---------- 프로젝트 ---------- */
  async function overview() {
    const { data, error } = await (await sb()).rpc("pj_overview");
    if (error) throw error;
    return data ?? [];
  }

  async function createProject({ name, descr, color, ai_ok, member_ids } = {}) {
    const nm = String(name ?? "").trim();
    const ds = String(descr ?? "").trim();
    if (!nm) throw kerr("프로젝트 이름을 넣어 주세요");
    if (nm.length > 60) throw kerr("이름은 60자까지 쓸 수 있어요");
    if (ds.length > 500) throw kerr("설명은 500자까지 쓸 수 있어요");
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw kerr("색 형식이 맞지 않아요");
    const c = await sb(), uid = await myId();
    const { data, error } = await c.from("pj_projects")
      .insert({ name: nm, descr: ds, color: color || "#3b82f6", ai_ok: ai_ok !== false, created_by: uid })
      .select("id").single();
    if (error) throw error;
    const id = data.id;
    // 만든 사람은 트리거가 관리자 참여자로 넣어 준다. 나머지 참여자만 추가
    const ids = [...new Set((member_ids ?? []).filter((x) => typeof x === "string" && UUID_RE.test(x) && x !== uid))];
    if (ids.length) {
      const { error: e2 } = await c.from("pj_members").insert(ids.map((user_id) => ({ project_id: id, user_id, role: "member" })));
      if (e2) throw kerr(`프로젝트는 만들었지만 참여자를 추가하지 못했어요 (${mapErr(e2).message})`, { projectId: id });
    }
    return id;
  }

  async function updateProject(id, patch = {}) {
    const clean = {};
    if (patch.name !== undefined) {
      const nm = String(patch.name).trim();
      if (!nm) throw kerr("프로젝트 이름을 넣어 주세요");
      if (nm.length > 60) throw kerr("이름은 60자까지 쓸 수 있어요");
      clean.name = nm;
    }
    if (patch.descr !== undefined) {
      const ds = String(patch.descr).trim();
      if (ds.length > 500) throw kerr("설명은 500자까지 쓸 수 있어요");
      clean.descr = ds;
    }
    if (patch.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(patch.color))) throw kerr("색 형식이 맞지 않아요");
      clean.color = patch.color;
    }
    if (patch.status !== undefined) {
      if (patch.status !== "active" && patch.status !== "archived") throw kerr("상태 값이 맞지 않아요");
      clean.status = patch.status;
    }
    if (patch.ai_ok !== undefined) clean.ai_ok = !!patch.ai_ok;
    if (!Object.keys(clean).length) return null;
    const { data, error } = await (await sb()).from("pj_projects").update(clean).eq("id", id).select("*");
    if (error) throw error;
    if (!data?.length) throw kerr(NO_PERM);
    return data[0];
  }

  // 보관함 파일(원본·작은 판)부터 지우고, 하나라도 실패하면 멈춘다. 그다음 프로젝트 행(글·댓글·참여자는 같이 삭제됨)
  async function deleteProject(id) {
    // 대표만 지울 수 있다. 부대표가 눌렀을 때 파일만 지워지고 행은 남는 사고를 막으려고 먼저 확인
    if ((await profile()).role !== "owner") throw kerr("프로젝트 삭제는 대표님만 할 수 있어요");
    const c = await sb();
    const paths = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await c.from("pj_files").select("path,thumb_path").eq("project_id", id).order("id").range(from, from + 999);
      if (error) throw error;
      for (const f of data ?? []) paths.push(f.path, f.thumb_path);
      if ((data?.length ?? 0) < 1000) break;
    }
    await removeObjects(paths);
    const { data, error } = await c.from("pj_projects").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) throw kerr(NO_PERM);
  }

  // 보관함 파일 지우기. 실패하면 던져서 호출한 쪽이 멈추게 한다
  async function removeObjects(paths) {
    const list = [...new Set((paths ?? []).filter(Boolean))];
    if (!list.length) return;
    const c = await sb();
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100);
      const { data, error } = await c.storage.from(BUCKET).remove(batch);
      if (error) throw kerr(`보관함의 파일을 지우지 못해 중단했어요 (${mapErr(error).message})`);
      // 지울 권한이 없는 파일은 오류 없이 결과에서 빠진다. 결과가 모자랄 때만, 아직 남은 파일이 있는지 확인한다
      // (이미 없는 파일도 결과에서 빠지므로 개수만 비교해 막으면 재시도가 안 된다)
      if ((data?.length ?? 0) < batch.length) {
        const { data: left, error: e2 } = await c.storage.from(BUCKET).createSignedUrls(batch, 10);
        if (e2) throw kerr(`보관함의 파일이 지워졌는지 확인하지 못해 중단했어요 (${mapErr(e2).message})`);
        const n = (left ?? []).filter((x) => x && !x.error).length;
        if (n) throw kerr(`보관함의 파일 ${n}개를 지우지 못해 중단했어요 (권한)`);
      }
    }
  }

  /* ---------- 참여자 ---------- */
  async function join(pid) {
    const uid = await myId();
    const { error } = await (await sb()).from("pj_members").insert({ project_id: pid, user_id: uid, role: "member" });
    if (error && error.code !== "23505") throw error; // 이미 참여 중이면 성공으로 본다
  }

  async function leave(pid) {
    const uid = await myId();
    const { error } = await (await sb()).from("pj_members").delete().eq("project_id", pid).eq("user_id", uid);
    if (error) throw error;
  }

  async function myMembership(pid) {
    const uid = await myId();
    const { data, error } = await (await sb()).from("pj_members").select("role,last_read_at,muted").eq("project_id", pid).eq("user_id", uid).maybeSingle();
    if (error) throw error;
    return data ?? null;
  }

  async function members(pid) {
    const { data, error } = await (await sb()).from("pj_members").select("user_id,user_name,job_title,role,muted,created_at").eq("project_id", pid).order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  // 이미 참여 중인 사람은 건너뛰고, 새로 넣은 사람 수를 돌려준다
  async function addMembers(pid, userIds) {
    const want = [...new Set((userIds ?? []).filter((x) => typeof x === "string" && UUID_RE.test(x)))];
    if (!want.length) return 0;
    const c = await sb();
    const have = new Set((await members(pid)).map((m) => m.user_id));
    const fresh = want.filter((x) => !have.has(x));
    if (!fresh.length) return 0;
    const { error } = await c.from("pj_members").insert(fresh.map((user_id) => ({ project_id: pid, user_id, role: "member" })));
    if (error) throw error;
    return fresh.length;
  }

  async function removeMember(pid, userId) {
    const { data, error } = await (await sb()).from("pj_members").delete().eq("project_id", pid).eq("user_id", userId).select("user_id");
    if (error) throw error;
    if (!data?.length) throw kerr("권한이 없거나 이미 나간 참여자예요");
  }

  async function setRole(pid, userId, role) {
    if (role !== "admin" && role !== "member") throw kerr("역할 값이 맞지 않아요");
    const { error } = await (await sb()).rpc("pj_set_role", { pid, uid: userId, new_role: role });
    if (error) throw error;
  }

  async function people() {
    const { data, error } = await (await sb()).rpc("pj_people");
    if (error) throw error;
    return data ?? [];
  }

  /* ---------- 글 ---------- */
  // 글 행들에 댓글 수(comment_count)와 첨부(files)를 붙인다. 첨부는 글 id 모음으로 한 번에 조회
  async function hydrate(rows) {
    const byPost = new Map();
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      const { data, error } = await (await sb()).from("pj_files").select("*").in("post_id", ids).order("created_at", { ascending: true });
      if (error) throw error;
      for (const f of data ?? []) {
        if (!byPost.has(f.post_id)) byPost.set(f.post_id, []);
        byPost.get(f.post_id).push(f);
      }
    }
    return rows.map((r) => {
      const { pj_comments, ...rest } = r;
      const cc = Array.isArray(pj_comments) ? pj_comments[0]?.count : pj_comments?.count;
      return { ...rest, comment_count: Number(cc) || 0, files: byPost.get(r.id) ?? [] };
    });
  }

  // before: 직전 목록 마지막 글의 created_at. limit+1 개를 받아 hasMore 를 가린다
  async function posts(pid, { before, limit = 20, q, tag, mine } = {}) {
    const lim = clampLimit(limit, 20);
    let qb = (await sb()).from("pj_posts").select("*, pj_comments(count)").eq("project_id", pid);
    if (before) qb = qb.lt("created_at", before);
    const key = cleanQ(q);
    if (key) qb = qb.or(`title.ilike.%${key}%,body.ilike.%${key}%`);
    if (tag) qb = qb.contains("tags", [String(tag).trim()]);
    if (mine) qb = qb.eq("author_id", await myId());
    const { data, error } = await qb.order("created_at", { ascending: false }).limit(lim + 1);
    if (error) throw error;
    const all = data ?? [];
    return { rows: await hydrate(all.slice(0, lim)), hasMore: all.length > lim };
  }

  async function pinnedPosts(pid) {
    const { data, error } = await (await sb()).from("pj_posts").select("*, pj_comments(count)").eq("project_id", pid).eq("pinned", true)
      .order("pinned_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(5);
    if (error) throw error;
    return hydrate(data ?? []);
  }

  async function tags(pid) {
    const { data, error } = await (await sb()).rpc("pj_tags", { pid });
    if (error) throw error;
    return (data ?? []).slice(0, 30);
  }

  // id 가 있으면 수정(글쓴이 본인만), 없으면 새 글. 고정(pinned)은 직접 못 쓰고 pj_pin 으로만 바뀐다.
  // 글 저장은 성공했는데 고정만 실패하면 글은 남기고 결과 행에 pin_error 를 달아 돌려준다.
  async function savePost(pid, { id, title, body, links, pinned } = {}) {
    const t = String(title ?? "").trim();
    const b = String(body ?? "").trim();
    if (!t && !b) throw kerr("제목이나 내용을 입력해 주세요");
    if (t.length > 100) throw kerr("제목은 100자까지 쓸 수 있어요");
    if (b.length > 10000) throw kerr("내용은 1만 자까지 쓸 수 있어요");
    const lk = (Array.isArray(links) ? links.join("\n") : String(links ?? "")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join("\n");
    if (lk.length > 2000) throw kerr("링크·경로는 2000자까지 쓸 수 있어요");
    const fields = { title: t, body: b, tags: extractTags(t + "\n" + b), links: lk };
    const c = await sb();
    let saved;
    if (id) {
      const { data, error } = await c.from("pj_posts").update(fields).eq("id", id).select("*");
      if (error) throw error;
      if (!data?.length) throw kerr(NO_PERM);
      saved = data[0];
    } else {
      const { data, error } = await c.from("pj_posts").insert({ project_id: pid, kind: "post", ...fields }).select("*").single();
      if (error) throw error;
      saved = data;
    }
    if (pinned !== undefined && !!pinned !== !!saved.pinned) {
      try { await pin(saved.id, !!pinned); saved = { ...saved, pinned: !!pinned }; } catch (e) { saved = { ...saved, pin_error: mapErr(e, "상단고정을 바꾸지 못했어요").message }; }
    }
    return saved;
  }

  // 보관함 파일(원본·작은 판)부터 지우고 실패하면 중단 → 첨부 행 → 글 행(댓글은 같이 삭제됨)
  async function deletePost(post) {
    const uid = await myId();
    if (post.author_id !== uid && !(await isAdmin(post.project_id))) throw kerr(NO_PERM);
    const c = await sb();
    const { data: fs, error: e1 } = await c.from("pj_files").select("id,path,thumb_path").eq("post_id", post.id);
    if (e1) throw e1;
    const paths = [];
    for (const f of fs ?? []) paths.push(f.path, f.thumb_path);
    await removeObjects(paths);
    if (fs?.length) {
      const { error: e2 } = await c.from("pj_files").delete().eq("post_id", post.id);
      if (e2) throw e2;
    }
    const { data, error } = await c.from("pj_posts").delete().eq("id", post.id).select("id");
    if (error) throw error;
    if (!data?.length) throw kerr(NO_PERM);
  }

  async function pin(postId, on) {
    const { error } = await (await sb()).rpc("pj_pin", { post_id: postId, on: !!on });
    if (error) throw error;
  }

  /* ---------- 댓글 ---------- */
  async function comments(postId) {
    const { data, error } = await (await sb()).from("pj_comments").select("*").eq("post_id", postId).order("created_at", { ascending: true }).limit(500);
    if (error) throw error;
    return data ?? [];
  }

  async function addComment(pid, postId, body) {
    const b = String(body ?? "").trim();
    if (!b) throw kerr("댓글 내용을 넣어 주세요");
    if (b.length > 2000) throw kerr("댓글은 2000자까지 쓸 수 있어요");
    const { data, error } = await (await sb()).from("pj_comments").insert({ post_id: postId, project_id: pid, body: b }).select("*").single();
    if (error) throw error;
    return data;
  }

  async function deleteComment(id) {
    const { data, error } = await (await sb()).from("pj_comments").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) throw kerr(NO_PERM);
  }

  /* ---------- 파일 ---------- */
  // 사진은 폰에서 줄여(큰 판 + 작은 판) 올리고, 줄일 수 없는 형식(HEIC 등)은 일반 파일로 올린다.
  // 중간에 실패하면 이미 올린 보관함 파일을 치운다. 호출하는 쪽은 한 장씩 차례로 부른다.
  async function uploadFile(pid, postId, file) {
    const bad = checkFile(file);
    if (bad) throw kerr(bad);
    const c = await sb(), uid = await myId();
    // 남의 글에는 첨부할 수 없다(글 수정은 글쓴이만). 올리기 전에 먼저 확인해서 헛수고를 막는다
    if (postId) {
      const { data: post, error: pe } = await c.from("pj_posts").select("project_id,author_id").eq("id", postId).maybeSingle();
      if (pe) throw pe;
      if (!post || post.project_id !== pid || post.author_id !== uid) throw kerr(NO_PERM);
    }
    let kind = "file", big = file, thumb = null, width = null, height = null;
    let ext = extOf(file.name) || "bin";
    let fileName = String(file.name ?? "").replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "파일";
    let mime = "application/octet-stream";
    if (isImage(file)) {
      let r = null;
      try { r = await resizeImage(file); } catch { r = null; }
      if (r) {
        kind = "image"; big = r.big; thumb = r.thumb; width = r.width; height = r.height;
        ext = "jpg"; mime = "image/jpeg";
        fileName = fileName.replace(/\.[^./\\]+$/, "") + ".jpg";
      }
    }
    if (kind === "file") {
      // 파일 조각(File)을 올릴 때는 contentType 옵션이 무시되고 file.type 이 그대로 서버에 간다.
      // 보관함이 허용하지 않는 종류면 octet-stream 으로 바꿔서(저장하는 mime 도 같은 값) 올린다
      let t = String(file.type || "").toLowerCase();
      t = MIME_ALIAS[t] ?? t;
      if (!ALLOWED_MIME.has(t)) t = "application/octet-stream";
      mime = t;
      if (t !== file.type) big = new Blob([file], { type: t });
    }
    const base = `${pid}/${uid}/${crypto.randomUUID()}`;
    const path = `${base}.${ext}`;
    const thumbPath = thumb ? `${base}_t.jpg` : null;
    const tried = []; // 올리려고 시도한 경로 전부(응답이 끊겨도 서버에는 올라갔을 수 있어서)
    try {
      tried.push(path);
      const up = await c.storage.from(BUCKET).upload(path, big, { contentType: mime, upsert: false });
      if (up.error) throw up.error;
      if (thumb) {
        tried.push(thumbPath);
        const upT = await c.storage.from(BUCKET).upload(thumbPath, thumb, { contentType: "image/jpeg", upsert: false });
        if (upT.error) throw upT.error;
      }
      const { data, error } = await c.from("pj_files").insert({
        project_id: pid, post_id: postId ?? null, kind, path, thumb_path: thumbPath, file_name: fileName,
        size: big.size, mime, width, height, uploaded_by: uid,
      }).select("*").single();
      if (error) throw error;
      return data;
    } catch (e) {
      try { await c.storage.from(BUCKET).remove(tried); } catch { /* 치우기에 실패해도 원래 오류를 알린다 */ }
      throw e;
    }
  }

  async function files(pid, { kind, q, before, limit = 30 } = {}) {
    const lim = clampLimit(limit, 30);
    let qb = (await sb()).from("pj_files").select("*").eq("project_id", pid);
    if (kind === "image" || kind === "file") qb = qb.eq("kind", kind);
    const key = cleanQ(q);
    if (key) qb = qb.ilike("file_name", `%${key}%`);
    if (before) qb = qb.lt("created_at", before);
    const { data, error } = await qb.order("created_at", { ascending: false }).limit(lim + 1);
    if (error) throw error;
    const all = data ?? [];
    return { rows: all.slice(0, lim), hasMore: all.length > lim };
  }

  // 보관함 파일(원본·작은 판)부터 지우고 실패하면 중단 → 행 삭제
  async function deleteFile(row) {
    const uid = await myId();
    if (row.uploaded_by !== uid && !(await isAdmin(row.project_id))) throw kerr(NO_PERM);
    await removeObjects([row.path, row.thumb_path]);
    const { data, error } = await (await sb()).from("pj_files").delete().eq("id", row.id).select("id");
    if (error) throw error;
    if (!data?.length) throw kerr(NO_PERM);
  }

  // 경로들 → 1시간짜리 임시 주소 Map(path → url). 한 번에 받고 55분 동안 img.js 가 기억한다.
  // 사진이 안 열려서 다시 시도할 때는 urls([row.path], { fresh: true }) 로 기억해 둔 주소를 건너뛰고 새로 받는다(true 만 줘도 됨)
  async function urls(paths, opts) {
    const list = [...new Set((paths ?? []).filter(Boolean))];
    if (!list.length) return new Map();
    return signedUrls(await sb(), list, { fresh: opts === true || !!(opts && opts.fresh) });
  }

  async function markRead(pid) {
    const { error } = await (await sb()).rpc("pj_mark_read", { pid });
    if (error) throw error;
  }

  // 모든 공개 메서드는 실패를 한국어 Error 로 바꿔서 던진다
  const wrap = (fb, fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { throw mapErr(e, fb); }
  };

  return {
    profile: wrap("내 정보를 불러오지 못했어요", profile),
    overview: wrap("프로젝트 목록을 불러오지 못했어요", overview),
    createProject: wrap("프로젝트를 만들지 못했어요", createProject),
    updateProject: wrap("프로젝트를 고치지 못했어요", updateProject),
    deleteProject: wrap("프로젝트를 지우지 못했어요", deleteProject),
    join: wrap("참여하지 못했어요", join),
    leave: wrap("나가지 못했어요", leave),
    myMembership: wrap("참여 정보를 불러오지 못했어요", myMembership),
    members: wrap("참여자를 불러오지 못했어요", members),
    addMembers: wrap("참여자를 추가하지 못했어요", addMembers),
    removeMember: wrap("참여자를 내보내지 못했어요", removeMember),
    setRole: wrap("역할을 바꾸지 못했어요", setRole),
    people: wrap("직원 명단을 불러오지 못했어요", people),
    posts: wrap("글을 불러오지 못했어요", posts),
    pinnedPosts: wrap("고정 글을 불러오지 못했어요", pinnedPosts),
    tags: wrap("태그를 불러오지 못했어요", tags),
    savePost: wrap("글을 저장하지 못했어요", savePost),
    deletePost: wrap("글을 지우지 못했어요", deletePost),
    pin: wrap("상단고정을 바꾸지 못했어요", pin),
    comments: wrap("댓글을 불러오지 못했어요", comments),
    addComment: wrap("댓글을 올리지 못했어요", addComment),
    deleteComment: wrap("댓글을 지우지 못했어요", deleteComment),
    uploadFile: wrap("파일을 올리지 못했어요", uploadFile),
    files: wrap("파일을 불러오지 못했어요", files),
    deleteFile: wrap("파일을 지우지 못했어요", deleteFile),
    urls: wrap("사진 주소를 받지 못했어요", urls),
    markRead: wrap("읽음 표시를 하지 못했어요", markRead),
  };
}
