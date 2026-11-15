// en 번역 사전 모음(src/i18n/parts/*.js 를 합친다). 화면이 처음 en 로 바뀔 때만 불러온다.
import core from "./parts/core.js";
import attendance from "./parts/attendance.js";
import tasks from "./parts/tasks.js";
import checklist from "./parts/checklist.js";
import claims from "./parts/claims.js";
import suggest from "./parts/suggest.js";
import library from "./parts/library.js";
export default { ...core.en, ...attendance.en, ...tasks.en, ...checklist.en, ...claims.en, ...suggest.en, ...library.en };
