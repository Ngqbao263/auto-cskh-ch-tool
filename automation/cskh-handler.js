/**
 * cskh-handler.js
 * ===============
 * Handler điều phối toàn bộ luồng automation cho Web CSKH (SDVICO).
 *
 * LUỒNG NAVIGATION ĐẦY ĐỦ:
 *   goto(URL) → "Tạo phiếu đấu nối" → Form hiện ra → Điền fields → "Tạo phiếu"
 *
 * Luồng field đặc biệt:
 *   - captain_is_owner = true  → click checkbox, skip điền tay section captain
 *   - requester_is_owner = true → click checkbox, skip điền tay requester_name
 *   - gia_tri_khuyen_mai       → conditional_fill, chờ enabled
 *   - Mỗi field lỗi            → screenshot + throw ngay
 *
 * TEST MODE (tham số testMode = true):
 *   - Toàn bộ điền form diễn ra bình thường.
 *   - Đến bước Submit cuối (click "Tạo phiếu") → DỪNG, không click.
 *   - Gọi page.pause() để người dùng kiểm tra bằng mắt.
 *   - Trả về { success: true, test_mode: true } thay vì chờ thông báo thành công.
 *
 * Export:
 *   runCSKH(page, masterData, testMode?) → Promise<{ success, duration_ms, test_mode }>
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { executeAction } = require("./engine");

// ── Config ───────────────────────────────────────────────────────────────────
const mapping = require("../data/mapping.json");
const TARGET = mapping.targets.cskh;

const CSKH_URL = "https://cskh.sdvico.vn/customer-care/s-tracking";
const RUNTIME_ROOT = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const SCREENSHOT_DIR = path.join(RUNTIME_ROOT, "logs", "errors");

// Timing (ms)
const T = {
  page_load: 3000,
  after_click: 800,
  modal_open: 3000, // 3s để animation Radix UI (backdrop bg-black/80) fade-out hoàn toàn
  section_render: 1000,
};

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION SELECTORS
// ─────────────────────────────────────────────────────────────────────────────

const SEL_BTN_TAO_PHIEU_DAU_NOI = [
  'button:has-text("Tạo phiếu đấu nối")',
  'a:text-is("Tạo phiếu đấu nối")',
  '[data-action="create-phieu"]',
  ".btn-tao-phieu-dau-noi",
  'button:text("Tạo phiếu")',
];

const SEL_FORM_READY = [
  'button[role="combobox"]:near(:text("Mã tàu"))',
  '[data-testid="form-tao-phieu"]',
  ".form-phieu-dau-noi",
  '[role="dialog"]:visible',
];

const SEL_BTN_SUBMIT = [
  'button:text-is("Tạo phiếu")',
  '[data-action="submit-phieu"]',
  'button:text-is("Tạo phiếu đấu nối")',
  'button[type="submit"]:near(:text("Tạo phiếu"))',
  'button[type="submit"]:visible',
];

const SEL_SUCCESS = [
  ".alert-success:visible",
  ".toast-success:visible",
  '[role="alert"]:text("thành công")',
  '[role="status"]:text("thành công")',
  ".notification-success:visible",
  'text="Tạo phiếu thành công"',
  'text="Lưu thành công"',
];

// ─── Credentials CSKH (hardcode để test nhanh) ───────────────────────────────
const CSKH_USERNAME = ""; // ← NHỚ ĐIỀN TÀI KHOẢN CSKH VÀO ĐÂY TRƯỚC KHI CHẠY TEST
const CSKH_PASSWORD = "";

// ─── Selectors ô nhập tài khoản / mật khẩu CSKH ─────────────────────────────
const SEL_CSKH_INPUT_USERNAME = [
  'input[type="text"]:visible',
  'input[name="username"]',
  'input[placeholder*="tài khoản"i]',
  'input[placeholder*="username"i]',
  'input[id="username"]',
];

const SEL_CSKH_INPUT_PASSWORD = [
  'input[type="password"]:visible',
  'input[name="password"]',
  'input[placeholder*="mật khẩu"i]',
  'input[id="password"]',
];

// ─── Nút Đăng nhập — bao trùm chữ thường, chữ HOA, input submit, ID cụ thể ───
const SEL_BTN_LOGIN = [
  "#login-button-enter", // ← ID xác định từ DOM thực tế
  'button:has-text("Đăng nhập")', // chữ thường, chịu icon lồng bên trong
  'button:has-text("ĐĂNG NHẬP")', // chữ HOA
  'input[type="submit"][value="Đăng nhập"]',
  'input[type="submit"][value="ĐĂNG NHẬP"]',
  'input[type="submit"]',
  "#btnLogin",
  ".login-btn",
  ".btn-login",
  '[data-action="login"]',
  'button[type="submit"]', // generic fallback cuối cùng
];

// ─── Selector xác nhận đã vào dashboard CSKH ─────────────────────────────────
const SEL_CSKH_POST_LOGIN_READY = [
  'button:has-text("Tạo phiếu đấu nối")',
  'a:has-text("Tạo phiếu đấu nối")',
  ".btn-tao-phieu-dau-noi",
  ".dashboard:visible",
  ".main-content:visible",
];

async function screenshotOnError(page, context) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `cskh_error_${context}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    console.error(`  📸 Screenshot lỗi → ${filepath}`);
    return filepath;
  } catch (e) {
    console.error(`  ⚠️  Không chụp được screenshot: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: clickButtonByFallback
// ─────────────────────────────────────────────────────────────────────────────

async function clickButtonByFallback(page, selectors, label, opts = {}) {
  const { timeout = 2000, required = true } = opts;
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible({ timeout }).catch(() => false);
      if (visible) {
        await el.click();
        console.log(`  🖱️  Click "${label}" ✔  [${sel}]`);
        return true;
      }
    } catch {
      /* thử tiếp */
    }
  }
  if (required) {
    throw new Error(
      `[CSKH] Không tìm thấy nút "${label}".\n` +
        `Selectors đã thử:\n${selectors.map((s) => `    – ${s}`).join("\n")}`
    );
  }
  console.warn(`  ⚠️  Không tìm thấy "${label}" (optional) — bỏ qua.`);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: waitForAny
// ─────────────────────────────────────────────────────────────────────────────

async function waitForAny(page, selectors, label, timeout = 10000) {
  console.log(`  ⏳ Chờ "${label}"...`);
  const combined = selectors.join(", ");
  try {
    await page.waitForSelector(combined, { timeout });
    console.log(`  ✔ "${label}" đã sẵn sàng.`);
  } catch {
    throw new Error(
      `[CSKH] Timeout ${timeout}ms chờ "${label}".\nSelectors: ${selectors.join(
        " | "
      )}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION: navigateToForm
//
// Luồng 4 bước:
//   [1] goto(CSKH_URL)
//   [2] Auto-login (bỏ qua nếu session còn hiệu lực)
//   [3] Click nút "Tạo phiếu đấu nối"
//   [4] Chờ form/modal render xong
// ─────────────────────────────────────────────────────────────────────────────

async function navigateToForm(page) {
  console.log("\n" + "─".repeat(60));
  console.log("🗺️  [CSKH] NAVIGATION → Form Tạo phiếu đấu nối");
  console.log("─".repeat(60));

  // ── [Nav 1/4] Mở trang ────────────────────────────────────────────────────
  console.log(`\n  [Nav 1/4] Mở trang: ${CSKH_URL}`);
  await page.goto(CSKH_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(T.page_load);
  console.log(`  ✔ Trang CSKH đã tải.`);

  // ── [Nav 2/4] Auto-login CSKH ─────────────────────────────────────────────
  console.log(`\n  [Nav 2/4] Kiểm tra trạng thái đăng nhập CSKH...`);
  try {
    // Nếu nút "Tạo phiếu" đã thấy → session còn, bỏ qua login
    const alreadyIn = await page
      .locator(SEL_CSKH_POST_LOGIN_READY.join(", "))
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (alreadyIn) {
      console.log(`  ℹ️  Session CSKH còn hiệu lực — bỏ qua đăng nhập.`);
    } else {
      console.log(`  🔐 Đang auto-login CSKH...`);
      console.log(`     Tài khoản: ${CSKH_USERNAME}`);

      // Chờ trang login render: đảm bảo ô username đã xuất hiện
      await page.waitForSelector(SEL_CSKH_INPUT_USERNAME.join(", "), {
        timeout: 10000,
      });

      // ── Điền username ──────────────────────────────────────────────────────
      let usernameEl = null;
      for (const sel of SEL_CSKH_INPUT_USERNAME) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            usernameEl = el;
            console.log(`  ⌨️  Điền username → [${sel}]`);
            break;
          }
        } catch {
          /* thử tiếp */
        }
      }
      if (!usernameEl) {
        throw new Error(
          `Không tìm thấy ô username CSKH.\nSelectors:\n` +
            SEL_CSKH_INPUT_USERNAME.map((s) => `    – ${s}`).join("\n")
        );
      }
      await usernameEl.clear();
      await usernameEl.fill(CSKH_USERNAME);

      // ── Điền password ──────────────────────────────────────────────────────
      let passwordEl = null;
      for (const sel of SEL_CSKH_INPUT_PASSWORD) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
            passwordEl = el;
            console.log(`  ⌨️  Điền password → [${sel}]`);
            break;
          }
        } catch {
          /* thử tiếp */
        }
      }
      if (!passwordEl) {
        throw new Error(
          `Không tìm thấy ô password CSKH.\nSelectors:\n` +
            SEL_CSKH_INPUT_PASSWORD.map((s) => `    – ${s}`).join("\n")
        );
      }
      await passwordEl.clear();
      await passwordEl.fill(CSKH_PASSWORD);
      console.log(`  ✔ Đã điền credentials CSKH.`);

      // ── Click nút Đăng nhập ────────────────────────────────────────────────
      console.log(`  🖱️  Click nút Đăng nhập CSKH...`);
      await clickButtonByFallback(page, SEL_BTN_LOGIN, "Đăng nhập");

      // ── Chờ redirect & dashboard load ─────────────────────────────────────
      console.log(`  ⏳ Chờ redirect sau đăng nhập CSKH...`);
      await page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {
          console.warn(`  ⚠️  networkidle timeout — thử waitForAny dashboard.`);
        });

      await waitForAny(
        page,
        SEL_CSKH_POST_LOGIN_READY,
        "dashboard CSKH sau đăng nhập",
        20000
      );
      console.log(`  ✔ Đã vào dashboard CSKH.`);
    }
  } catch (err) {
    throw new Error(`[CSKH] Đăng nhập thất bại: ${err.message}`);
  }

  // ── [Nav 3/4] Click nút "Tạo phiếu đấu nối" ─────────────────────────────
  console.log(`\n  [Nav 3/4] Click nút "Tạo phiếu đấu nối"...`);
  await clickButtonByFallback(
    page,
    SEL_BTN_TAO_PHIEU_DAU_NOI,
    "Tạo phiếu đấu nối"
  );
  await page.waitForTimeout(T.after_click);

  // ── [Nav 4/4] Chờ form/modal render xong ─────────────────────────────────
  console.log(`\n  [Nav 4/4] Chờ form hiện ra và ổn định...`);
  await waitForAny(page, SEL_FORM_READY, "form Tạo phiếu đấu nối", 12000);
  await page.waitForTimeout(T.modal_open);

  console.log("\n  ✅ Navigation CSKH thành công — Form sẵn sàng.");
  console.log("─".repeat(60));
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: shouldSkipField
// ─────────────────────────────────────────────────────────────────────────────

function shouldSkipField(fieldKey, fieldConfig, masterData) {
  const CAPTAIN_FIELDS = [
    "captain_name",
    "captain_phone",
    "captain_cccd",
    "captain_address",
  ];
  if (
    CAPTAIN_FIELDS.includes(fieldKey) &&
    masterData.captain_is_owner === true
  ) {
    console.log(
      `  ⏭️  Skip "${fieldConfig.label_vi}" — captain_is_owner=true.`
    );
    return true;
  }
  if (fieldKey === "requester_name" && masterData.requester_is_owner === true) {
    console.log(
      `  ⏭️  Skip "${fieldConfig.label_vi}" — requester_is_owner=true.`
    );
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: fillField
// ─────────────────────────────────────────────────────────────────────────────

async function fillField(page, fieldKey, fieldConfig, masterData) {
  try {
    await executeAction(page, fieldConfig, masterData);
  } catch (err) {
    const label = fieldConfig.label_vi || fieldKey;
    console.error(`\n  ❌ LỖI field "${label}": ${err.message}`);
    await screenshotOnError(page, `field_${fieldKey}`);
    throw new Error(`[CSKH] Field "${label}" thất bại: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: runCSKH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page
 * @param {object}  masterData
 * @param {boolean} [testMode=false]  — true: dừng trước Submit, không lưu DB
 */
async function runCSKH(page, masterData, testMode = false) {
  const startTime = Date.now();

  console.log("\n" + "═".repeat(60));
  console.log(
    `🚀 [CSKH] Bắt đầu — Web CSKH SDVICO${testMode ? "  🧪 [TEST MODE]" : ""}`
  );
  console.log(
    `   Tàu: ${masterData.ship_code}  |  S/N: ${masterData.serial_number}`
  );
  console.log("═".repeat(60));

  // ══ PHASE 1: Navigation ══════════════════════════════════════════════════
  try {
    await navigateToForm(page);
  } catch (err) {
    console.error(`\n  ❌ Navigation thất bại: ${err.message}`);
    await screenshotOnError(page, "navigation");
    throw new Error(`[CSKH] Navigation thất bại: ${err.message}`);
  }

  // ══ PHASE 2: Điền fields ═════════════════════════════════════════════════
  const fields = TARGET.fields;
  const fieldKeys = Object.keys(fields);
  const total = fieldKeys.length;

  console.log(`\n📋 [CSKH] Bắt đầu điền ${total} fields...`);

  for (let i = 0; i < fieldKeys.length; i++) {
    const fieldKey = fieldKeys[i];
    const fieldConfig = fields[fieldKey];
    const progress = `[${String(i + 1).padStart(2, "0")}/${total}]`;

    console.log(`\n${progress} 🔄 "${fieldConfig.label_vi || fieldKey}"`);

    if (shouldSkipField(fieldKey, fieldConfig, masterData)) continue;

    await fillField(page, fieldKey, fieldConfig, masterData);

    if (
      fieldKey === "captain_is_owner" &&
      masterData.captain_is_owner === true
    ) {
      console.log(`  ⏳ Chờ web render section Captain...`);
      await page.waitForTimeout(T.section_render);
    }
    if (
      fieldKey === "requester_is_owner" &&
      masterData.requester_is_owner === true
    ) {
      console.log(`  ⏳ Chờ web render section Người yêu cầu...`);
      await page.waitForTimeout(T.section_render);
    }
  }

  // ══ PHASE 3: Submit (hoặc Dry-run nếu testMode) ═══════════════════════════
  console.log("\n" + "─".repeat(60));

  if (testMode) {
    // ── TEST MODE: Dừng lại, KHÔNG click Submit ──────────────────────────────
    console.log("🧪 [CSKH] TEST MODE — Toàn bộ fields đã điền xong.");
    console.log(
      '🧪 [CSKH] KHÔNG click nút "Tạo phiếu" để tránh tạo rác trong DB.'
    );
    console.log("🧪 [CSKH] Gọi page.pause() — Hãy kiểm tra form trên browser.");
    console.log(
      "🧪 [CSKH] Nhấn nút Resume (▶) trong Playwright Inspector để tiếp tục."
    );
    console.log("─".repeat(60));

    // page.pause() mở Playwright Inspector, giữ browser mở để người dùng kiểm tra
    // Script chỉ tiếp tục khi người dùng nhấn Resume trong Inspector
    await page.pause();

    console.log("\n🧪 [CSKH] Đã resume từ pause(). Kết thúc Test Mode.");
  } else {
    // ── PRODUCTION MODE: Click Submit thật ───────────────────────────────────
    console.log('📤 [CSKH] Điền xong → Click "Tạo phiếu"...');
    try {
      await clickButtonByFallback(page, SEL_BTN_SUBMIT, "Tạo phiếu");
      await waitForAny(page, SEL_SUCCESS, "thông báo thành công", 15000);
      console.log("  ✔ Phiếu đấu nối đã tạo thành công!");
    } catch (err) {
      console.error(`  ❌ Submit thất bại: ${err.message}`);
      await screenshotOnError(page, "submit");
      throw new Error(`[CSKH] Submit "Tạo phiếu" thất bại: ${err.message}`);
    }
  }

  // ══ Done ══════════════════════════════════════════════════════════════════
  const duration = Date.now() - startTime;
  console.log("\n" + "═".repeat(60));
  console.log(
    `✅ [CSKH] Hoàn tất! ${(duration / 1000).toFixed(1)}s${
      testMode ? " 🧪 TEST" : ""
    }`
  );
  console.log("═".repeat(60) + "\n");

  return { success: true, duration_ms: duration, test_mode: testMode };
}

module.exports = { runCSKH };
