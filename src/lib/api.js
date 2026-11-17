// 화면은 이 파일의 api 객체만 쓴다. 키가 없으면 데모(localStorage), 있으면 Supabase.
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "../config.js";
import { summarize, defaultData } from "./report.js";
import { todayKST, addDays, dow } from "./kst.js";
import { attDemo } from "./att-demo.js";
import { claimsDemo } from "./claims-demo.js";
import { t } from "./i18n.js";

export const isDemo = !(SUPABASE_URL && SUPABASE_ANON_KEY);

// 대표가 지금 보고 있는 사업장. 대표가 호출하는 서버 함수·조회에 함께 실린다. (직원·매니저는 서버가 자기 사업장으로 고정)
let curStore = null;

const LS = {
  get: (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

function rowFrom(date, data, extra = {}) {
  const s = summarize(data);
  return {
    report_date: date, data,
    has_claim: s.has_claim, incomplete: s.incomplete,
    late_count: s.late_count, absent_count: s.absent_count,
    submitted_at: new Date().toISOString(), ...extra,
  };
}

/* ---------------- 데모 ---------------- */
const DEMO_STORES = [
  { id: "demo-gejang", name: "본촌점", display_name: "우아한게장 본촌점", kind: "restaurant", app_key: "gejang" },
  { id: "demo-ck", name: "우아한CK", display_name: "우아한CK", kind: "ck", app_key: "ck" },
  { id: "demo-fnb", name: "우아한F&B", display_name: "우아한F&B", kind: "hq", app_key: "fnb" },
];
// 공지 데모 자료: 이 화면을 연 동안 메모리에만 있다(새로 고치면 처음 상태). 사람 이름은 가짜다
const ntDemo = {
  rows: null, reads: new Map(),
  seed() {
    if (this.rows) return this.rows;
    const ago = (d) => new Date(Date.now() - d * 86400e3).toISOString();
    const base = { store_id: null, translated_at: null, important: false, expires_on: null, created_by: "demo", created_name: "대표(데모)", removed_at: null, title_vi: null, body_vi: null, title_en: null, body_en: null };
    this.rows = [
      { ...base, id: "demo-nt-1", important: true, created_at: ago(1), updated_at: ago(1), translated_at: ago(1),
        title: "이번 주 위생 점검 안내", body: "금요일 오전에 위생 점검이 있어요.\n작업대와 냉장고 안쪽까지 한 번 더 닦아 주세요.",
        title_vi: "Thông báo kiểm tra vệ sinh tuần này", body_vi: "Sáng thứ Sáu sẽ có đợt kiểm tra vệ sinh.\nHãy lau thêm một lần cả bàn làm việc và bên trong tủ lạnh.",
        title_en: "Hygiene inspection this week", body_en: "There will be a hygiene inspection on Friday morning.\nPlease wipe down the work tables and the inside of the fridge once more." },
      { ...base, id: "demo-nt-2", created_at: ago(3), updated_at: ago(3), title: "명절 연휴 근무표", body: "근무표는 이번 주 안에 알려 드릴게요. 바꾸고 싶은 날이 있으면 미리 말해 주세요." },
    ];
    return this.rows;
  },
  storeName(id) { const s = DEMO_STORES.find((x) => x.id === id); return s ? (s.display_name || s.name) : ""; },
  view(r) { return { ...r, read_at: this.reads.get(r.id) ?? null, store_name: r.store_id ? this.storeName(r.store_id) : "" }; },
};
// 회사 용어집 공통(supabase/glossary.sql): 저장할 칸만 골라 앞뒤 공백을 뗀다(서버 트리거도 같은 일을 한다). 값이 없는(undefined) 칸은 보내지 않아서 일부 칸만 고칠 수 있다
const GL_FIELDS = ["ko", "vi", "en", "note", "aliases", "keep_ko", "pinned", "verified", "sort"];
const GL_BAD = /[<>\u0000-\u001f\u007f]/; // 서버 check 의 '[<>[:cntrl:]]'
const GL_BATCH = 10; // AI 초안: translate 함수에 한 번에 보내는 용어 수(term 모드는 20개까지 받는다)
function glFields(term) {
  const f = {};
  for (const k of GL_FIELDS) {
    const v = term?.[k];
    if (v === undefined || v === null) continue;
    f[k] = k === "keep_ko" || k === "pinned" || k === "verified" ? !!v : k === "sort" ? (Math.trunc(Number(v)) || 0) : String(v).trim();
  }
  return f;
}
// 사업장 이름 → 용어 줄(번역하지 않고 그대로 쓰는 '항상 넣기' 용어). 이미 있는 이름·40자를 넘거나 쓸 수 없는 글자가 있는 이름은 건너뛴다. 이름은 코드에 없고 DB 에서 온다
function glStoreTerms(stores, have) {
  const seen = new Set((have ?? []).map((r) => String(r.ko).toLowerCase()));
  const add = [];
  let skipped = 0;
  for (const s of stores ?? []) {
    const ko = String(s.display_name || s.name || "").trim(), short = String(s.name || "").trim();
    if (!ko) continue;
    if (seen.has(ko.toLowerCase()) || Array.from(ko).length > 40 || GL_BAD.test(ko)) { skipped++; continue; }
    seen.add(ko.toLowerCase());
    const alias = short && short !== ko && Array.from(short).length <= 120 && !GL_BAD.test(short) ? short : ""; // 짧은 이름도 같은 용어로 본다
    add.push({ ko, aliases: alias, keep_ko: true, pinned: true });
  }
  return { add, skipped };
}
// AI 초안 결과 한 칸 정리: 서버 check 에 걸리는 글자는 공백으로, 80자를 넘으면 쓰지 않는다
function glClean(v) {
  const s = typeof v === "string" ? v.replace(/[<>\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return s && Array.from(s).length <= 80 ? s : "";
}
// translate 함수가 알려 주는 실패 이유 → 화면에 보일 한국어 문장(화면이 t()로 번역한다)
const GL_REASON = {
  no_key: "AI 번역 키가 아직 설정되지 않았어요",
  timeout: "시간이 너무 오래 걸렸어요. 잠시 뒤에 다시 해 주세요",
  busy: "지금 번역 요청이 몰려 있어요. 잠시 뒤에 다시 해 주세요",
  api_error: "AI 서비스에 문제가 있어요. 잠시 뒤에 다시 해 주세요",
  bad_output: "AI 초안이 올바르지 않아 쓰지 않았어요",
  missing: "AI 초안 기능이 아직 준비되지 않았어요",
  forbidden: "AI 초안을 쓸 권한이 없어요",
};
// 용어집 데모 자료: 이 화면을 연 동안 메모리에만 있다(새로 고치면 처음 상태). 용어는 모두 가상 예시다
const glDemo = {
  rows: null,
  seed() {
    if (this.rows) return this.rows;
    const base = { vi: "", en: "", note: "", aliases: "", keep_ko: false, pinned: false, verified: false, sort: 0, updated_by: "demo", updated_by_name: "대표(데모)", updated_at: new Date().toISOString() };
    this.rows = [
      { ...base, id: "demo-gl-1", ko: "샘플 매장", keep_ko: true, pinned: true, aliases: "샘플점" },
      { ...base, id: "demo-gl-2", ko: "샘플 반찬", vi: "Món ăn kèm mẫu", en: "Sample side dish", verified: true, note: "가상 예시" },
      { ...base, id: "demo-gl-3", ko: "샘플 소스", vi: "Nước sốt mẫu", en: "", note: "가상 예시" },
      { ...base, id: "demo-gl-4", ko: "샘플 포장" },
    ];
    return this.rows;
  },
  sorted() { return this.seed().slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.sort - b.sort || a.ko.localeCompare(b.ko)).map((r) => ({ ...r })); },
  dup(ko, exceptId) { return this.seed().some((r) => r.id !== exceptId && r.ko.toLowerCase() === String(ko).toLowerCase()); },
  add(f) {
    if (!f.ko) throw new Error("한국어 용어를 적어 주세요");
    if (this.dup(f.ko)) throw Object.assign(new Error("이미 같은 한국어 용어가 있어요"), { code: "dup" });
    const row = { vi: "", en: "", note: "", aliases: "", keep_ko: false, pinned: false, verified: false, sort: 0, ...f, id: "demo-gl-" + Math.random().toString(36).slice(2, 8), updated_by: "demo", updated_by_name: "대표(데모)", updated_at: new Date().toISOString() };
    this.seed().push(row);
    return row;
  },
};
// 업무지시 안전 감지(데모용): 서버 supabase/functions/tasks/index.ts 의 SAFETY_WORDS·SAFETY_TIGHT·SAFETY_NUM·SAFETY_CTX·findSafety 를 옮겨 적은 흉내다.
// 기준은 언제나 서버다(감지어를 바꿀 때 서버를 먼저 고치고 이 목록을 그대로 따라 옮긴다). 데모는 서버처럼 되묻기(safety_suspect)를 흉내 내기 위해서만 쓴다.
// tk-safe-start
// (아래는 서버 tasks/index.ts 의 SAFETY_WORDS·SAFETY_TIGHT·SAFETY_NUM·SAFETY_CTX·findSafety 를 기계적으로 옮긴 것이다. 낱말을 왜 이렇게 나눴는지는 서버 쪽 주석을 본다)
const TK_SAFE_WORDS = [
  // 화학·소독·세척 (영어 포함. 락스·표백·소독·살균은 TK_SAFE_TIGHT, 희석은 TK_SAFE_CTX)
  "차아염소산", "세정제", "bleach", "chlorine", "sanitiz", "sanitis", "disinfect",
  // 알레르기
  "알레르기", "알러지", "알레르겐", "알러젠", "알러겐", "allergen", "allergy", "allergic",
  // 해썹·식품 안전 (해섭·해셉·해십·하셉·혼입은 TK_SAFE_CTX)
  "해썹", "HACCP", "소비기한", "유통기한", "식중독", "교차오염", "살모넬라", "노로바이러스", "대장균", "리스테리아", "비브리오",
  // 온도·보관 (낱말 하나로 뜻이 좁은 것만. 냉장·냉동은 아래 맥락 패턴. 섭씨·영하·해동은 TK_SAFE_CTX)
  "보관온도", "중심온도", "celsius", "fahrenheit", "thaw", "refrigerat", "fridge", "freez",
];
const TK_SAFE_TIGHT = ["락스", "표백", "소독", "살균"];
// '락 스'처럼 낱말 한가운데에 공백을 넣어 쓴 것도 잡되, 앞뒤가 한글이 아닌 한 덩어리일 때만 잡는다('하락 스마트스토어'·'일정표 백업'·'영업소 독려'는 앞이나 뒤에 한글이 붙어 있어 안 걸린다)
const TK_SAFE_TIGHT_SPLIT = TK_SAFE_TIGHT.map((w) => new RegExp("(?:^|[^가-힣])" + w[0] + "\\s+" + w[1] + "(?![가-힣])", "u"));
// 숫자와 단위: 5℃(NFKC 로 5°C)·200ppm·50mg/L·100배 희석, '도'는 이상·이하·미만·초과가 붙거나 섭씨·영하·온도·중심 같은 말이 앞에 올 때만(3 도착·5도 3촌은 안 잡는다)
// 첫 패턴 앞의 [-−]? 는 영하 표기(-18℃)의 마이너스를 걸린 글 조각에 함께 보여 주려는 것이다(확인창에 18°C 로만 보이면 영하인 줄 모른다). 2-5℃ 같은 범위의 하이픈은 findSafety 가 뺀다
const TK_SAFE_NUM = [
  /[-−]?\d[\d.,]*\s*(?:[°º˚]\s*[cf]|ppm|mg\s*\/\s*l|g\s*\/\s*l|배\s*희석)/giu,
  /\d[\d.,]*\s*도\s*(?:이상|이하|미만|초과)/giu,
  /(?:섭씨|영하|영상|온도|중심|실온|상온|수온)\s*[:：]?\s*(?:약\s*)?\d[\d.,]*\s*도/giu,
  /(?:오븐|튀김|기름|오일|육수|국물|스팀|냉장고?|냉동고?)\D{0,6}\d{1,3}\s*도(?!어)/giu,  // 기름 170도·냉동 18도 (냉장고 2도어 교체는 아님)
  /\bph\s*\d{1,2}(?:\.\d)?(?![\d:])/giu,
  /(?:cook|heat|store|keep|chill|hold|boil|reach)\D{0,20}\d+\s*[cf](?![a-z])/giu,
];
// 맥락이 붙을 때만 잡는 말. 식품 말(TK_SAFE_FOOD) 곁에서만 기한·폐기를, 화학·희석 말(TK_SAFE_CHEM) 곁에서만 %·비율을 센다
const TK_SAFE_FOOD = "재료|식재|식품|음식|반찬|소스|양념|육수|생선|고기|육류|채소|야채|우유|계란|달걀|게장|젓갈|원료|수산물|농산물|해산물";
const TK_SAFE_CHEM = "희석|농도|용액|락스|염소|표백|소독|알코올|살균|dilut|bleach|chlorine|alcohol|solution|혼합|배합";
const TK_SAFE_CTX = [
  // (앞쪽을 되돌아보는 정규식(lookbehind)은 오래된 아이폰 사파리(16.3 이하)에서 파일 전체가 읽히지 않는다. 화면 데모(api.js)에도 이 글이 그대로 들어가므로 쓰지 않는다)
  // --- 2글자 한글 낱말: flat 비교(공백 지움)에서 빼고 앞이 한글이 아닐 때만 잡는다. 걸린 글 조각에 앞 글자가 딸려 와도 findSafety 가 구두점은 떼어 낸다
  /(?:^|[^가-힣]|자연|급속|저온|실온|상온|냉장|냉동)해동/giu,                                         // 해동 후·냉동 해동·자연해동 (위해 동선·대해 동의서·올해 동료·김해동은 아님)
  /(?:^|[^가-힣])영하(?:\s*(?:로|에서|의))?\s*(?:보관|유지|저장|냉동|급속|온도|이하|이상|(?=\d))/giu,   // 영하 보관·영하로 유지 (영하 18도는 TK_SAFE_NUM. 운영하기·반영하세요·영하은·'영하 날씨'는 아님)
  /(?:^|[^가-힣])(?:섭씨|희석(?!\s*(?:씨|님))|해섭|해셉|해십|하셉)/giu,                              // 섭씨·희석(해썹 오타 해섭·해셉·해십·하셉). 상섭 씨·김희석·희석 씨·유해 섭취는 아님
  /혼입(?!니다)/giu,                                                                                  // 이물 혼입 (결혼입니다·신혼 입주는 아님)
  /(?:^|[^가-힣])염소(?!\s*(?:고기|탕|육|젖|치즈|농장|구이|수육|전골|요리))|잔류\s*염소|유리\s*염소/giu, // 염소(소독제)만. 염소고기·흑염소는 제외
  /(?:^|[^a-z])ccp(?![a-z])/giu,                                                                     // CCP-1 (해썹 중요관리점). ccp 를 품은 영어 낱말은 제외
  /(?:냉장|냉동)(?:고|실|창고)?\s*(?:보관|온도|유지|해동)/giu,                                       // 냉장 보관·냉동 온도 (냉장고 앞 박스 치우기·냉동 창고 재고는 아님)
  /(?:보관|냉장|냉동|창고|중심|가열|조리|해동|식재|재료|육수|튀김|기름|오븐|냉각|식품|음식|게장|고기|숙성고?|입고(?:\s*시)?)\s*온도|(?:^|[^가-힣])물\s*온도/giu, // 창고 온도·가열 온도·숙성 온도·입고 시 온도·물 온도 (사무실 온도·건물 온도는 아님)
  new RegExp("(?:" + TK_SAFE_CHEM + ")\\D{0,14}\\d[\\d.,]*\\s*(?:%|퍼센트|프로)", "giu"),               // 락스 10%·알코올 70프로
  new RegExp("\\d[\\d.,]*\\s*(?:%|퍼센트|프로)\\D{0,14}(?:" + TK_SAFE_CHEM + ")", "giu"),               // 10퍼센트 용액
  /(?:비율|배합|섞|혼합|희석|mix|dilut|ratio|물과|물에)\D{0,10}\d+\s*(?:[:：]|대)\s*\d+/giu,          // 비율 1:100·섞기 1대100 (시각 10:30 은 비율 말이 없어 안 잡힌다)
  /\d+\s*(?:[:：]|대)\s*\d+\s*(?:비율|배합|로\s*섞|으로\s*섞|희석|mix|ratio|dilut|혼합)/giu,
  /알코올\D{0,6}(?:분무|스프레이|살포)/giu,
  new RegExp("(?:" + TK_SAFE_FOOD + ")\\D{0,12}기한\\s*(?:이\\s*)?(?:지난|경과|초과|만료|임박|넘)", "giu"), // 재료 기한 지난 것·기한 지난 재료 (마감 기한·기한 내 발주는 아님)
  new RegExp("기한\\s*(?:이\\s*)?(?:지난|경과|초과|만료|임박|넘)\\D{0,12}(?:" + TK_SAFE_FOOD + ")", "giu"),
  new RegExp("(?:" + TK_SAFE_FOOD + ")\\D{0,6}(?:사용|보관|판매|제조)\\s*기한", "giu"),
  new RegExp("(?:" + TK_SAFE_FOOD + ")\\D{0,8}폐기(?!\\s*물)", "giu"),                                  // 재료 폐기·폐기 대상 재료 (폐기물 분리수거·서류 폐기는 아님)
  new RegExp("폐기(?!\\s*물)\\D{0,8}(?:" + TK_SAFE_FOOD + ")", "giu"),
  /급속\s*냉각|급냉|냉각\s*(?:온도|시간|기록)|블라스트\s*칠러/giu,                                   // 급속 냉각 (냉각팬 청소는 아님)
  /(?:충분히|완전히|속까지|중심까지)\s*(?:익|가열|끓|삶|조리)|가열\s*(?:온도|시간|살균|조리|후|전|\d)|(?:충분히|완전히|재)\s*가열/giu, // 가열 램프 점검은 아님
  /(?:혼합|혼용|재냉동|재동결|실온|상온|화기|생식|날것|음용|섞)\D{0,8}(?:금지|엄금|지\s*(?:마|말)|말\s*것|마세요|마시오)/giu, // 혼합 금지·화기 엄금·날것으로 제공하지 말기·실온에 두지 말기 (주차 금지는 아님)
  /위험\s*(?:온도|물질|물(?![가-힣]))|위해\s*(?:요소|분석)/giu,                                       // 위험 요소 순찰은 아님
  /화상\s*(?:조심|주의|위험|방지)|감전|가스\s*(?:밸브|누출|누설|차단|잠금|잠그)/giu,                    // 화상 회의·도시가스 요금은 아님
  // --- 현장 말투로 쓴 위생·안전 문구 (뜻이 좁은 것만. 넓은 말은 곁말이 있을 때만)
  new RegExp("(?:" + TK_SAFE_FOOD + "|냉장고?|냉동고?|라벨|입고)\\D{0,10}유효\\s*기간|유효\\s*기간\\D{0,10}(?:" + TK_SAFE_FOOD + "|라벨)", "giu"), // 소스 유효기간·냉장고 유효기간 확인 (쿠폰·견적서·카드·계약 유효기간은 아님)
  /\d{1,3}\s*도\s*\)?\s*(?:에서|로|까지|쯤|정도)\s*.{0,12}?(?:가열|끓|익히|익혀|익힌|조리|보관)/giu,    // 75도에서 1분 이상 가열·4도로 보관 (앞뒤 12자 안에 가열·끓·익·조리·보관이 있을 때만)
  /(?:가열|끓|익히|익혀|익힌|조리|보관)\s*.{0,12}?\d{1,3}\s*도\s*\)?\s*(?:에서|로|까지|쯤|정도)/giu,
  new RegExp("(?:날짜|하루|이틀|사흘|\\d+\\s*(?:일|시간))\\s*(?:[이가]\\s*)?(?:지난|경과|넘은|넘긴|초과)\\D{0,6}(?:" + TK_SAFE_FOOD + ")", "giu"), // 하루 지난 반찬·2시간 지난 음식·날짜 지난 재료
  /(?:조리|제조|개봉)\s*후\s*\d+\s*(?:시간|분)\s*(?:[이가]\s*)?(?:지난|경과|넘|초과)/giu,               // 조리 후 2시간 지난 것
  /(?:생고기|날고기|생닭|날생선|생육)\D{0,10}(?:만진|만지|닿|접촉|도마|칼|장갑)/giu,                      // 생고기 만진 손으로 채소 만지지 않기 (교차오염. 생고기 발주는 아님)
  /(?:도마|칼)\D{0,6}(?:구분|분리|따로)\D{0,6}사용/giu,                                               // 도마 칼 구분해서 사용하기 (도마 주문·칼갈이는 아님)
  /(?:lpg|가스통)\D{0,10}(?:교체|연결|밸브|호스|누출|누설|점검)/giu,                                  // LPG 가스통 교체 시 밸브 확인 (가스통 주문·가스 요금은 아님)
  /(?:뜨거운|뜨거우니|뜨거워서|뜨겁|끓는|펄펄)\D{0,12}(?:조심|주의|화상)/giu,                         // 뜨거운 육수 옮길 때 조심
];

function tkSafeFind(text) {
  const nfkc = String(text ?? "").normalize("NFKC"); // 전각 → 반각(ＨＡＣＣＰ·５℃ → HACCP·5°C). 패턴은 모두 i 플래그라 대소문자는 가리지 않고, 확인창에는 쓴 그대로 보인다
  const lower = nfkc.toLowerCase();
  const flat = lower.replace(/\s+/g, "");   // 공백을 지운 글(TK_SAFE_WORDS 용)
  const tight = lower.replace(/\s+/g, " "); // 공백을 한 칸으로만 줄인 글(TK_SAFE_TIGHT 용: 낱말 경계를 넘는 일치를 막는다)
  const spaced = nfkc.replace(/\s+/g, " ");
  const out = [];
  for (const w of TK_SAFE_WORDS) if (flat.includes(w.toLowerCase().replace(/\s+/g, "")) && !out.includes(w)) out.push(w);
  TK_SAFE_TIGHT.forEach((w, i) => { if ((tight.includes(w) || TK_SAFE_TIGHT_SPLIT[i].test(tight)) && !out.includes(w)) out.push(w); });
  for (const re of [...TK_SAFE_NUM, ...TK_SAFE_CTX]) {
    for (const m of spaced.matchAll(re)) {
      let s = m[0].trim();
      const at = m.index ?? 0;
      if (/^[-−]/.test(s) && at > 0 && /\d/.test(spaced.charAt(at - 1))) s = s.slice(1); // 2-5℃ 같은 범위의 하이픈은 마이너스가 아니다
      s = Array.from(s.replace(/^[^\p{L}\p{N}\-−]+/u, "")).slice(0, 24).join(""); // 확인창에 보여 줄 말: 걸린 글 그대로(앞에 딸려 온 구두점은 뗀다. 길면 앞 24자)
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, 8);
}
// tk-safe-end

// 업무지시 데모 자료(번역된 업무·안전 업무·번역 실패·완료 메모 번역 각 1개): 이 화면을 연 동안 메모리에만 있다(새로 고치면 처음 상태). 사람 이름·글은 모두 가짜다.
// 데모는 번역하지 않는다(새 업무는 번역 없이 한국어로만). 안전 되묻기는 서버와 같은 목록(위 TK_SAFE_*)으로 흉내 낸다.
const tkDemo = {
  rows: null,
  seed() {
    if (this.rows) return this.rows;
    const today = todayKST(), ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const base = {
      store_id: "demo-gejang", assignee_id: "demo-staff", assignee_name: "김자유(데모)", created_by: "demo", created_by_name: "대표(데모)", memo: "", due_date: today, repeat: "none",
      status: "open", done_at: null, done_by_name: "", done_note: "", alert_level: 0,
      title_vi: null, memo_vi: null, title_en: null, memo_en: null, translated_at: null, tr_state: null, safety: false, done_note_ko: null, done_note_lang: null, done_note_tr_at: null,
    };
    this.rows = [
      { ...base, id: "demo-tk-1", created_at: ago(120), title: "냉장고 안쪽 선반 닦기", memo: "문 닫기 전까지 끝내 주세요.", tr_state: "auto", translated_at: ago(120),
        title_vi: "Lau kệ bên trong tủ lạnh", memo_vi: "Hãy hoàn thành trước khi đóng cửa.", title_en: "Wipe the shelves inside the fridge", memo_en: "Please finish before closing." },
      { ...base, id: "demo-tk-2", created_at: ago(110), title: "락스 희석 비율 지켜서 작업대 소독", memo: "200ppm 기준을 지켜 주세요.", tr_state: "safety", safety: true },
      { ...base, id: "demo-tk-3", created_at: ago(100), title: "주말 예약 손님 메뉴판 정리", tr_state: "failed", due_date: addDays(today, 1) },
      { ...base, id: "demo-tk-4", created_at: ago(300), title: "배송 상자 재고 세기", tr_state: "auto", translated_at: ago(300),
        title_vi: "Đếm số thùng giao hàng còn lại", memo_vi: "", title_en: "Count the remaining delivery boxes", memo_en: "",
        status: "done", done_at: ago(30), done_by_name: "김자유(데모)", done_note: "Đã đếm xong, còn 12 thùng.", done_note_ko: "다 세었어요. 12상자 남았어요.", done_note_lang: "vi", done_note_tr_at: ago(30) },
    ];
    return this.rows;
  },
  find(id) { const r = this.seed().find((x) => x.id === id); if (!r) throw new Error("업무를 찾지 못했어요"); return r; },
  list() { const rows = this.seed().map((r) => ({ ...r })); return { today: todayKST(), open: rows.filter((r) => r.status === "open"), done: rows.filter((r) => r.status === "done") }; },
};
const demo = {
  async getProfile() {
    const s = LS.get("woo_demo_session", null);
    return s ? { role: s.role, store_name: "본촌점", display_name: { owner: "대표(데모)", manager: "매니저(데모)", staff: "김자유(데모)" }[s.role] } : null;
  },
  async setMyLang() { /* 데모 모드: 이 기기에만 저장(화면에서 처리) */ },
  async signIn(role) { LS.set("woo_demo_session", { role }); },
  async signOut() { localStorage.removeItem("woo_demo_session"); },
  setStore(st) { curStore = st; },
  async changePassword() { throw new Error("데모 모드에서는 비밀번호를 바꿀 수 없어요"); },
  // 업무지시(데모): 메모리 안에서만 동작한다. 번역은 하지 않고(translated:false), 안전 되묻기는 비슷한 말로 흉내 낸다
  async tkMine() { return tkDemo.list(); },
  async tkAll() { return tkDemo.list(); },
  async tkPeople() { return { people: [{ user_id: "demo-staff", display_name: "김자유(데모)", role: "staff", job_title: "홀", store_id: "demo-gejang", stores: { display_name: DEMO_STORES[0].display_name, name: DEMO_STORES[0].name } }] }; },
  async tkCreate(f) {
    const title = String(f?.title ?? "").trim().slice(0, 60), memo = String(f?.memo ?? "").trim().slice(0, 200);
    if (!title) throw new Error("업무 내용을 입력해 주세요");
    const safety = f.safety === true;
    const words = safety || f.safety_ack === true ? [] : tkSafeFind(`${title}\n${memo}`);
    if (words.length) return { ok: false, code: "safety_suspect", words }; // 데모 화면은 새 화면이라 서버의 ask:true 와 같다(되묻기)
    const rows = tkDemo.seed();
    const due = /^\d{4}-\d{2}-\d{2}$/.test(f.due_date ?? "") ? f.due_date : null;
    rows.unshift({ ...rows[0], id: "demo-tk-" + Math.random().toString(36).slice(2, 8), created_at: new Date().toISOString(), title, memo, due_date: due, repeat: ["daily", "weekly", "monthly"].includes(f.repeat) ? f.repeat : "none",
      status: "open", done_at: null, done_by_name: "", done_note: "", done_note_ko: null, done_note_lang: null, done_note_tr_at: null,
      title_vi: null, memo_vi: null, title_en: null, memo_en: null, translated_at: null, tr_state: safety ? "safety" : "skipped", safety }); // 데모는 번역하지 않는다 = 번역할 것이 없는 업무('다시 번역' 버튼이 헛되이 뜨지 않게 skipped)
    return { ok: true, translated: false, state: safety ? "safety" : "none" };
  },
  async tkComplete(id, note) {
    const r = tkDemo.find(id), n = String(note ?? "").trim().slice(0, 200);
    Object.assign(r, { status: "done", done_at: new Date().toISOString(), done_by_name: r.assignee_name, done_note: n, done_note_ko: null, done_note_lang: /[가-힣]/.test(n) ? "ko" : null, done_note_tr_at: null });
    return { ok: true };
  },
  async tkCancel(id) { tkDemo.find(id).status = "canceled"; return { ok: true }; },
  async tkReopen(id) { Object.assign(tkDemo.find(id), { status: "open", done_at: null, done_by_name: "", done_note: "", done_note_ko: null, done_note_lang: null, done_note_tr_at: null }); return { ok: true }; },
  async tkRetranslate(id) {
    const r = tkDemo.find(id);
    if (r.safety || r.tr_state === "safety") throw new Error("안전 관련 업무는 번역하지 않아요");
    return { ok: true, translated: false, state: r.tr_state ?? "none" }; // 데모는 번역하지 않는다
  },
  async sgSend() { throw new Error("데모 모드에서는 건의함을 쓸 수 없어요"); },
  async sgList() { return []; },
  async sgSet() {},
  async sgDelete() {},
  async sgUrls() { return new Map(); },
  async sgUrl() { throw new Error("데모 모드에서는 파일을 열 수 없어요"); },
  async pj() { throw new Error("데모 모드에서는 프로젝트를 쓸 수 없어요"); },
  async pushStatus() { return { supported: false, permission: "unsupported" }; },
  async pushTest() { throw new Error("데모 모드에서는 알림을 시험할 수 없어요"); },
  async aiTaskParse() { throw new Error("데모 모드에서는 AI를 쓸 수 없어요"); },
  async aiPing() { throw new Error("데모 모드에서는 AI를 쓸 수 없어요"); },
  async libList() { return []; },
  async libUpload() { throw new Error("데모 모드에서는 파일을 올릴 수 없어요"); },
  async libUrl() { throw new Error("데모 모드에서는 파일을 열 수 없어요"); },
  async libUpdate() { throw new Error("데모 모드에서는 파일을 고칠 수 없어요"); },
  async libDelete() {},
  // 공지(데모): 메모리 안에서만 동작한다. 번역은 하지 않고(translated:false), 확인은 이 기기에서만 센다
  async noticeList() { return ntDemo.seed().filter((r) => !r.removed_at).map((r) => ntDemo.view(r)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100); },
  async noticeRead(id) { if (!ntDemo.reads.has(id)) ntDemo.reads.set(id, new Date().toISOString()); },
  async noticeStatus(id) {
    const people = [{ user_id: "demo-u1", name: "직원A", job_title: "홀" }, { user_id: "demo-u2", name: "직원B", job_title: "주방" }, { user_id: "demo-u3", name: "직원C", job_title: "포장" }];
    const at = ntDemo.reads.get(id);
    return { targets: people.length, confirmed: at ? [{ ...people[0], at }] : [], pending: at ? people.slice(1) : people };
  },
  async noticeSave(p) {
    const rows = ntDemo.seed(), now = new Date().toISOString();
    if (!String(p.title ?? "").trim() || !String(p.body ?? "").trim()) throw new Error("제목과 내용을 적어 주세요");
    const f = { title: p.title, body: p.body, store_id: p.store_id ?? null, important: !!p.important, expires_on: p.expires_on || null, updated_at: now };
    let row = p.id ? rows.find((r) => r.id === p.id) : null;
    if (row) {
      if (row.title !== f.title || row.body !== f.body) Object.assign(row, { title_vi: null, body_vi: null, title_en: null, body_en: null, translated_at: null });
      Object.assign(row, f);
    } else {
      row = { id: "demo-nt-" + Math.random().toString(36).slice(2, 8), title_vi: null, body_vi: null, title_en: null, body_en: null, translated_at: null, created_by: "demo", created_name: "대표(데모)", created_at: now, removed_at: null, ...f };
      rows.unshift(row);
    }
    return { ok: true, notice: ntDemo.view(row), translated: false, pushed: 0 };
  },
  async noticeRetranslate(id) {
    const row = ntDemo.seed().find((r) => r.id === id);
    if (!row) throw new Error("공지를 찾지 못했어요");
    return { ok: true, notice: ntDemo.view(row), translated: false };
  },
  async noticeRemove(id) { const row = ntDemo.seed().find((r) => r.id === id); if (row) row.removed_at = new Date().toISOString(); return { ok: true }; },
  // 회사 용어집(데모): 메모리 안에서만 동작한다. AI 초안은 번역 서버가 있어야 해서 쓸 수 없다
  async glList() { return glDemo.sorted(); },
  async glSave(term) {
    const f = glFields(term);
    if (term?.id) {
      const row = glDemo.seed().find((r) => r.id === term.id);
      if (!row) throw new Error("용어를 저장하지 못했어요. 권한이나 삭제 여부를 확인해 주세요");
      if (f.ko !== undefined && (!f.ko || glDemo.dup(f.ko, row.id))) throw Object.assign(new Error(f.ko ? "이미 같은 한국어 용어가 있어요" : "한국어 용어를 적어 주세요"), { code: "dup" });
      Object.assign(row, f, { updated_by: "demo", updated_by_name: "대표(데모)", updated_at: new Date().toISOString() });
      return { ...row };
    }
    return { ...glDemo.add(f) };
  },
  async glAddMany(terms) {
    let added = 0, skipped = 0;
    for (const x of terms ?? []) { const f = glFields(x); if (!f.ko) continue; if (glDemo.dup(f.ko)) skipped++; else { glDemo.add(f); added++; } }
    return { added, skipped };
  },
  async glDelete(id) {
    const rows = glDemo.seed(), i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error("용어를 지우지 못했어요. 권한을 확인해 주세요");
    rows.splice(i, 1);
  },
  async glImportStores() {
    const { add, skipped } = glStoreTerms(DEMO_STORES, glDemo.seed());
    const r = await this.glAddMany(add);
    return { added: r.added, skipped: skipped + r.skipped };
  },
  async glDraft() { throw new Error("데모 모드에서는 AI 초안을 쓸 수 없어요"); },
  async wkList() { return []; },
  async wkSave() { throw new Error("데모 모드에서는 업무 기록을 쓸 수 없어요"); },
  async wkDelete() {},
  async chkToday() { throw new Error("데모 모드에서는 점검 기능을 쓸 수 없어요"); },
  async listStores() { return DEMO_STORES; },
  async overview() {
    const z = { in_today: 0, working: 0, not_in: 0, missing_out: 0, pending_approval: 0 };
    return { stores: DEMO_STORES.map((s) => ({ ...s, closed: false, people: 3, attendance: { ...z, in_today: 2 }, claims: { open: s.app_key === "gejang" ? 1 : 0, severe: 0 }, report: s.kind === "restaurant" ? { submitted: false } : null })) };
  },
  async getReport(date) { return LS.get("woo_demo_reports", {})[date] ?? null; },
  async saveReport(date, data) {
    const all = LS.get("woo_demo_reports", {});
    all[date] = rowFrom(date, data);
    LS.set("woo_demo_reports", all);
    return all[date];
  },
  async listReports(fromDate) {
    const all = LS.get("woo_demo_reports", {});
    return Object.values(all).filter((r) => r.report_date >= fromDate).sort((a, b) => b.report_date.localeCompare(a.report_date));
  },
  async enablePush() {
    if (!("Notification" in window)) throw new Error("이 브라우저는 알림을 지원하지 않아요");
    const p = await Notification.requestPermission();
    if (p !== "granted") throw new Error("알림이 허용되지 않았어요");
    const reg = await navigator.serviceWorker?.ready;
    const opt = { body: t("데모: 실제 연결 후에는 보고가 올 때 이렇게 알려 드려요"), icon: "icons/icon-192.png" };
    if (reg) reg.showNotification(t("{store} 일일보고 도착 · 클레임 {n}건", { store: "본촌점", n: 1 }), opt); else new Notification(t("{store} 일일보고 도착", { store: "본촌점" }), opt);
    LS.set("woo_demo_push", true);
  },
  pushEnabled() { return !!LS.get("woo_demo_push", false); },
  ...attDemo,
  ...claimsDemo,
  async stRecv() { return LS.get("woo_demo_recv", []); },
  async stDeps() { return LS.get("woo_demo_deps", []); },
  async recon18Deps() { return LS.get("woo_demo_deps", []); },
  async stWds() { return []; },
  async stRules() { return []; },
  async stSetRule() {},
  async stDelRule() {},
  async stAddWds() { return 0; },
  async stInvs() { return []; },
  async stAddInvs() { return 0; },
  async stAddRecv(rows) {
    const all = LS.get("woo_demo_recv", []); const have = new Set(all.map((r) => r.ref)); let n = 0;
    for (const r of rows) if (!have.has(r.ref)) { all.push({ id: "r" + Math.random().toString(36).slice(2), closed: false, dunned_at: null, ...r }); n++; }
    LS.set("woo_demo_recv", all); return n;
  },
  async stAddDeps(rows) {
    const all = LS.get("woo_demo_deps", []); const have = new Set(all.map((r) => r.ref)); let n = 0;
    for (const r of rows) if (!have.has(r.ref)) { all.push({ id: "d" + Math.random().toString(36).slice(2), ...r }); n++; }
    LS.set("woo_demo_deps", all); return n;
  },
  async stPatch(id, f) { LS.set("woo_demo_recv", LS.get("woo_demo_recv", []).map((r) => (r.id === id ? { ...r, ...f } : r))); },
  async stDelete(id) { LS.set("woo_demo_recv", LS.get("woo_demo_recv", []).filter((r) => r.id !== id)); },
  async adminUsers(body) {
    if (body.action === "list") return { users: [{ id: "1", email: "owner@demo", role: "owner", display_name: "대표(데모)", job_title: "대표" }, { id: "2", email: "manager@demo", role: "manager", display_name: "매니저(데모)", job_title: "매니저" }] };
    throw new Error("데모 모드에서는 계정을 바꿀 수 없어요");
  },
  // 데모 전용: 최근 3주 샘플 데이터
  async seedSample() {
    const all = LS.get("woo_demo_reports", {});
    const today = todayKST();
    for (let i = 1; i <= 21; i++) {
      const date = addDays(today, -i);
      if (i % 9 === 0) continue; // 미제출 날
      const d = defaultData(date);
      d.att.absent = i % 7 === 0 ? "has" : "none"; if (d.att.absent === "has") d.att.absents = [{ name: "김결원", note: "개인 사정" }];
      d.att.late = i % 5 === 0 ? "has" : "none";
      if (d.att.late === "has") d.att.lates = [{ name: "홍길동", time: "18:10" }];
      d.claim.state = i % 6 === 0 ? "has" : "none";
      if (d.claim.state === "has") d.claim.items = [{ content: "반찬 리필이 늦다는 말씀", result: "사과드리고 서비스 제공" }];
      d.chk.reviewDone = true; d.chk.openDone = true; d.chk.yard = true; d.chk.closing = i % 4 !== 0;
      d.chk.openMissing = i % 8 === 0 ? ["천장 거미줄 제거"] : [];
      d.chk.trash = dow(date) === 0 ? "noPickup" : "done";
      all[date] = rowFrom(date, d, { submitted_at: new Date(Date.parse(date) + 13 * 3600e3).toISOString() });
    }
    LS.set("woo_demo_reports", all);
  },
  async resetDemo() { localStorage.removeItem("woo_demo_reports"); localStorage.removeItem("woo_demo_push"); },
};

/* ---------------- Supabase ---------------- */
let _sb;
let pjMod; // 프로젝트 기능은 따로 불러온다(새 파일에 문제가 있어도 로그인·다른 화면은 정상)
async function sb() {
  if (!_sb) {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
    _sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return _sb;
}

function b64ToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/* ---------------- 건의함 첨부 (supabase/suggestions-files.sql) ---------------- */
// 비공개 보관함 suggest-files. 경로는 {uid}/{무작위 id}.{확장자} (ASCII) — 한글·공백 이름은 경로에 쓰지 않고 원래 이름은 건의 행의 files[].name 에만 둔다.
const SG_BUCKET = "suggest-files";
const SG_MAX = 5; // 건의 하나에 붙일 수 있는 개수(DB 검사와 같게)
const SG_URL_KEEP_MS = 55 * 60 * 1000; // 1시간짜리 주소는 55분만 기억(만료 직전 주소를 쓰지 않도록)
const sgUrlCache = new Map(); // 경로 -> { url, exp }
// 보관함이 받는 파일 종류(supabase/suggestions-files.sql 4번의 allowed_mime_types 와 같게 유지). 이 밖이면 octet-stream 으로 올린다
const SG_MIME = new Set([
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
const SG_MIME_ALIAS = { "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };
const SG_PATH_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]+$/i;
// 건의 행의 files 에서 지울 수 있는 경로만(모양이 맞는 것). 남이 쓴 값이라 그대로 믿지 않는다
const sgPaths = (files) => (Array.isArray(files) ? files : []).map((f) => f && f.path).filter((p) => typeof p === "string" && SG_PATH_OK.test(p) && !p.includes(".."));
const sgCleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "");
const sgShort = (s) => { const a = [...sgCleanName(s)]; return a.length > 30 ? a.slice(0, 29).join("") + "…" : a.join(""); };
// 첨부 열·보관함이 아직 없다는 오류인가(suggestions-files.sql 을 안 돌린 서버)
function sgNotReady(e) {
  const m = String((e && e.message) || ""), code = String((e && (e.code || e.statusCode || e.status)) || "");
  return /bucket not found/i.test(m) || code === "PGRST204" || code === "42703" || (/files/i.test(m) && /column|schema cache/i.test(m));
}
// 첨부가 있는 건의 보내기: 파일을 한 개씩 올리고 → 건의 행 저장. 어느 단계든 실패하면 올린 파일을 치우고(가능한 만큼) 건의는 저장하지 않는다.
// opts.onProgress({ phase: "up"|"save", i, n }) 로 진행을 알린다. 사진은 폰에서 줄여(긴 변 1600px JPEG) 올린다.
async function sgSendFiles(c, p, base, files, opts) {
  const img = await import("./img.js");
  if (files.length > SG_MAX) throw new Error(t("첨부는 최대 {max}개까지 붙일 수 있어요", { max: SG_MAX }));
  for (const f of files) { const bad = img.checkFile(f); if (bad) throw new Error(bad); }
  const bucket = c.storage.from(SG_BUCKET);
  const tried = []; // 올리려고 시도한 경로 전부(응답이 끊겨도 서버에는 올라갔을 수 있어서)
  const done = [];  // 건의 행에 적을 첨부 정보 {path,name,size,type}
  let step = "up", cur = "";
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      cur = sgShort(f.name);
      if (opts.onProgress) opts.onProgress({ phase: "up", i: i + 1, n: files.length });
      let blob = f, ext = img.extOf(f.name), type = "";
      let name = sgCleanName(f.name) || "file";
      if (img.isImage(f)) {
        let r = null;
        try { r = await img.resizeImage(f); } catch { r = null; }
        if (r && r.big) { blob = r.big; ext = "jpg"; type = "image/jpeg"; name = name.replace(/\.[^./\\]+$/, "") + ".jpg"; }
      }
      if (!type) { // 줄이지 않은 파일: 보관함이 받는 종류가 아니면 octet-stream (File 은 contentType 옵션이 무시되고 file.type 이 그대로 가므로 Blob 으로 감싼다)
        type = String(f.type || "").toLowerCase();
        type = SG_MIME_ALIAS[type] ?? type;
        if (!SG_MIME.has(type)) type = "application/octet-stream";
        if (type !== f.type) blob = new Blob([f], { type });
      }
      const path = `${p.user_id}/${crypto.randomUUID()}.${ext}`;
      tried.push(path);
      const up = await bucket.upload(path, blob, { contentType: type, upsert: false });
      if (up.error) throw up.error;
      done.push({ path, name: [...name].slice(0, 200).join(""), size: blob.size, type }); // 글자(코드포인트) 단위로 자른다: DB 는 200자 이하만 받고, 쪼개진 이모지는 JSON 저장이 거절된다
    }
    step = "save";
    if (opts.onProgress) opts.onProgress({ phase: "save", i: files.length, n: files.length });
    const { error } = await c.from("suggestions").insert({ ...base, files: done });
    if (error) throw error;
  } catch (e) {
    if (tried.length) { try { await bucket.remove(tried); } catch { /* 정리에 실패해도 원래 오류를 알린다(고아 파일은 남을 수 있다: suggestions-files.sql 설명) */ } }
    console.warn("[건의 첨부]", e);
    if (sgNotReady(e)) throw new Error("첨부 기능을 쓰려면 supabase/suggestions-files.sql 을 먼저 Run 해야 해요");
    if (step === "up") throw new Error(t("{nm}: 올리지 못해서 건의를 보내지 않았어요. 다시 시도해 주세요", { nm: cur }));
    throw new Error("건의를 보내지 못했어요. 다시 시도해 주세요");
  }
}

const remote = {
  async getProfile() {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) return null;
    const cols = "role,store_id,display_name,job_title,can_settle,stores(name,kind,display_name,app_key)";
    // lang(화면 언어) 열은 i18n.sql 을 실행한 뒤에만 있다. 아직 없으면 열 없이 다시 읽어서 앱이 멈추지 않게 한다
    let { data, error } = await c.from("profiles").select("lang," + cols).eq("user_id", session.user.id).maybeSingle();
    if (error && /lang/i.test(error.message ?? "")) ({ data, error } = await c.from("profiles").select(cols).eq("user_id", session.user.id).maybeSingle());
    if (error) throw error;
    if (!data) throw new Error("계정에 역할이 아직 연결되지 않았어요 (accounts.sql 실행 필요)");
    return { lang: data.lang ?? null, role: data.role, job_title: String(data.job_title ?? "").trim(), can_settle: !!data.can_settle, store_id: data.store_id, store_name: data.stores?.name ?? "본촌점", store_kind: data.stores?.kind ?? "restaurant", store_app_key: data.stores?.app_key ?? null, store_display: data.stores?.display_name ?? data.stores?.name ?? "본촌점", display_name: data.display_name, user_id: session.user.id };
  },
  // 내 화면 언어를 서버에 저장한다(i18n.sql 의 set_my_lang). 서버가 아직 준비 안 됐으면 오류 — 호출하는 쪽에서 이 기기에만 바꾼다
  async setMyLang(l) {
    const { error } = await (await sb()).rpc("set_my_lang", { p_lang: l });
    if (error) throw error;
  },
  async signIn(email, password) {
    const c = await sb();
    const { error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw new Error("이메일 또는 비밀번호가 맞지 않아요");
  },
  async signOut() {
    curStore = null;
    const c = await sb();
    // 이 폰의 푸시 구독을 정리해, 같은 폰에서 다른 계정으로 로그인해도 알림이 섞이지 않게 한다
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) { await c.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe(); }
    } catch { /* 정리에 실패해도 로그아웃은 진행 */ }
    LS.set("woo_push_on", false);
    await c.auth.signOut();
  },
  setStore(st) { curStore = st; },
  async changePassword(password) {
    const { error } = await (await sb()).auth.updateUser({ password });
    if (error) throw new Error("비밀번호를 바꾸지 못했어요. 다시 로그인한 뒤 시도해 주세요");
  },
  // 지금 다루는 사업장 id: 대표가 고른 곳, 없으면 내 소속
  async storeId() { return curStore?.id ?? (await this.getProfile()).store_id; },
  async listStores() {
    const { data, error } = await (await sb()).from("stores").select("id,name,display_name,kind,app_key").order("app_key");
    if (error) throw error;
    return data;
  },
  overview() { return this.fn("overview", {}); },
  async getReport(date) {
    const { data, error } = await (await sb()).from("daily_reports").select("*").eq("report_date", date).eq("store_id", await this.storeId()).maybeSingle();
    if (error) throw error;
    return data;
  },
  async saveReport(date, data) {
    const c = await sb();
    const p = await this.getProfile();
    const s = summarize(data);
    const row = {
      store_id: p.store_id, report_date: date, data,
      has_claim: s.has_claim, incomplete: s.incomplete, late_count: s.late_count, absent_count: s.absent_count,
      submitted_by: p.user_id, submitted_at: new Date().toISOString(),
    };
    const { data: saved, error } = await c.from("daily_reports").upsert(row, { onConflict: "store_id,report_date" }).select().single();
    if (error) throw error;
    // 대표 푸시: 실패해도 제출은 성공 처리
    c.functions.invoke("notify-report", { body: { report_date: date } }).catch(() => {});
    return saved;
  },
  async listReports(fromDate) {
    const { data, error } = await (await sb()).from("daily_reports").select("*").eq("store_id", await this.storeId()).gte("report_date", fromDate).order("report_date", { ascending: false });
    if (error) throw error;
    return data;
  },
  async enablePush() {
    const miss = [];
    if (!("serviceWorker" in navigator)) miss.push("serviceWorker");
    if (!("PushManager" in window)) miss.push("PushManager");
    if (typeof Notification === "undefined") miss.push("Notification");
    if (miss.length) {
      const standalone = matchMedia("(display-mode: standalone)").matches ? "설치앱" : "브라우저";
      // 진단 정보는 콘솔로만(오류 문구는 번역할 수 있게 고정)
      console.warn(`푸시를 지원하지 않아요 [없는 기능: ${miss.join(", ")} / ${isSecureContext ? "https" : "비보안"} / ${standalone} / ${navigator.userAgent.slice(0, 90)}]`);
      throw new Error("푸시를 지원하지 않아요");
    }
    if (!VAPID_PUBLIC_KEY) throw new Error("VAPID 공개키가 config.js에 없어요");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("알림이 허용되지 않았어요");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const p = await this.getProfile();
    const { error } = await (await sb()).from("push_subscriptions").upsert(
      { user_id: p.user_id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) throw error;
    LS.set("woo_push_on", true);
  },
  // 알림 점검: 이 기기가 알림을 받을 수 있는 상태인지 단계별로 알려 준다
  async pushStatus() {
    const ua = navigator.userAgent;
    const st = {
      secure: isSecureContext, standalone: matchMedia("(display-mode: standalone)").matches, ios: /iPhone|iPad|iPod/i.test(ua), kakao: /KAKAOTALK/i.test(ua),
      sw: "serviceWorker" in navigator, push: "PushManager" in window, notif: typeof Notification !== "undefined",
      permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported", hasSub: false, saved: false,
    };
    st.supported = st.sw && st.push && st.notif;
    if (!st.supported) return st;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      st.hasSub = !!sub;
      if (sub) {
        const { data } = await (await sb()).from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).limit(1);
        st.saved = !!data?.length;
      }
    } catch { /* 점검 중 오류는 상태에 반영하지 않고 넘어간다 */ }
    return st;
  },
  pushTest() { return this.fn("project-notify", { action: "test" }); }, // 내 기기들로 시험 알림을 보낸다(서버에서 보냄)
  // 말로 업무지시(AI): 해석만 한다. 저장은 사람이 카드를 확인하고 tkCreate 로 한다 (ai 함수, ai.sql)
  aiTaskParse(text) { return this.fn("ai", { action: "parse_task", text }); },
  aiPing() { return this.fn("ai", { action: "ping" }); },
  // Edge Function 호출. 실패하면 서버가 준 한국어 메시지와 code를 담은 Error를 던진다
  async fn(name, body) {
    const { data, error } = await (await sb()).functions.invoke(name, { body: curStore ? { store_id: curStore.id, ...body } : body });
    if (error) {
      let msg = "서버에 연결하지 못했어요", code = "network";
      try { const j = await error.context.json(); if (j?.error) { msg = j.error; code = j.code ?? "error"; } } catch { /* 기본 문구 */ }
      throw Object.assign(new Error(msg), { code });
    }
    if (data?.error) throw Object.assign(new Error(data.error), { code: data.code ?? "error" });
    return data;
  },
  adminUsers(body) { return this.fn("manage-users", body); },

  /* 업무지시 */
  tkMine() { return this.fn("tasks", { action: "mine" }); },
  // all=true: 사업장 구분 없이 전 직원 대상(대표·부대표)
  tkAll(all = false) { return this.fn("tasks", { action: "all", all }); },
  tkPeople(all = false) { return this.fn("tasks", { action: "people", all }); },
  // 응답을 그대로 돌려준다: {ok:true, translated, state} · 안전 관련 말이 있는데 확인(f.safety·f.safety_ack)이 없으면 아무것도 저장하지 않고 {ok:false, code:"safety_suspect", words}.
  // ask:true 는 '이 화면은 안전 되묻기를 처리할 수 있다'는 신호다. 서버는 이 신호가 있을 때만 되묻고, 없으면(예전 화면) 되묻지 않고 안전 업무로 저장한다(되묻기를 읽지 못하는 화면이 '지시했어요'라고 하고 조용히 잃지 않게).
  // 호출하는 화면(tasks-admin·ai-task)이 f 에 무엇을 넣어도 이 신호는 항상 붙는다
  tkCreate(f, all = false) { return this.fn("tasks", { action: "create", all, ...f, ask: true }); },
  tkComplete(id, note) { return this.fn("tasks", { action: "complete", id, note }); },
  tkCancel(id, all = false) { return this.fn("tasks", { action: "cancel", id, all }); },
  tkReopen(id, all = false) { return this.fn("tasks", { action: "reopen", id, all }); },
  // 번역에 실패한 지시·완료 메모를 다시 번역(대표·부대표·지시한 사람). 안전 업무는 번역하지 않는다. → {ok, translated, state}
  tkRetranslate(id, all = false) { return this.fn("tasks", { action: "retranslate", id, all }); },

  /* CK 점검 체크리스트 */
  chkToday() { return this.fn("checklist", { action: "today" }); },
  chkSubmit(f) { return this.fn("checklist", { action: "submit", ...f }); },
  chkReport(note) { return this.fn("checklist", { action: "report", note }); },
  chkBoard() { return this.fn("checklist", { action: "board" }); },
  chkResolve(id) { return this.fn("checklist", { action: "resolve", id }); },
  chkItems() { return this.fn("checklist", { action: "items" }); },
  chkSave(f) { return this.fn("checklist", { action: "save_item", ...f }); },
  chkSeed(replace) { return this.fn("checklist", { action: "seed_defaults", replace: replace === true }); },

  /* 클레임 후속조치 */
  clList(scope) { return this.fn("claims", { action: "list", scope }); },
  clCreate(f) { return this.fn("claims", { action: "create", ...f }); },
  clNote(id, note) { return this.fn("claims", { action: "note", id, note }); },
  clStatus(id, status, note) { return this.fn("claims", { action: "status", id, status, note }); },

  /* 출퇴근 */
  attStatus() { return this.fn("attendance", { action: "status" }); },
  attConsent() { return this.fn("attendance", { action: "consent" }); },
  attPunch(kind, pos) { return this.fn("attendance", { action: kind, ...(pos ?? {}) }); },
  attReportOut(id, time) { return this.fn("attendance", { action: "report_out", id, time }); },
  async attMine(fromDate) {
    const p = await this.getProfile();
    const { data, error } = await (await sb()).from("attendance").select("*").eq("user_id", p.user_id).gte("work_date", fromDate).order("in_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async attAll(fromDate) {
    const { data, error } = await (await sb()).from("attendance").select("*").eq("store_id", await this.storeId()).gte("work_date", fromDate).order("in_at", { ascending: false });
    if (error) throw error;
    return data;
  },
  async attEmployees() { return (await this.fn("attendance", { action: "employees" })).employees; },
  async attStore() {
    const { data, error } = await (await sb()).from("stores").select("name,lat,lng,radius_m").eq("id", await this.storeId()).single();
    if (error) throw error;
    return data;
  },
  attSetStore(lat, lng, radius_m) { return this.fn("attendance", { action: "set_store", lat, lng, radius_m }); },
  attSetWork(user_id, f) { return this.fn("attendance", { action: "set_work", user_id, ...f }); },
  attEdit(id, f, reason) { return this.fn("attendance", { action: "edit", id, ...f, reason }); },
  attApprove(id) { return this.fn("attendance", { action: "approve", id }); },
  attAdd(f) { return this.fn("attendance", { action: "add", ...f }); },
  /* 수금 대조 (대표 전용 테이블, RLS로 보호) */
  async stRecv() {
    const { data, error } = await (await sb()).from("receivables").select("*").eq("store_id", await this.storeId()).order("expected_date");
    if (error) throw error;
    return data;
  },
  async stDeps() {
    const { data, error } = await (await sb()).from("bank_deposits").select("id,dep_date,amount,memo").eq("store_id", await this.storeId()).order("dep_date");
    if (error) throw error;
    return data.map((d) => ({ id: d.id, date: d.dep_date, amount: d.amount, memo: d.memo }));
  },
  // 매출-입금 대조(대표·부대표·회장 전용): 서버 함수(recon18.sql)가 역할을 확인한 뒤에만 입금을 돌려준다. 권한이 없으면 오류.
  async recon18Deps(from, to) {
    const { data, error } = await (await sb()).rpc("recon18_deposits", { p_store: await this.storeId(), p_from: from ?? null, p_to: to ?? null });
    if (error) throw error;
    return (data ?? []).map((d) => ({ id: d.id, date: d.dep_date, amount: Number(d.amount), memo: d.memo }));
  },
  // 이미 있는 건(ref 같음)은 건드리지 않는다 → 종결·독촉 기록이 유지된다. 새로 들어간 건수를 돌려준다.
  async stAddRecv(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, source: r.source, counterparty: r.counterparty ?? "", expected_date: r.expected_date, amount: r.amount, ref: r.ref, estimated: !!r.estimated, note: r.note ?? "" }));
      // 이미 있는 건 중 "추정"이던 것은 새 파일의 금액으로 갱신(추정 → 확정). 종결·독촉 기록은 건드리지 않는다.
      const { data: ex, error: e1 } = await c.from("receivables").select("id,ref,estimated,amount").eq("store_id", store_id).in("ref", part.map((p) => p.ref));
      if (e1) throw e1;
      const exMap = new Map(ex.map((e) => [e.ref, e]));
      for (const p of part) {
        const e = exMap.get(p.ref);
        if (e && e.estimated && (!p.estimated || p.amount !== e.amount)) {
          const { error } = await c.from("receivables").update({ amount: p.amount, estimated: p.estimated, expected_date: p.expected_date, note: p.note }).eq("id", e.id);
          if (error) throw error; n++;
        }
      }
      const fresh = part.filter((p) => !exMap.has(p.ref));
      if (fresh.length) {
        const { data, error } = await c.from("receivables").upsert(fresh, { onConflict: "store_id,ref", ignoreDuplicates: true }).select("id");
        if (error) throw error; n += data.length;
      }
    }
    return n;
  },
  async stAddDeps(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, dep_date: r.date, amount: r.amount, memo: r.memo ?? "", ref: r.ref }));
      const { data, error } = await c.from("bank_deposits").upsert(part, { onConflict: "store_id,ref", ignoreDuplicates: true }).select("id");
      if (error) throw error; n += data.length;
    }
    return n;
  },
  // 통장 출금(지출) 내역
  async stWds() {
    const { data, error } = await (await sb()).from("bank_withdrawals").select("id,wd_date,amount,memo").eq("store_id", await this.storeId()).order("wd_date");
    if (error) throw error;
    return data.map((d) => ({ id: d.id, date: d.wd_date, amount: d.amount, memo: d.memo }));
  },
  // 거래처 분류 규칙 (지출 분석)
  async stRules() {
    const { data, error } = await (await sb()).from("spend_rules").select("keyword,category").eq("store_id", await this.storeId());
    if (error) throw error;
    return data;
  },
  async stSetRule(keyword, category) {
    const { error } = await (await sb()).from("spend_rules").upsert({ store_id: await this.storeId(), keyword: keyword.trim(), category: category.trim() }, { onConflict: "store_id,keyword" });
    if (error) throw error;
  },
  async stDelRule(keyword) {
    const { error } = await (await sb()).from("spend_rules").delete().eq("store_id", await this.storeId()).eq("keyword", keyword);
    if (error) throw error;
  },
  async stAddWds(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, wd_date: r.date, amount: r.amount, memo: r.memo ?? "", ref: r.ref }));
      const { data, error } = await c.from("bank_withdrawals").upsert(part, { onConflict: "store_id,ref", ignoreDuplicates: true }).select("id");
      if (error) throw error; n += data.length;
    }
    return n;
  },
  // 매입 (세금)계산서
  async stInvs() {
    const { data, error } = await (await sb()).from("tax_invoices").select("issue_date,approval_no,supplier,rep,biz_no,amount,tax_free,item").eq("store_id", await this.storeId()).order("issue_date").limit(5000);
    if (error) throw error;
    return data.map((d) => ({ date: d.issue_date, no: d.approval_no, supplier: d.supplier, rep: d.rep, bizNo: d.biz_no, amount: d.amount, taxFree: d.tax_free, item: d.item }));
  },
  async stAddInvs(rows) {
    const c = await sb(), store_id = await this.storeId(); let n = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map((r) => ({ store_id, issue_date: r.date, approval_no: r.no, supplier: r.supplier, rep: r.rep, biz_no: r.bizNo, amount: r.amount, tax_free: r.taxFree, item: r.item }));
      const { data, error } = await c.from("tax_invoices").upsert(part, { onConflict: "store_id,approval_no", ignoreDuplicates: true }).select("id");
      if (error) throw error; n += data.length;
    }
    return n;
  },
  async stPatch(id, f) { const { error } = await (await sb()).from("receivables").update(f).eq("id", id); if (error) throw error; },
  async stDelete(id) { const { error } = await (await sb()).from("receivables").delete().eq("id", id); if (error) throw error; },
  // 프로젝트 아카이브: 화면은 const pj = await api.pj() 로 쓴다 (pj-api.js, projects.sql)
  pj() {
    return (pjMod ??= import("./pj-api.js").then((m) => m.makePj({ sb, me: () => this.getProfile() })).catch((e) => { pjMod = null; throw e; }));
  },
  // 서식·자료함: 파일은 Storage(library), 목록·권한은 library_files(RLS). 보이는 것만 서버가 내려준다.
  async libList() {
    const { data, error } = await (await sb()).from("library_files").select("*, stores(display_name,name)").order("created_at", { ascending: false }).limit(1000);
    if (error) throw error;
    return data;
  },
  // 언어판 열(lang·doc_id)이 없는 서버(library2.sql 을 아직 안 돌림)인지 알아보고, 알아볼 수 있는 문장의 오류로 바꿔 돌려준다. usedNew = 이번 요청이 새 열을 보냈는가
  libErr(e, usedNew) {
    if (!usedNew) return e;
    const m = String((e && e.message) || ""), code = String((e && (e.code || e.statusCode || e.status)) || "");
    if (code === "PGRST204" || code === "42703" || (/\b(lang|doc_id)\b/i.test(m) && /column|schema cache/i.test(m))) return new Error("언어판을 올리려면 supabase/library2.sql 을 먼저 Run 해야 해요");
    if (code === "23503" && !/store_id/i.test(m + " " + String((e && e.details) || ""))) return new Error("원본 문서가 이미 지워졌어요. 목록을 새로 불러온 뒤 다시 해 주세요"); // doc_id 가 가리키는 줄이 없음(사업장 연결 오류는 제외)
    return e;
  },
  async libUpload(file, meta) { // meta: {title, folder, note, audience, store_id, lang?, doc_id?} — lang 기본 'ko', doc_id = 번역본이 가리키는 원본 문서
    const c = await sb(), p = await this.getProfile();
    if (file.size > 20 * 1024 * 1024) throw new Error("파일 하나는 20MB까지 올릴 수 있어요");
    const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase();
    const path = `${crypto.randomUUID()}${ext}`; // 보관함에는 한글 이름 대신 번호로 저장하고, 원래 이름은 표에 남긴다
    const up = await c.storage.from("library").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (up.error) throw up.error;
    const row = {
      store_id: meta.store_id ?? null, folder: meta.folder, title: meta.title, file_name: file.name, note: meta.note ?? "", path,
      size: file.size, mime: file.type || "", audience: meta.audience, uploaded_by: p.user_id, uploaded_name: p.display_name ?? "",
    };
    // 한국어 단독 문서(lang 'ko'·원본 연결 없음)는 예전과 똑같이 새 열을 보내지 않는다 → library2.sql 을 아직 안 돌린 서버에서도 올리기가 된다
    const lg = meta.lang || "ko", usedNew = lg !== "ko" || !!meta.doc_id;
    if (usedNew) { row.lang = lg; if (meta.doc_id) row.doc_id = meta.doc_id; }
    const { error } = await c.from("library_files").insert(row);
    if (error) { await c.storage.from("library").remove([path]); throw this.libErr(error, usedNew); }
  },
  async libUpdate(row, patch) { // patch: {title?, lang?, doc_id?} — 올린 사람·대표만(lib_upd 정책). 언어·연결은 library2.sql 이 있어야 한다
    const { data, error } = await (await sb()).from("library_files").update(patch).eq("id", row.id).select("id");
    if (error) throw this.libErr(error, "lang" in patch || "doc_id" in patch);
    if (!data || !data.length) throw new Error("고치지 못했어요. 권한이 없거나 이미 지운 파일이에요"); // 정책에 막히면 오류 없이 0줄이 고쳐진다
  },
  async libUrl(row, download = false) { // 60초짜리 임시 주소(로그인한 사람만 만들 수 있음)
    const { data, error } = await (await sb()).storage.from("library").createSignedUrl(row.path, 60, download ? { download: row.file_name || true } : undefined);
    if (error) throw error;
    return data.signedUrl;
  },
  async libDelete(row) {
    const c = await sb();
    const r = await c.storage.from("library").remove([row.path]); if (r.error) throw r.error;
    const { error } = await c.from("library_files").delete().eq("id", row.id); if (error) throw error;
  },
  // 건의함: 직원은 보내기만, 읽기·처리는 대표만(RLS)
  // row.attach: 붙일 파일(File) 배열(선택, 5개까지). opts.onProgress: 올리는 진행 알림
  async sgSend(row, opts = {}) {
    const p = await this.getProfile();
    const base = { store_id: p.store_id ?? null, author_id: p.user_id, author_name: p.display_name ?? "", anon: !!row.anon, category: row.category, body: row.body };
    const files = Array.isArray(row.attach) ? row.attach : [];
    if (files.length) return sgSendFiles(await sb(), p, base, files, opts);
    // 첨부가 없으면 예전과 똑같이: files 열을 보내지 않는다(suggestions-files.sql 을 아직 안 돌린 서버에서도 된다)
    const { error } = await (await sb()).from("suggestions").insert(base);
    if (error) throw error;
  },
  async sgList() {
    const { data, error } = await (await sb()).from("suggestions").select("*, stores(display_name,name)").order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return data;
  },
  async sgSet(id, patch) { const { error } = await (await sb()).from("suggestions").update(patch).eq("id", id); if (error) throw error; },
  // 건의를 지우면 붙은 파일도 보관함에서 지운다(파일을 못 지워도 건의 삭제는 그대로 진행하고, 남은 파일은 조용히 둔다)
  async sgDelete(id) {
    const c = await sb();
    let paths = [];
    try { // 첨부 경로를 먼저 읽어 둔다(files 열이 없는 서버면 오류가 나므로 건너뜀)
      const { data } = await c.from("suggestions").select("files").eq("id", id).maybeSingle();
      paths = sgPaths(data && data.files);
    } catch { /* 첨부 없음으로 본다 */ }
    const { error } = await c.from("suggestions").delete().eq("id", id); if (error) throw error;
    if (paths.length) { try { await c.storage.from(SG_BUCKET).remove(paths); } catch { /* 남은 파일은 조용히 둔다 */ } }
  },
  // 첨부 파일 임시 주소(만들 수 있는 건 대표뿐: 보관함 읽기 정책). 사진 보기용은 1시간짜리를 55분 기억하고, 내려받기용(opts.download = 저장할 이름)은 60초짜리를 그때그때 만든다
  async sgUrls(paths, opts) {
    const out = new Map(), now = Date.now(), fresh = !!(opts && opts.fresh);
    const want = [...new Set((paths || []).filter((x) => typeof x === "string" && x))];
    const need = [];
    for (const x of want) {
      const c = fresh ? null : sgUrlCache.get(x);
      if (c && c.exp > now) out.set(x, c.url); else need.push(x);
    }
    if (!need.length) return out;
    const bucket = (await sb()).storage.from(SG_BUCKET);
    for (let i = 0; i < need.length; i += 100) {
      const part = need.slice(i, i + 100);
      const { data, error } = await bucket.createSignedUrls(part, 3600);
      if (error) throw error;
      (data || []).forEach((d, k) => {
        if (!d || d.error) return;
        const x = d.path || part[k], u = d.signedUrl || d.signedURL;
        if (!x || !u) return;
        sgUrlCache.delete(x);
        sgUrlCache.set(x, { url: u, exp: now + SG_URL_KEEP_MS });
        out.set(x, u);
      });
    }
    for (const k of sgUrlCache.keys()) { if (sgUrlCache.size <= 600) break; sgUrlCache.delete(k); }
    return out;
  },
  async sgUrl(path, opts = {}) {
    if (opts.download) {
      const { data, error } = await (await sb()).storage.from(SG_BUCKET).createSignedUrl(path, 60, { download: opts.download === true ? true : String(opts.download) });
      if (error) throw error;
      return data.signedUrl;
    }
    return (await this.sgUrls([path], { fresh: !!opts.fresh })).get(path) ?? "";
  },
  // 공지(notices.sql + Edge Function notices). 읽기는 표(RLS)에서, 쓰기(올리기·고치기·내리기·다시 번역)는 서버 함수만 한다.
  // 서버 함수는 store_id 를 자동으로 끼워 넣는 fn() 을 쓰지 않고 직접 부른다(공지의 사업장 선택과 섞이지 않게). 오류 처리는 fn() 과 같다.
  async noticeFn(body) {
    const { data, error } = await (await sb()).functions.invoke("notices", { body });
    if (error) {
      let msg = "서버에 연결하지 못했어요", code = "network";
      try { const j = await error.context.json(); if (j?.error) { msg = j.error; code = j.code ?? "error"; } } catch { /* 기본 문구 */ }
      if (code === "network" && error.context?.status === 404) { msg = "공지 기능이 아직 준비되지 않았어요"; code = "missing"; } // 서버 함수를 아직 올리지 않은 경우
      throw Object.assign(new Error(msg), { code });
    }
    if (data?.error) throw Object.assign(new Error(data.error), { code: data.code ?? "error" });
    return data;
  },
  // 내가 볼 수 있는 공지(내린 것 제외, 최신순 100개) + 내가 확인한 시각(read_at) + 사업장 이름(store_name). 두 표를 따로 읽어 합친다
  async noticeList() {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) throw new Error("로그인이 필요해요");
    const { data, error } = await c.from("notices").select("*, stores(display_name,name)").is("removed_at", null).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const rows = data ?? [], reads = new Map();
    if (rows.length) {
      const r = await c.from("notice_reads").select("notice_id,read_at").eq("user_id", session.user.id).in("notice_id", rows.map((x) => x.id));
      if (r.error) throw r.error;
      for (const x of r.data ?? []) reads.set(x.notice_id, x.read_at);
    }
    return rows.map(({ stores, ...n }) => ({ ...n, read_at: reads.get(n.id) ?? null, store_name: stores?.display_name ?? stores?.name ?? "" }));
  },
  // 확인했어요: 내 줄 하나를 넣는다(이미 있으면 무시)
  async noticeRead(id) {
    const c = await sb();
    const { data: { session } } = await c.auth.getSession();
    if (!session) throw new Error("로그인이 필요해요");
    const { error } = await c.from("notice_reads").upsert({ notice_id: id, user_id: session.user.id }, { onConflict: "notice_id,user_id", ignoreDuplicates: true });
    if (error) throw error;
  },
  // 확인 현황(대표·부대표): {targets, confirmed:[{user_id,name,job_title,at}], pending:[{user_id,name,job_title}]}
  async noticeStatus(id) {
    const { data, error } = await (await sb()).rpc("notice_status", { p_id: id });
    if (error) throw error;
    const d = data ?? {};
    return { targets: Number(d.targets) || 0, confirmed: Array.isArray(d.confirmed) ? d.confirmed : [], pending: Array.isArray(d.pending) ? d.pending : [] };
  },
  // payload: {id?, title, body, store_id|null, important, expires_on|null, push} → {ok, notice, translated, pushed}
  noticeSave(p) {
    const body = { action: "save", title: p.title, body: p.body, store_id: p.store_id ?? null, important: !!p.important, expires_on: p.expires_on || null, push: !!p.push };
    if (p.id) body.id = p.id;
    return this.noticeFn(body);
  },
  noticeRetranslate(id) { return this.noticeFn({ action: "retranslate", id }); }, // → {ok, notice, translated}
  noticeRemove(id) { return this.noticeFn({ action: "remove", id }); }, // → {ok}
  // 회사 용어집(supabase/glossary.sql). 표 glossary_terms 를 RLS 로 직접 읽고 쓴다(대표·부대표만, 서버 함수 없음). AI 초안만 translate 함수(term 모드)를 부른다.
  // 오류는 화면이 t()로 번역해 보이는 한국어 문장 + code(dup·check·missing·forbidden)를 담아 던진다. 표가 없으면(glossary.sql 을 아직 안 돌렸으면) code = "missing"
  glErr(e) {
    const code = String(e?.code ?? ""), msg = String(e?.message ?? "");
    const mk = (m, c) => Object.assign(new Error(m), { code: c });
    if (code === "23505") return mk("이미 같은 한국어 용어가 있어요", "dup");
    if (code === "23514") return mk("글자 수 또는 쓸 수 없는 글자(< >, 줄바꿈)를 확인해 주세요", "check");
    if (code === "42P01" || code === "PGRST205" || (/glossary_terms/.test(msg) && /does not exist|schema cache/i.test(msg))) return mk("용어집이 아직 준비되지 않았어요", "missing");
    if (code === "42501" || /row-level security/i.test(msg)) return mk("용어집을 쓸 권한이 없어요", "forbidden");
    return e instanceof Error ? e : mk(msg || "처리하지 못했어요", "error");
  },
  // 서버 순서(항상 넣기 → sort → 한국어)로 전부. 이 순서가 합성 글(ai_config.glossary)의 순서와 같아서 화면의 "N개 중 M개가 쓰여요" 계산이 맞는다
  async glList() {
    const { data, error } = await (await sb()).from("glossary_terms").select("*")
      .order("pinned", { ascending: false }).order("sort", { ascending: true }).order("ko", { ascending: true }).limit(1000);
    if (error) throw this.glErr(error);
    return data ?? [];
  },
  // term: {id?, ko, vi, en, note, aliases, keep_ko, pinned, verified, sort} — id 가 있으면 보낸 칸만 고치고, 없으면 새로 넣는다. 고친 사람·시각은 서버가 찍는다 → 저장된 줄
  async glSave(term) {
    const f = glFields(term), c = await sb();
    if (term?.id) {
      const { data, error } = await c.from("glossary_terms").update(f).eq("id", term.id).select();
      if (error) throw this.glErr(error);
      if (!data?.length) throw new Error("용어를 저장하지 못했어요. 권한이나 삭제 여부를 확인해 주세요"); // 정책이 막으면 오류 없이 0줄
      return data[0];
    }
    if (!f.ko) throw new Error("한국어 용어를 적어 주세요");
    const { data, error } = await c.from("glossary_terms").insert(f).select().single();
    if (error) throw this.glErr(error);
    return data;
  },
  // 여러 용어를 한 번에 새로 넣는다(여러 줄 붙여넣기·사업장 이름 불러오기). 같은 한국어가 이미 있으면 그 줄만 건너뜀 → {added, skipped}
  async glAddMany(terms) {
    const full = { vi: "", en: "", note: "", aliases: "", keep_ko: false, pinned: false, verified: false, sort: 0 }; // 한꺼번에 넣을 때는 모든 줄의 칸이 같아야 한다
    const list = (terms ?? []).map(glFields).filter((f) => f.ko).map((f) => ({ ...full, ...f }));
    if (!list.length) return { added: 0, skipped: 0 };
    const c = await sb();
    const first = await c.from("glossary_terms").insert(list).select("id");
    if (!first.error) return { added: first.data?.length ?? list.length, skipped: 0 };
    if (String(first.error.code) !== "23505") throw this.glErr(first.error);
    let added = 0, skipped = 0; // 그 사이 다른 곳에서 같은 용어가 먼저 들어갔다: 한 줄씩 다시 넣고 겹친 것만 건너뛴다
    for (const f of list) {
      const r = await c.from("glossary_terms").insert(f).select("id");
      if (!r.error) added++;
      else if (String(r.error.code) === "23505") skipped++;
      else throw this.glErr(r.error);
    }
    return { added, skipped };
  },
  async glDelete(id) {
    const { data, error } = await (await sb()).from("glossary_terms").delete().eq("id", id).select("id");
    if (error) throw this.glErr(error);
    if (!data?.length) throw new Error("용어를 지우지 못했어요. 권한을 확인해 주세요");
  },
  // 사업장 이름 불러오기: stores 의 이름을 번역하지 않는 '항상 넣기' 용어로 넣는다(이미 있는 이름은 건너뜀) → {added, skipped}
  async glImportStores() {
    const [stores, have] = await Promise.all([this.listStores(), this.glList()]);
    const { add, skipped } = glStoreTerms(stores, have);
    const r = add.length ? await this.glAddMany(add) : { added: 0, skipped: 0 };
    return { added: r.added, skipped: skipped + r.skipped };
  },
  // AI 초안: terms = [{key, ko, vi, en}] 중 비어 있는 vi·en 칸만 translate 함수(mode "term", 대표 토큰)로 번역한다.
  // fn() 은 store_id 를 끼워 넣으므로 쓰지 않고 직접 부른다(요청 모양은 translate 함수 그대로). 직접 적은 칸은 건드리지 않는다.
  // → {filled: {key: {vi?, en?}}, failed: [key]}. 하나도 못 채웠으면 이유를 담아 던진다. onProgress(done, total) 은 묶음이 끝날 때마다
  async glDraft(terms, onProgress) {
    const todo = (terms ?? []).map((x) => ({ key: String(x.key), ko: String(x.ko ?? "").trim(), vi: String(x.vi ?? "").trim(), en: String(x.en ?? "").trim() }))
      .filter((x) => x.ko && Array.from(x.ko).length <= 80 && (!x.vi || !x.en));
    const filled = {}, failed = [];
    if (!todo.length) return { filled, failed };
    const c = await sb();
    let reason = "", fatal = false, done = 0;
    for (let i = 0; i < todo.length && !fatal; i += GL_BATCH) {
      const batch = todo.slice(i, i + GL_BATCH);
      const fields = {};
      batch.forEach((x, j) => { fields["t" + j] = x.ko; });
      const targets = ["vi", "en"].filter((lg) => batch.some((x) => !x[lg]));
      let res = null;
      try {
        const { data, error } = await c.functions.invoke("translate", { body: { mode: "term", src: "ko", targets, fields, budget_ms: 30000 } });
        if (error) {
          const st = error.context?.status;
          reason = st === 404 ? "missing" : st === 401 || st === 403 ? "forbidden" : "api_error";
          fatal = reason === "missing" || reason === "forbidden"; // 함수가 없거나 권한이 없으면 다음 묶음도 같다
        } else res = data;
      } catch { reason = "api_error"; }
      if (res?.ok) {
        batch.forEach((x, j) => {
          for (const lg of targets) {
            const v = x[lg] ? "" : glClean(res.tr?.[lg]?.["t" + j]);
            if (v) (filled[x.key] ??= {})[lg] = v;
          }
          if (!filled[x.key]) failed.push(x.key);
        });
      } else {
        if (res && !reason) reason = String(res.reason || "api_error");
        batch.forEach((x) => failed.push(x.key));
      }
      done += batch.length;
      try { onProgress?.(done, todo.length); } catch { /* 화면 쪽 문제는 무시 */ }
    }
    if (!Object.keys(filled).length) throw new Error(GL_REASON[reason] ?? "AI 초안을 만들지 못했어요");
    return { filled, failed };
  },
  // 업무 기록(일지·일정·기록함): table = work_logs | work_events | work_notes. 보이는 범위는 서버(RLS)가 정한다.
  async wkList(table, all = false) { // all=true: 사업장 구분 없이 전체(대표·부대표 보고판용)
    let q = (await sb()).from(table).select("*");
    if (!all) q = q.eq("store_id", await this.storeId());
    const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    return data;
  },
  async wkSave(table, row) {
    const c = await sb();
    if (row.id) { const { id, ...rest } = row; const { error } = await c.from(table).update(rest).eq("id", id); if (error) throw error; return; }
    const p = await this.getProfile();
    const { error } = await c.from(table).insert({ ...row, store_id: await this.storeId(), author_id: p.user_id, author_name: p.display_name ?? "" });
    if (error) throw error;
  },
  async wkDelete(table, id) { const { error } = await (await sb()).from(table).delete().eq("id", id); if (error) throw error; },
  pushEnabled() { return !!LS.get("woo_push_on", false) && typeof Notification !== "undefined" && Notification.permission === "granted"; },
};

export const api = isDemo ? demo : remote;
