/**
 * image-extract-handler.js
 * ========================
 * Đọc thông tin từ ảnh giấy tờ bằng AI (OpenAI Vision) rồi trả về JSON
 * khớp đúng id các trường trên Master Form.
 *
 * 5 ô ảnh (slot) đầu vào:
 *   device   → Màn hình "Thông tin thiết bị" (app)  → serial_number
 *   cccd_front → CCCD chủ tàu mặt trước             → owner_* (tên, số, ngày sinh, giới tính)
 *   cccd_back  → CCCD chủ tàu mặt sau               → issue_date + địa chỉ
 *   ship       → Giấy chứng nhận đăng ký tàu cá     → thông số tàu + tên chủ tàu (để so khớp)
 *   captain    → Chứng chỉ thuyền trưởng HOẶC CCCD  → captain_*
 *   fishing_license → Giấy phép khai thác thủy sản  → so_di_dong (chỉ lấy SĐT nếu có)
 *
 * Logic thuyền trưởng: so tên trên ảnh `captain` với tên chủ tàu (ảnh `ship`).
 *   - Trùng  → captain_is_owner = true  (frontend sẽ copy chủ tàu sang thuyền trưởng)
 *   - Khác   → captain_is_owner = false (điền mục thuyền trưởng từ ảnh captain)
 *
 * MOCK mode: đặt IMAGE_EXTRACT_MOCK=true trong .env → KHÔNG gọi OpenAI,
 * trả về fixture cố định (dựng từ đúng 5 ảnh mẫu) để test UI miễn phí.
 *
 * Mã tham chiếu (lấy từ data/mapping.json — nguồn sự thật):
 *   vessel_owner_gender / captain_gender: "T"=Nam, "G"=Nữ, "U"=Không xác định
 *   owner_loai_ma_so: 1=CMND(9 số), 2=CCCD(12 số), 3=Mã định danh, 4=Mã doanh nghiệp
 */

"use strict";

const fs = require("fs");
const path = require("path");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-5-mini";

// ─────────────────────────────────────────────────────────────────────────────
// Định nghĩa slot: docType + mô tả để dựng prompt
// ─────────────────────────────────────────────────────────────────────────────
const SLOT_DEFS = {
  device: "Ảnh THIẾT BỊ giám sát — có thể là (a) ảnh chụp màn hình 'THÔNG TIN THIẾT BỊ' của app: dòng 'Tên:' là serial_number; HOẶC (b) ảnh chụp TEM/NHÃN dán trên thiết bị: dòng 'S/N:' (Serial Number) là serial_number. Serial thường bắt đầu bằng 'MTR' và dài 16 ký tự.",
  cccd_front:
    "CCCD/Căn cước mặt TRƯỚC của CHỦ TÀU: số định danh cá nhân, họ tên, ngày sinh, giới tính, quốc tịch.",
  cccd_back:
    "CCCD/Căn cước mặt SAU của CHỦ TÀU: nơi cư trú (thôn/xã/tỉnh), ngày cấp, cơ quan cấp.",
  ship:
    "GIẤY CHỨNG NHẬN ĐĂNG KÝ TÀU CÁ: số đăng ký, tên/địa chỉ chủ tàu, các thông số kỹ thuật của tàu.",
  captain:
    "Giấy tờ của THUYỀN TRƯỞNG — có thể là 'Chứng chỉ thuyền trưởng tàu cá' (chỉ có tên, năm sinh, số CMND, nơi sinh) HOẶC CCCD của thuyền trưởng (đầy đủ thông tin).",
  fishing_license:
    "GIẤY PHÉP KHAI THÁC THỦY SẢN. CHỈ dùng để lấy số điện thoại ở dòng 'Điện thoại (nếu có):' → điền vào so_di_dong. Bỏ qua mọi thông tin khác trên giấy này.",
};

// Danh sách field id hợp lệ trên form — chỉ nhận đúng các key này về frontend.
const ALLOWED_FIELDS = [
  // Tàu
  "serial_number",
  "ship_code",
  "bien_so_tau",
  "chieu_dai_toan_bo",
  "chieu_dai_thiet_ke",
  "chieu_rong",
  "mon_nuoc",
  "tong_tai_trong",
  "dung_tich_ham_ca",
  "cong_suat",
  "ma_cang",
  "ma_nganh_nghe",
  "so_di_dong",
  // Chủ tàu
  "owner_name",
  "owner_cccd",
  "owner_loai_ma_so",
  "owner_birthday",
  "vessel_owner_gender",
  "issue_date",
  "issue_place",
  "owner_address_province",
  "owner_address_district",
  "owner_address_precinct",
  "owner_address_group_street",
  "owner_address_road",
  // Thuyền trưởng
  "captain_name",
  "captain_phone",
  "captain_cccd",
  "captain_birthday",
  "captain_gender",
  "captain_address",
];

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT — mô tả nhiệm vụ + quy tắc + schema JSON đầu ra
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  return [
    "Bạn là trợ lý trích xuất dữ liệu từ ảnh giấy tờ Việt Nam cho một form đăng ký tàu cá.",
    "Người dùng gửi tối đa 5 ảnh, mỗi ảnh kèm nhãn slot. Hãy đọc và trả về JSON DUY NHẤT.",
    "",
    "QUY TẮC BẮT BUỘC:",
    "1. CHỈ điền giá trị đọc được rõ ràng trên ảnh. KHÔNG suy đoán, KHÔNG bịa. Không đọc được → bỏ trống (đừng thêm key).",
    "2. Ngày tháng: định dạng dd/mm/yyyy. Nếu ngày sinh CHỈ có năm (vd chứng chỉ ghi '1980'), điền '01/01/1980' (mặc định ngày 01 tháng 01).",
    "3. Giới tính: quy về mã 1 ký tự — 'T'=Nam, 'G'=Nữ, 'U'=không xác định.",
    "4. owner_loai_ma_so theo độ dài số giấy tờ: 9 chữ số → '1' (CMND); 12 chữ số → '2' (CCCD).",
    "5. Số công suất/kích thước: chỉ lấy phần SỐ (vd '630CV' → '630', '65.06 TĐK' → '65.06'). Giữ nguyên dấu chấm thập phân.",
    "6. serial_number: lấy từ dòng 'Tên:' (ảnh chụp màn hình app) HOẶC dòng 'S/N:'/'Serial' trên tem dán thiết bị (ảnh slot 'device'). Serial thường dạng 'MTR...' dài 16 ký tự — lấy ĐÚNG chuỗi mã, bỏ khoảng trắng. Vd tem ghi 'S/N: MTR032026D005583' → serial_number = 'MTR032026D005583'.",
    "7. Số đăng ký tàu (vd 'QNg-97280-TS') điền vào CẢ ship_code VÀ bien_so_tau.",
    "8. Địa chỉ chủ tàu: ƯU TIÊN đọc từ CCCD (mặt sau) vì mới nhất. Tách:",
    "   owner_address_province = tỉnh/thành; owner_address_precinct = phường/xã;",
    "   owner_address_group_street = thôn/tổ/khu phố; owner_address_district = quận/huyện (CCCD mới thường KHÔNG có → để trống).",
    "9. XÁC ĐỊNH THUYỀN TRƯỞNG: so tên trên ảnh 'captain' với tên chủ tàu (ảnh 'ship'/CCCD).",
    "   - Cùng một người  → captain_is_owner = true, và ĐỂ TRỐNG toàn bộ captain_* (form sẽ tự copy).",
    "   - Khác người      → captain_is_owner = false, điền captain_* từ ảnh 'captain'.",
    "10. Nếu ảnh 'captain' là CHỨNG CHỈ (không có địa chỉ đầy đủ): lấy 'Nơi sinh' làm captain_address.",
    "11. SỐ ĐIỆN THOẠI: từ ảnh 'fishing_license' (Giấy phép khai thác thủy sản), đọc dòng 'Điện thoại (nếu có):' → so_di_dong.",
    "    Chỉ giữ CHỮ SỐ, bỏ dấu chấm/khoảng trắng (vd '0834.320.627' → '0834320627'). Nếu KHÔNG có số điện thoại thì BỎ QUA, đừng thêm so_di_dong.",
    "12. NGHỀ CHÍNH: từ ảnh 'fishing_license', đọc dòng 'Nghề chính:' → ma_nganh_nghe. Điền ĐÚNG TÊN nghề như trên giấy (vd 'Lưới vây'), KHÔNG phải mã, KHÔNG thêm chữ 'Nghề'. Hệ thống tự khớp sang mã sau.",
    "",
    "ÁNH XẠ TỪ GIẤY ĐĂNG KÝ TÀU CÁ → field:",
    "  'Chiều dài Lmax' → chieu_dai_toan_bo; 'Chiều dài Ltk' → chieu_dai_thiet_ke;",
    "  'Chiều rộng Bmax' → chieu_rong; 'Chiều chìm d' → mon_nuoc;",
    "  'Tổng dung tích / Gross Tonnage' → dung_tich_ham_ca; 'Tổng công suất' → cong_suat.",
    "  'Trọng tải toàn phần / Deadweight' → tong_tai_trong (dòng này THƯỜNG TRỐNG → nếu không có số thì BỎ QUA, KHÔNG lấy Tổng dung tích thay vào).",
    "  'Cảng đăng ký / Port registry' → ma_cang: điền ĐÚNG TÊN cảng như trên giấy (vd 'Cổ Lũy'), KHÔNG phải mã. Người dùng sẽ chọn mã từ gợi ý sau.",
    "  (KHÔNG map: chiều cao mạn D, chiều rộng Btk, vật liệu — form không có ô.)",
    "  KHÔNG tự điền tinh_thanh (cần mã nội bộ Viettel, không có trên giấy).",
    "",
    "ĐỊNH DẠNG ĐẦU RA (JSON, không kèm giải thích ngoài JSON):",
    "{",
    '  "fields": { "<field_id>": "<giá trị chuỗi>", ... },',
    '  "captain_is_owner": true | false,',
    '  "notes": ["cảnh báo/điểm cần người dùng kiểm tra", ...]',
    "}",
    "QUAN TRỌNG: TẤT CẢ nội dung trong 'notes' PHẢI viết bằng TIẾNG VIỆT (không dùng tiếng Anh).",
    "Chỉ dùng các field_id sau: " + ALLOWED_FIELDS.join(", ") + ".",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function mimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg"; // .jpg/.jpeg và mặc định
}

function fileToDataUri(p) {
  const buf = fs.readFileSync(p);
  return `data:${mimeFromPath(p)};base64,${buf.toString("base64")}`;
}

function isPdf(p) {
  return path.extname(p).toLowerCase() === ".pdf";
}

// Dựng content part cho OpenAI theo loại file: PDF → type "file"; ảnh → "image_url".
function slotContentPart(p) {
  if (isPdf(p)) {
    const b64 = fs.readFileSync(p).toString("base64");
    return {
      type: "file",
      file: {
        filename: path.basename(p),
        file_data: `data:application/pdf;base64,${b64}`,
      },
    };
  }
  return { type: "image_url", image_url: { url: fileToDataUri(p) } };
}

// Chỉ giữ các field id hợp lệ + giá trị chuỗi non-empty
function sanitizeFields(rawFields) {
  const out = {};
  if (!rawFields || typeof rawFields !== "object") return out;
  for (const key of ALLOWED_FIELDS) {
    const v = rawFields[key];
    if (v === undefined || v === null) continue;
    let s = String(v).trim();
    // Số điện thoại: chỉ giữ chữ số (0834.320.627 → 0834320627)
    if (key === "so_di_dong") s = s.replace(/\D/g, "");
    // Ngày sinh chỉ có năm → 01/01/YYYY (vd '1980' → '01/01/1980')
    if (key === "owner_birthday" || key === "captain_birthday") {
      if (/^\d{4}$/.test(s)) s = `01/01/${s}`;
    }
    if (s !== "") out[key] = s;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK — fixture dựng từ đúng 5 ảnh mẫu người dùng cung cấp
// ─────────────────────────────────────────────────────────────────────────────
function mockResult(slots) {
  const fields = {
    // device
    serial_number: "MTR032025K004065",
    // ship
    ship_code: "QNg-97280-TS",
    bien_so_tau: "QNg-97280-TS",
    chieu_dai_toan_bo: "20.50",
    chieu_dai_thiet_ke: "17.17",
    chieu_rong: "5.60",
    mon_nuoc: "1.98",
    dung_tich_ham_ca: "65.06",
    cong_suat: "630",
    ma_cang: "Cổ Lũy",
    // fishing_license → số di động tàu + nghề chính
    so_di_dong: "0834320627",
    ma_nganh_nghe: "Lưới vây",
    // owner (CCCD)
    owner_name: "TRẦN QUANG NINH",
    owner_cccd: "051066002528",
    owner_loai_ma_so: "2",
    owner_birthday: "01/01/1966",
    vessel_owner_gender: "T",
    issue_date: "15/01/2026",
    owner_address_province: "Quảng Ngãi",
    owner_address_precinct: "An Phú",
    owner_address_group_street: "Thôn Cổ Lũy Nam",
    // captain (chứng chỉ Phạm Sáng — khác chủ tàu)
    captain_name: "PHẠM SÁNG",
    captain_cccd: "051080003287",
    captain_birthday: "01/01/1980",
    captain_address: "Quảng Ngãi",
  };

  const presentSlots = new Set((slots || []).map((s) => s.key));
  // Chỉ trả về field tương ứng với các slot thực sự được tải lên
  const slotFieldGroups = {
    device: ["serial_number"],
    ship: [
      "ship_code",
      "bien_so_tau",
      "chieu_dai_toan_bo",
      "chieu_dai_thiet_ke",
      "chieu_rong",
      "mon_nuoc",
      "dung_tich_ham_ca",
      "cong_suat",
      "ma_cang",
    ],
    cccd_front: [
      "owner_name",
      "owner_cccd",
      "owner_loai_ma_so",
      "owner_birthday",
      "vessel_owner_gender",
    ],
    cccd_back: [
      "issue_date",
      "owner_address_province",
      "owner_address_precinct",
      "owner_address_group_street",
    ],
    captain: ["captain_name", "captain_cccd", "captain_birthday", "captain_address"],
    fishing_license: ["so_di_dong", "ma_nganh_nghe"],
  };

  const filtered = {};
  for (const [slot, keys] of Object.entries(slotFieldGroups)) {
    if (!presentSlots.has(slot)) continue;
    keys.forEach((k) => {
      if (fields[k] !== undefined) filtered[k] = fields[k];
    });
  }

  const notes = [
    "🧪 MOCK MODE — dữ liệu mẫu cố định, KHÔNG gọi OpenAI (không tốn phí).",
  ];
  if (presentSlots.has("captain")) {
    notes.push(
      "Thuyền trưởng (Phạm Sáng) KHÁC chủ tàu (Trần Quang Ninh) → điền riêng."
    );
    notes.push("Chứng chỉ chỉ ghi năm sinh 1980 → tự điền 01/01/1980.");
  }
  if (presentSlots.has("cccd_back")) {
    notes.push("Địa chỉ CCCD mới không có Quận/Huyện → ô Quận/Huyện để trống, vui lòng kiểm tra.");
  }
  if (presentSlots.has("ship")) {
    notes.push("Mã cảng: điền tên 'Cổ Lũy' và tự chọn mã (CLU) nếu khớp; nếu không khớp thì chọn tay trong gợi ý.");
  }
  if (presentSlots.has("fishing_license")) {
    notes.push("Mã ngành nghề: đọc 'Nghề chính' → tự khớp option 'Nghề <tên>' (vd 'Lưới vây' → 'Nghề lưới vây' = SX).");
  }

  return {
    success: true,
    mock: true,
    model: "mock",
    fields: sanitizeFields(filtered),
    captain_is_owner: presentSlots.has("captain") ? false : null,
    notes,
    usage: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gọi OpenAI Vision thật
// ─────────────────────────────────────────────────────────────────────────────
async function callOpenAI(slots, apiKey, model) {
  const content = [
    {
      type: "text",
      text:
        "Dưới đây là các ảnh giấy tờ. Mỗi ảnh có nhãn slot ở dòng ngay trước nó. " +
        "Hãy trích xuất và trả JSON theo đúng quy tắc.",
    },
  ];

  for (const slot of slots) {
    content.push({
      type: "text",
      text: `--- SLOT: ${slot.key} — ${SLOT_DEFS[slot.key] || ""}`,
    });
    content.push(slotContentPart(slot.path));
  }

  const body = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let resp;
  try {
    resp = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `OpenAI HTTP ${resp.status}`;
    throw new Error(msg);
  }

  const raw = data?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Không parse được JSON từ AI. Nội dung: " + raw.slice(0, 300));
  }

  return {
    success: true,
    mock: false,
    model,
    fields: sanitizeFields(parsed.fields),
    captain_is_owner:
      typeof parsed.captain_is_owner === "boolean"
        ? parsed.captain_is_owner
        : null,
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    usage: data?.usage || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API chính
// slots: [{ key: 'device'|'cccd_front'|..., path: '/tmp/xxx.jpg' }]
// ─────────────────────────────────────────────────────────────────────────────
async function extractFromImages(slots) {
  const started = Date.now();
  const valid = (slots || []).filter(
    (s) => s && SLOT_DEFS[s.key] && s.path && fs.existsSync(s.path)
  );

  if (valid.length === 0) {
    return {
      success: false,
      error: "Chưa có ảnh hợp lệ nào để đọc.",
      fields: {},
      notes: [],
    };
  }

  const isMock = String(process.env.IMAGE_EXTRACT_MOCK || "").toLowerCase() === "true";

  try {
    let result;
    if (isMock) {
      console.log(
        `🧪 [image-extract] MOCK MODE — ${valid.length} ảnh (${valid
          .map((s) => s.key)
          .join(", ")}) — không gọi OpenAI.`
      );
      result = mockResult(valid);
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          success: false,
          error:
            "Thiếu OPENAI_API_KEY trong .env. Bật IMAGE_EXTRACT_MOCK=true để test miễn phí, hoặc thêm key để chạy thật.",
          fields: {},
          notes: [],
        };
      }
      const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
      console.log(
        `🤖 [image-extract] Gọi ${model} — ${valid.length} ảnh (${valid
          .map((s) => s.key)
          .join(", ")}).`
      );
      result = await callOpenAI(valid, apiKey, model);
      if (result.usage) {
        console.log(
          `   📊 Tokens: prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens} total=${result.usage.total_tokens}`
        );
      }
    }

    // Suy ra: SĐT thuyền trưởng lấy theo Số di động tàu (khi thuyền trưởng KHÁC chủ tàu;
    // nếu là chủ tàu thì frontend tự copy owner_phone sang captain_phone).
    if (
      result.fields &&
      result.fields.so_di_dong &&
      result.captain_is_owner !== true
    ) {
      result.fields.captain_phone = result.fields.so_di_dong;
    }

    result.duration_ms = Date.now() - started;
    console.log(
      `   ✅ [image-extract] Đọc xong ${Object.keys(result.fields).length} trường (${(
        result.duration_ms / 1000
      ).toFixed(1)}s)${result.mock ? " [MOCK]" : ""}.`
    );
    return result;
  } catch (err) {
    console.error(`❌ [image-extract] Lỗi: ${err.message}`);
    return {
      success: false,
      error: err.message,
      fields: {},
      notes: [],
      duration_ms: Date.now() - started,
    };
  }
}

module.exports = { extractFromImages, SLOT_DEFS, ALLOWED_FIELDS };
