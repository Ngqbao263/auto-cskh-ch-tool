/**
 * billing-bridge.js
 * =================
 * Cầu nối "sửa Địa chỉ hóa đơn cước" giữa automation BCCS và giao diện master form
 * (localhost). Tương tự captcha-bridge nhưng nội dung là TEXT (địa chỉ) thay vì ảnh.
 *
 * Luồng:
 *   - bccs-handler đọc giá trị field → waitForBilling({ value }) → CHỜ.
 *   - Master form poll getPending() → hiện ô sửa (prefill value).
 *   - Người dùng bấm Xác nhận → server gọi answer(id, value) → resolve { value }.
 */

"use strict";

let session = null; // { id, value, testMode, resolve }
let counter = 0;

function _newId() {
  counter += 1;
  return `bill_${counter}_${Math.floor(process.hrtime()[1] % 1e6)}`;
}

/** Automation gọi: đẩy địa chỉ lên UI và CHỜ người sửa. Trả { value } (đã sửa hoặc giữ nguyên). */
function waitForBilling({ value, testMode } = {}, timeoutMs = 180000) {
  clear();
  return new Promise((resolve) => {
    const id = _newId();
    const timer = setTimeout(() => {
      if (session && session.id === id) {
        session = null;
        resolve({ value }); // hết giờ → giữ nguyên
      }
    }, timeoutMs);
    session = {
      id,
      value: String(value == null ? "" : value),
      testMode: !!testMode,
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
    };
  });
}

/** UI poll: trả địa chỉ đang chờ sửa. */
function getPending() {
  if (!session) return null;
  return { id: session.id, value: session.value, test_mode: session.testMode };
}

/** UI gửi địa chỉ đã sửa. */
function answer(id, value) {
  if (session && session.id === id) {
    const resolve = session.resolve;
    const original = session.value;
    session = null;
    resolve({ value: value == null ? original : String(value) });
    return true;
  }
  return false;
}

/** Huỷ phiên hiện tại. */
function clear() {
  if (session) {
    const resolve = session.resolve;
    const original = session.value;
    session = null;
    resolve({ value: original });
  }
}

module.exports = { waitForBilling, getPending, answer, clear };
