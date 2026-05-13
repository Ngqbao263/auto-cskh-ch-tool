/**
 * transforms.js
 * =============
 * Thư viện các hàm biến đổi dữ liệu (pure functions).
 * Mỗi hàm nhận (value, options?) và trả về string/number đã được transform.
 *
 * Cách dùng từ engine:
 *   const { applyTransform } = require('./transforms');
 *   const result = applyTransform('0901234567', 'phone_vn');
 *   const result = applyTransform('2026-05-12', 'format_date', { outputFormat: 'DD/MM/YYYY' });
 */

"use strict";

const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(customParseFormat);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS (nội bộ, không export)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse ngày từ nhiều định dạng đầu vào khác nhau về dayjs object.
 * Hỗ trợ: ISO 8601, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, Date object, timestamp.
 */
function parseDate(value) {
  if (!value) throw new Error(`[transforms] parseDate: giá trị rỗng.`);

  // Nếu đã là Date object
  if (value instanceof Date) return dayjs(value);

  const strValue = String(value).trim();

  // Thử từng format tường minh theo thứ tự ưu tiên (strict mode).
  // QUAN TRỌNG: Phải thử DD/MM/YYYY TRƯỚC khi dùng dayjs() mặc định,
  // vì dayjs('12/05/2026') hiểu là MM/DD/YYYY → cho ra tháng 12, sai!
  const FORMATS_TO_TRY = [
    "YYYY-MM-DD", // ISO: 2026-05-12 (rõ ràng nhất, thử trước)
    "YYYY-MM-DDTHH:mm:ss", // ISO với giờ
    "YYYY/MM/DD",
    "DD/MM/YYYY", // VN:  12/05/2026  ← phải strict để không nhầm MM/DD
    "DD-MM-YYYY",
    "MM/DD/YYYY", // US:  05/12/2026  ← để cuối vì dễ nhầm với DD/MM
  ];

  let parsed;

  // Thử từng format tường minh với strict = true
  for (const fmt of FORMATS_TO_TRY) {
    parsed = dayjs(strValue, fmt, true);
    if (parsed.isValid()) return parsed;
  }

  // Fallback cuối cùng: dayjs tự đoán (chỉ cho ISO-like strings)
  parsed = dayjs(strValue);
  if (parsed.isValid()) return parsed;

  throw new Error(
    `[transforms] parseDate: Không thể parse ngày từ giá trị "${strValue}"`
  );
}

/**
 * Chuẩn hóa format pattern: dayjs dùng 'DD/MM/YYYY', không phải strftime.
 */
function applyDateFormat(dayjsObj, outputFormat) {
  return dayjsObj.format(outputFormat || "DD/MM/YYYY");
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORM FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

const transforms = {
  /**
   * none
   * Giữ nguyên giá trị, ép sang string để an toàn khi fill vào input.
   */
  none(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  },

  /**
   * to_string
   * Chuyển number/boolean/bất kỳ kiểu nào sang string thuần.
   * Dùng cho các input type="number" cần page.fill() (nhận string).
   */
  to_string(value) {
    if (value === null || value === undefined) return "";
    return String(value);
  },

  /**
   * uppercase
   * Chuyển toàn bộ chuỗi sang CHỮ HOA.
   */
  uppercase(value) {
    if (!value) return "";
    return String(value).toUpperCase();
  },

  /**
   * phone_vn
   * Chuẩn hóa số điện thoại Việt Nam về dạng 10 chữ số, bắt đầu bằng "0".
   * Xử lý các format đầu vào: +84xxxxxxxxx, 84xxxxxxxxx, 0xxxxxxxxx, xxxxxxxxx
   */
  phone_vn(value) {
    if (!value) return "";
    // Chỉ giữ lại chữ số
    const digits = String(value).replace(/\D/g, "");

    // +84 hoặc 84 ở đầu → thay bằng 0
    if (digits.startsWith("84") && digits.length === 11) {
      return "0" + digits.slice(2);
    }
    // Đã đủ 10 số bắt đầu bằng 0
    if (digits.startsWith("0") && digits.length === 10) {
      return digits;
    }
    // 9 số không có đầu số → thêm 0 vào đầu
    if (!digits.startsWith("0") && digits.length === 9) {
      return "0" + digits;
    }

    // Trả về nguyên bản nếu không match (log warning ở applyTransform)
    return digits;
  },

  /**
   * phone_vn_prefix
   * Giống phone_vn nhưng thêm prefix (mặc định +84) thay vì số 0.
   * VD: 0901234567 → +84901234567
   */
  phone_vn_prefix(value, options = {}) {
    const normalized = transforms.phone_vn(value); // → 0xxxxxxxxx
    if (!normalized) return "";
    const prefix = options.prefix || "+84";
    return prefix + normalized.slice(1); // bỏ số 0 đầu, ghép prefix
  },

  /**
   * digits_only
   * Loại bỏ mọi ký tự không phải số.
   * Dùng cho input type="number" không chấp nhận dấu cách, gạch ngang, dấu +.
   */
  digits_only(value) {
    if (!value) return "";
    return String(value).replace(/\D/g, "");
  },

  /**
   * format_date
   * Chuyển đổi ngày từ bất kỳ format nào sang format mong muốn.
   * Params:
   *   options.outputFormat — Pattern dayjs, VD: 'DD/MM/YYYY', 'YYYY-MM-DD'
   */
  format_date(value, options = {}) {
    const outputFormat = options.outputFormat || "DD/MM/YYYY";
    const parsed = parseDate(value); // throw nếu không parse được
    return applyDateFormat(parsed, outputFormat);
  },

  /**
   * computed_date
   * Tính ngày từ TODAY + offset rồi format.
   * Không cần value từ Master Form (thường master_field = null).
   * Params:
   *   options.offset_days  — Số ngày cộng thêm (default: 0)
   *   options.offset_years — Số năm cộng thêm (default: 0)
   *   options.outputFormat — Pattern dayjs (default: 'DD/MM/YYYY')
   */
  computed_date(_value, options = {}) {
    let base = dayjs(); // today
    if (options.offset_days) base = base.add(options.offset_days, "day");
    if (options.offset_years) base = base.add(options.offset_years, "year");
    const outputFormat = options.outputFormat || "DD/MM/YYYY";
    return applyDateFormat(base, outputFormat);
  },

  /**
   * map_value
   * Tra bảng key→value để đổi giá trị nội bộ (enum) sang giá trị web cần.
   * Fallback: giữ nguyên value gốc và log cảnh báo.
   * Params:
   *   options.map — object { key: displayValue }
   */
  map_value(value, options = {}) {
    const map = options.map || {};
    const key = String(value).trim();
    if (key in map) {
      return map[key];
    }
    // Fallback: giữ nguyên (graceful degradation)
    console.warn(
      `  ⚠️  [transform:map_value] Không tìm thấy key "${key}" trong map. Giữ nguyên giá trị.`
    );
    return key;
  },

  /**
   * extract_last_n_chars
   * Lấy N ký tự cuối cùng của chuỗi.
   * Dùng cho trường Số vệ tinh (đọc từ ID Thiết Bị, lấy 9 ký tự cuối).
   * Params:
   *   options.n — Số ký tự cần lấy (bắt buộc)
   */
  extract_last_n_chars(value, options = {}) {
    const n = options.n;
    if (!n || typeof n !== "number") {
      throw new Error(
        `[transforms] extract_last_n_chars: options.n (số) là bắt buộc.`
      );
    }
    const str = String(value || "").trim();
    if (str.length < n) {
      console.warn(
        `  ⚠️  [transform:extract_last_n_chars] Chuỗi "${str}" ngắn hơn ${n} ký tự. Trả về toàn bộ.`
      );
      return str;
    }
    return str.slice(-n);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCHER — Hàm duy nhất được engine gọi
// ─────────────────────────────────────────────────────────────────────────────

/**
 * applyTransform(value, transformName, options?)
 * ---------------------------------------------
 * Tìm hàm transform theo tên (string) và thực thi.
 * Đây là interface duy nhất giữa engine.js và transforms.js.
 *
 * @param {*}      value         — Giá trị gốc từ masterData
 * @param {string} transformName — Tên transform (khớp với key trong `transforms`)
 * @param {object} options       — Tùy chọn truyền vào hàm transform (optional)
 * @returns {string}             — Giá trị đã biến đổi, sẵn sàng để fill vào input
 * @throws  {Error}              — Nếu transform không tồn tại hoặc lỗi nội bộ
 */
function applyTransform(value, transformName, options = {}) {
  const fn = transforms[transformName];

  if (typeof fn !== "function") {
    throw new Error(
      `[transforms] Không tìm thấy transform "${transformName}". ` +
        `Các transform hợp lệ: ${Object.keys(transforms).join(", ")}`
    );
  }

  try {
    const result = fn(value, options);
    return result;
  } catch (err) {
    throw new Error(
      `[transforms] Lỗi khi chạy "${transformName}" ` +
        `với value="${value}": ${err.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  applyTransform, // Hàm chính engine dùng
  transforms, // Export object để test từng hàm riêng lẻ nếu cần
};
