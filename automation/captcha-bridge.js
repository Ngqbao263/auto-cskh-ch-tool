/**
 * captcha-bridge.js
 * =================
 * Cầu nối captcha giữa automation BCCS (Node/Playwright) và giao diện tool.
 *
 * Luồng:
 *   - bccs-handler chụp ảnh captcha trong SFive → gọi waitForCaptcha({image}) → CHỜ.
 *   - Giao diện tool poll getPending() → hiện ảnh cho nhân viên nhập.
 *   - Nhân viên bấm Xác nhận → server gọi answer(id, code) → promise resolve {type:'answer'}.
 *   - Nhân viên bấm Đổi mã   → server gọi reload(id)      → promise resolve {type:'reload'}.
 *
 * Chỉ 1 phiên captcha tại một thời điểm (tool 1 người dùng, 1 luồng BCCS).
 */

"use strict";

let session = null; // { id, image, testMode, resolve, createdAt }
let counter = 0;

function _newId() {
  counter += 1;
  // Không dùng Date.now() ở chỗ nhạy cảm resume; ở đây chỉ để tạo id duy nhất là đủ.
  return `cap_${counter}_${Math.floor(process.hrtime()[1] % 1e6)}`;
}

/**
 * Automation gọi: đẩy ảnh captcha lên UI và CHỜ nhân viên phản hồi.
 * Trả về: { type:'answer', code } | { type:'reload' } | { type:'timeout' } | { type:'cancel' }
 */
function waitForCaptcha({ image, testMode } = {}, timeoutMs = 180000) {
  // Nếu đang có phiên cũ (hiếm) → huỷ nó trước.
  clear();
  return new Promise((resolve) => {
    const id = _newId();
    const timer = setTimeout(() => {
      if (session && session.id === id) {
        session = null;
        resolve({ type: "timeout" });
      }
    }, timeoutMs);
    session = {
      id,
      image,
      testMode: !!testMode,
      createdAt: Date.now(),
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
    };
  });
}

/** UI poll: trả thông tin captcha đang chờ (không kèm hàm resolve). */
function getPending() {
  if (!session) return null;
  return { id: session.id, image: session.image, test_mode: session.testMode };
}

/** UI gửi đáp án. Trả true nếu khớp phiên đang chờ. */
function answer(id, code) {
  if (session && session.id === id) {
    const resolve = session.resolve;
    session = null;
    resolve({ type: "answer", code: String(code == null ? "" : code) });
    return true;
  }
  return false;
}

/** UI yêu cầu đổi mã captcha. */
function reload(id) {
  if (session && session.id === id) {
    const resolve = session.resolve;
    session = null;
    resolve({ type: "reload" });
    return true;
  }
  return false;
}

/** Huỷ phiên hiện tại (vd khi bắt đầu run mới, hoặc automation kết thúc). */
function clear() {
  if (session) {
    const resolve = session.resolve;
    session = null;
    resolve({ type: "cancel" });
  }
}

module.exports = { waitForCaptcha, getPending, answer, reload, clear };
