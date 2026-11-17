// 번역 사전: 업무지시 번역·안전 표시(자동 번역 배지·원문 보기·안전 업무·안전 되묻기·다시 번역). 키 = 화면에 쓰는 한국어 문장 그대로, 값 = 번역. {이름} 자리 표시는 번역에도 똑같이 남긴다.
// 쓰는 곳: src/lib/tr.js · src/screens/tasks.js · tasks-admin.js · ai-task.js.  "자동 번역"·"한국어 원문"·"원문 보기"·"번역 보기"·"다시 번역"·"번역 없음"·"번역했어요"는 notices 사전에 이미 있어 다시 쓰지 않는다.
// ※ 베트남어·영어는 초안이다. 베트남어를 읽을 수 있는 사람이 확인한 뒤 확정한다. 특히 안전 안내 문구는 사람이 꼭 확인해야 한다(기획/번역_원어민확인목록_2단계.md).
export default {
  vi: {
    // 직원 화면·공용 배지
    "⚠ 안전 업무": "⚠ Công việc an toàn",
    "안전 업무예요. 한국어 원문만 있어요. 관리자에게 물어보세요": "Đây là công việc về an toàn. Chỉ có bản gốc tiếng Hàn. Hãy hỏi quản lý.",
    "원문": "Bản gốc",
    // 관리자: 완료 메모 번역·다시 번역
    "번역하지 못했어요": "Chưa dịch được",
    "번역하는 중…": "Đang dịch…",
    // 안전 되묻기 창
    "안전과 관련된 내용 같아요": "Có vẻ nội dung này liên quan đến an toàn",
    "들어 있는 말: {words}": "Từ khóa phát hiện: {words}",
    "안전 관련으로 보내면 번역하지 않고 한국어 원문만 가요. 번역해서 보내면 기계 번역이라 틀릴 수 있어요.": "Nếu gửi dưới dạng an toàn, nội dung sẽ không được dịch và chỉ có bản gốc tiếng Hàn. Nếu gửi kèm bản dịch, đó là bản dịch tự động nên có thể sai.",
    "안전 관련으로 보내기": "Gửi dưới dạng an toàn",
    "아니요, 번역해서 보내기": "Không, gửi kèm bản dịch",
    // 지시 폼·AI지시 카드
    "안전 관련 (자동 번역 안 함)": "Liên quan đến an toàn (không dịch tự động)",
    "락스 희석 비율·보관 온도처럼 틀리면 위험한 내용이면 켜 주세요. 번역하지 않고 한국어로만 보내요.": "Hãy bật nếu nội dung nguy hiểm khi sai, như tỷ lệ pha loãng thuốc tẩy hoặc nhiệt độ bảo quản. Sẽ không dịch và chỉ gửi bằng tiếng Hàn.",
    "지시하는 중… ({i}/{n})": "Đang giao việc… ({i}/{n})",
    "{n}명에게는 지시됐고, 나머지는 보내지 못했어요. 목록을 확인해 주세요": "Đã giao cho {n} người, những người còn lại chưa gửi được. Vui lòng kiểm tra danh sách.",
    "안전 관련: 번역하지 않고 한국어로만 보내요": "An toàn: không dịch, chỉ gửi bằng tiếng Hàn",
    "안전 관련으로 보냈어요 (번역 없이 한국어로만 가요)": "Đã gửi dưới dạng an toàn (không dịch, chỉ bằng tiếng Hàn)",
    "안전 관련인지 확인하지 않아 보내지 않았어요": "Chưa xác nhận có liên quan đến an toàn hay không nên chưa gửi",
  },
  en: {
    // 직원 화면·공용 배지
    "⚠ 안전 업무": "⚠ Safety task",
    "안전 업무예요. 한국어 원문만 있어요. 관리자에게 물어보세요": "This is a safety task. Only the Korean original is available. Please ask your manager.",
    "원문": "Original",
    // 관리자: 완료 메모 번역·다시 번역
    "번역하지 못했어요": "Couldn't translate",
    "번역하는 중…": "Translating…",
    // 안전 되묻기 창
    "안전과 관련된 내용 같아요": "This looks safety-related",
    "들어 있는 말: {words}": "Words found: {words}",
    "안전 관련으로 보내면 번역하지 않고 한국어 원문만 가요. 번역해서 보내면 기계 번역이라 틀릴 수 있어요.": "If you send it as safety-related, it won't be translated and only the Korean original is sent. If you send it translated, it's a machine translation and may be wrong.",
    "안전 관련으로 보내기": "Send as safety-related",
    "아니요, 번역해서 보내기": "No, send with translation",
    // 지시 폼·AI지시 카드
    "안전 관련 (자동 번역 안 함)": "Safety-related (no auto-translation)",
    "락스 희석 비율·보관 온도처럼 틀리면 위험한 내용이면 켜 주세요. 번역하지 않고 한국어로만 보내요.": "Turn on if a mistake would be dangerous, such as bleach dilution ratios or storage temperatures. It won't be translated and is sent in Korean only.",
    "지시하는 중… ({i}/{n})": "Assigning… ({i}/{n})",
    "{n}명에게는 지시됐고, 나머지는 보내지 못했어요. 목록을 확인해 주세요": "Assigned to {n}, but the rest couldn't be sent. Please check the list.",
    "안전 관련: 번역하지 않고 한국어로만 보내요": "Safety-related: not translated, sent in Korean only",
    "안전 관련으로 보냈어요 (번역 없이 한국어로만 가요)": "Sent as safety-related (not translated, Korean only)",
    "안전 관련인지 확인하지 않아 보내지 않았어요": "Not sent because the safety question wasn't confirmed",
  },
};
