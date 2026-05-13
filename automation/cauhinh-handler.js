/**
 * cauhinh-handler.js
 * ==================
 * Handler điều phối toàn bộ luồng automation cho Web Cấu hình (Viettel S-Tracking).
 *
 * LUỒNG NAVIGATION ĐẦY ĐỦ (7 bước):
 *   [1] goto(URL)             — mở trang /map
 *   [2] Auto-login            — điền credentials, click Đăng nhập, chờ 12s (bản đồ + popup)
 *   [3] goto(/groupList)      — navigate trực tiếp, bỏ qua Bootstrap dropdown "Quản lý > Nhóm"
 *   [4] Tìm kiếm ship_code    — điền ô search, nhấn Enter/kính lúp
 *   [5] Click tên thư mục     — click kết quả trong cây
 *   [6] Tab "Thêm/xóa PT"     — chuyển sang tab thiết bị
 *   [7] Click icon Chỉnh sửa  — mở modal Cập nhật thông tin thiết bị
 *        → Form 1 sẵn sàng → Bắt đầu vòng lặp form1..form5
 *
 * TRANSITION giữa các form (form1 → form2 → form3 → form4 → form5):
 *   KHÔNG click "Lưu". Chỉ click "Tiếp tục" để chuyển form — dữ liệu chưa được
 *   lưu vào DB, chỉ giữ trong state của wizard. Submit thật xảy ra ở form5 cuối.
 *
 * TEST MODE (testMode = true):
 *   - Điền đầy đủ form1..form5.
 *   - KHÔNG click "Lưu" ở form cuối (form5).
 *   - Gọi page.pause() để kiểm tra bằng mắt.
 *   - In gợi ý đặt tên tàu bắt đầu bằng "TEST-" để dễ xóa sau khi test.
 *
 * Export:
 *   runCauhinh(page, masterData, testMode?) → Promise<{ success, duration_ms, test_mode }>
 */

"use strict";

const path = require("path");
const fs = require("fs");
const { executeAction } = require("./engine");

// ── Config ───────────────────────────────────────────────────────────────────
const mapping = require("../data/mapping.json");
const TARGET = mapping.targets.cauhinh;

const CAUHINH_URL = "https://stracking.viettel.io/map";
const GROUPLIST_URL = "https://stracking.viettel.io/groupList";
const SCREENSHOT_DIR = path.resolve(__dirname, "../logs/errors");

// Timing (ms)
const T = {
  page_load: 3000,
  after_click: 800,
  menu_open: 600,
  search_result: 2000,
  tab_switch: 1000,
  modal_open: 2000,
  after_save: 1500,
  form_load: 2500,
};

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION SELECTORS
// ─────────────────────────────────────────────────────────────────────────────

// Credentials đăng nhập Viettel S-Tracking (hardcode để test nhanh)
const VIETTEL_USERNAME = ""; // ← NHỚ ĐIỀN USERNAME VÀO ĐÂY TRƯỚC KHI CHẠY
const VIETTEL_PASSWORD = "";

const SEL_INPUT_USERNAME = [
  'input[name="username"]',
  'input[name="user"]',
  'input[name="loginName"]',
  'input[id="username"]',
  'input[id="user"]',
  'input[type="text"]:visible',
  'input[placeholder*="tài khoản"i]',
  'input[placeholder*="username"i]',
  'input[placeholder*="đăng nhập"i]',
];

const SEL_INPUT_PASSWORD = [
  'input[name="password"]',
  'input[name="pass"]',
  'input[id="password"]',
  'input[id="pass"]',
  'input[type="password"]:visible',
  'input[placeholder*="mật khẩu"i]',
  'input[placeholder*="password"i]',
];

const SEL_BTN_DANGNHAP = [
  "#login-button-enter", // ← ID xác định từ DOM thực tế
  'button:has-text("Đăng nhập")', // chữ thường, chịu được icon lồng
  'button:has-text("ĐĂNG NHẬP")', // chữ HOA (một số web render uppercase)
  'input[type="submit"][value="Đăng nhập"]',
  'input[type="submit"][value="ĐĂNG NHẬP"]',
  'input[type="submit"]', // bất kỳ input[submit] trên trang login
  "#btnLogin",
  ".login-btn",
  ".btn-login",
  '[data-action="login"]',
  'button[type="submit"]', // generic fallback cuối cùng
];

const SEL_POST_LOGIN_READY = [
  'nav:has-text("Quản lý")',
  ".sidebar:visible",
  ".main-menu:visible",
  ".navbar:visible",
  'a:has-text("Quản lý")',
  '[data-menu="quan-ly"]',
];

// SEL_MENU_QUANLY và SEL_MENU_ITEM_NHOM không còn dùng trong luồng chính
// (đã thay bằng page.goto(GROUPLIST_URL)), giữ lại để tham khảo.
// HTML thực tế: <div class="dropdown"><a href="" data-toggle="dropdown">
//                 <div class="navitem-update">Quản lý</div></a>
//               <ul><li class="liAis"><a href="/groupList">Nhóm</a></li></ul>
const SEL_MENU_QUANLY = [
  'a[data-toggle="dropdown"]:has-text("Quản lý")',
  '.navitem-update:has-text("Quản lý")',
  'div.dropdown a:has-text("Quản lý")',
];

const SEL_MENU_ITEM_NHOM = [
  'a[href="/groupList"]',
  'li.liAis a[href="/groupList"]',
  'a:text-is("Nhóm")',
];

const SEL_PAGE_NHOM_READY = [
  'input[placeholder*="3 ký tự"]',
  'input[placeholder*="tìm kiếm"i]',
  'input[placeholder*="Tìm"i]:visible',
  ".tree-view:visible",
  ".danh-sach-nhom",
  'h2:text-is("Danh sách nhóm")',
  'h3:text("Danh sách")',
];

const SEL_SEARCH_INPUT = [
  "input#search-input", // ID duy nhất của thanh filter cây (bên phải "Danh sách nhóm")
  "#jstree-container input#search-input", // thêm container cha để chắc chắn không nhầm với #deviceGroupSearch
  '[data-testid="search-nhom"]',
];

const SEL_BTN_SEARCH = [
  "#search-input-button", // div#search-input-button (display:none → isVisible=false → skip → Enter)
  "button:has(.fa-search):visible",
  ".btn-search:visible",
  '[aria-label="Tìm kiếm"]:visible',
  "button:has(.icon-search):visible",
];

function getShipNodeSelectors(shipCode) {
  return [
    `a.jstree-anchor:has-text("${shipCode}")`, // jstree dùng <a class="jstree-anchor"> cho mọi node
    `#jstree a:has-text("${shipCode}")`, // trong container jstree
    `:text-is("${shipCode}")`,
    `[title="${shipCode}"]`,
    `li:text("${shipCode}")`,
    `a:text("${shipCode}")`,
  ];
}

const SEL_TAB_THEM_XOA_PT = [
  ':text-is("Thêm/xóa phương tiện")',
  'button:text("Thêm/xóa")',
  '[role="tab"]:text("Thêm/xóa")',
  '.tab:text("Thêm/xóa phương tiện")',
  '[data-tab="them-xoa-pt"]',
  'li.tab-item:text("Thêm/xóa")',
];

const SEL_TABLE_THIET_BI_READY = [
  "table:visible",
  ".table-thiet-bi:visible",
  '[data-testid="table-device"]',
  'th:text("Thao tác")',
  "td:nth-child(1):visible",
];

const SEL_BTN_EDIT_DEVICE = [
  'a[title="Sửa"]:visible', // title từ DOM thực tế — chính xác nhất
  "a.table-action.edit:visible", // class từ DOM thực tế
  "a:has(i.fa-edit):visible", // chứa icon fa-edit
  "a.btn-info:has(i.fa-edit):visible", // btn-info + fa-edit
  "[data-target='#syncEditDeviceModal']:visible", // data-target modal từ DOM
  "a.edit:visible", // class edit
];

const SEL_MODAL_FORM1_READY = [
  "input#deviceName:visible",
  '[role="dialog"] input#deviceName',
  ".modal:visible input#deviceName",
  '[data-testid="modal-thiet-bi"]',
  ".modal-capnhat-thietbi:visible",
];

// Chỉ cần "Tiếp tục" để chuyển form — KHÔNG dùng Lưu giữa các form
// LƯU Ý: phải thêm :visible vào selector vì trang có 4 button "Tiếp tục"
// (mỗi Bootstrap modal một cái). Không có :visible → .first() trả về button
// của modal đã đóng (ẩn) → isVisible() = false → fail từ form2 trở đi.
const BTN_NEXT_SELECTORS = [
  'button:text-is("Tiếp tục"):visible', // exact match, chỉ lấy cái đang visible
  'button:has-text("Tiếp tục"):visible', // has-text linh hoạt hơn (chứa icon <i>)
  '[data-dismiss="modal"][data-toggle="modal"]:has-text("Tiếp tục"):visible', // Bootstrap modal button
  'button.btn-info.btn-fill:has-text("Tiếp tục"):visible', // class từ DOM thực tế
  ".btn-next:visible",
];

// Nút Lưu riêng của từng form — dùng onclick làm primary (chính xác nhất),
// fallback về class + icon floppy-o (chỉ 1 modal mở tại 1 thời điểm nên không nhầm)
const BTN_SAVE_PER_FORM = {
  form1: [
    'button[onclick="saveDeviceCapNhatThietBi()"]:visible',
    "button.btn-success.btn-fill:has(i.fa-floppy-o):visible",
  ],
  form2: [
    'button[onclick="saveDeviceCapNhatThuyenTruong()"]:visible',
    "button.btn-success.btn-fill:has(i.fa-floppy-o):visible",
  ],
  form3: [
    'button[onclick="saveDeviceCapNhatChuTau()"]:visible',
    "button.btn-success.btn-fill:has(i.fa-floppy-o):visible",
  ],
  form4: [
    'button[onclick="saveDeviceCapNhatTau()"]:visible',
    "button.btn-success.btn-fill:has(i.fa-floppy-o):visible",
  ],
  form5: [
    'button[onclick="saveDeviceCapNhatViTri()"]:visible',
    "button.btn-success.btn-fill:has(i.fa-floppy-o):visible",
  ],
};

const NEXT_FORM_READY_SELECTORS = {
  form1: '#captainDevice, input[name="captainName"]',
  form2: "#shipownerDevice, #cmndShipowner",
  form3: "#vin, #cohieu",
  form4: "#ntime",
};

const SEL_FINAL_SUCCESS = [
  ".p-message-success:visible",
  ".alert-success:visible",
  '[role="alert"]:text("thành công")',
  ".success-message:visible",
  'text="Lưu thành công"',
  'text="Cập nhật thành công"',
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: screenshotOnError
// ─────────────────────────────────────────────────────────────────────────────

async function screenshotOnError(page, context) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `cauhinh_error_${context}_${Date.now()}.png`;
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
      `[Cấu hình] Không tìm thấy "${label}".\n` +
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
    console.log(`  ✔ "${label}" sẵn sàng.`);
  } catch {
    throw new Error(
      `[Cấu hình] Timeout ${timeout}ms chờ "${label}".\n` +
        `Selectors: ${selectors.join(" | ")}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION: navigateToEditForm (8 bước)
// ─────────────────────────────────────────────────────────────────────────────

async function navigateToEditForm(page, masterData) {
  const shipCode = masterData.ship_code;

  console.log("\n" + "─".repeat(60));
  console.log("🗺️  [Cấu hình] NAVIGATION → Modal Cập nhật thông tin thiết bị");
  console.log(`   ship_code để tìm kiếm: "${shipCode}"`);
  console.log("─".repeat(60));

  // [Nav 1] Mở trang
  console.log(`\n  [Nav 1/8] Mở trang: ${CAUHINH_URL}`);
  await page.goto(CAUHINH_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(T.page_load);
  console.log(`  ✔ Trang đã tải.`);

  // [Nav 2/8] Auto-login Viettel S-Tracking
  console.log(`\n  [Nav 2/8] Kiểm tra trạng thái đăng nhập Viettel...`);
  try {
    // Kiểm tra session cũ — nếu dashboard đã hiện thì bỏ qua login
    const alreadyIn = await page
      .locator(SEL_POST_LOGIN_READY.join(", "))
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (alreadyIn) {
      console.log(`  ℹ️  Session còn hiệu lực — bỏ qua bước đăng nhập.`);
    } else {
      console.log(`  🔐 Đang auto-login Viettel S-Tracking...`);
      console.log(`     Tài khoản: ${VIETTEL_USERNAME}`);

      // Chờ trang login render xong (ô username phải xuất hiện trước)
      await page.waitForSelector(SEL_INPUT_USERNAME.join(", "), {
        timeout: 10000,
      });

      // ── Điền username ─────────────────────────────────────────────────────
      let usernameEl = null;
      for (const sel of SEL_INPUT_USERNAME) {
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
          `Không tìm thấy ô username.\nSelectors:\n` +
            SEL_INPUT_USERNAME.map((s) => `    – ${s}`).join("\n")
        );
      }
      await usernameEl.clear();
      await usernameEl.fill(VIETTEL_USERNAME);

      // ── Điền password ─────────────────────────────────────────────────────
      let passwordEl = null;
      for (const sel of SEL_INPUT_PASSWORD) {
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
          `Không tìm thấy ô password.\nSelectors:\n` +
            SEL_INPUT_PASSWORD.map((s) => `    – ${s}`).join("\n")
        );
      }
      await passwordEl.clear();
      await passwordEl.fill(VIETTEL_PASSWORD);
      console.log(`  ✔ Đã điền credentials Viettel.`);

      // ── Click nút Đăng nhập ───────────────────────────────────────────────
      console.log(`  🖱️  Click nút Đăng nhập Viettel...`);
      await clickButtonByFallback(page, SEL_BTN_DANGNHAP, "Đăng nhập");

      // ── Chờ redirect hoàn tất rồi mới tiếp tục ───────────────────────────
      // waitForLoadState('networkidle') đảm bảo trang đích đã render xong JS
      console.log(`  ⏳ Chờ redirect sau đăng nhập...`);
      await page
        .waitForLoadState("networkidle", { timeout: 15000 })
        .catch(() => {
          console.warn(`  ⚠️  networkidle timeout — thử waitForAny dashboard.`);
        });

      await waitForAny(page, SEL_POST_LOGIN_READY, "dashboard Viettel", 20000);

      // Chờ 12s để bản đồ và các popup cảnh báo load xong hoàn toàn trước khi thao tác UI.
      console.log(
        `  ⏳ Chờ 12s để bản đồ và popup "Tàu có cảnh báo" load xong...`
      );
      await page.waitForTimeout(12000);
      console.log(`  ✔ Hết 12s — UI Viettel sẵn sàng thao tác.`);

      // Thử đóng popup cảnh báo (nếu có) bằng Escape trước khi thao tác menu.
      console.log(`  🔑 Nhấn Escape để đóng popup cảnh báo (nếu đang mở)...`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    }
  } catch (err) {
    throw new Error(`[Cấu hình] Đăng nhập Viettel thất bại: ${err.message}`);
  }
  console.log(`  ✔ Đã vào trang chính Viettel.`);

  // [Nav 3+4] Navigate trực tiếp đến /groupList — bỏ qua Bootstrap dropdown
  // Bootstrap dùng href="" + data-toggle="dropdown" nên click không đáng tin cậy.
  // Session cookie vẫn còn hiệu lực sau login, goto() là cách chắc chắn nhất.
  console.log(`\n  [Nav 3/8] Navigate trực tiếp → ${GROUPLIST_URL}`);
  await page.goto(GROUPLIST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(T.page_load);
  await waitForAny(page, SEL_PAGE_NHOM_READY, "trang Danh sách nhóm", 15000);
  console.log(`  ✔ Trang Danh sách nhóm đã tải. [Nav 3+4 hoàn tất]`);

  // [Nav 4] Tìm kiếm tàu
  console.log(`\n  [Nav 4/7] Tìm kiếm tàu "${shipCode}"...`);
  const searchInputEl = page.locator(SEL_SEARCH_INPUT.join(", ")).first();
  await searchInputEl.waitFor({ state: "visible", timeout: 8000 });
  await searchInputEl.clear();
  await searchInputEl.fill(shipCode);
  console.log(`  ⌨️  Đã điền "${shipCode}" vào ô tìm kiếm.`);
  await page.waitForTimeout(300);

  const searchBtnFound = await clickButtonByFallback(
    page,
    SEL_BTN_SEARCH,
    "kính lúp Search",
    { required: false }
  );
  if (!searchBtnFound) {
    await searchInputEl.press("Enter");
    console.log(`  ⌨️  Nhấn Enter để search.`);
  }
  await page.waitForTimeout(T.search_result);
  console.log(`  ✔ Kết quả tìm kiếm đã tải.`);

  // [Nav 5] Click tên tàu trong cây
  console.log(`\n  [Nav 5/7] Click node "${shipCode}" trên cây...`);
  await clickButtonByFallback(
    page,
    getShipNodeSelectors(shipCode),
    `node "${shipCode}"`
  );
  await page.waitForTimeout(T.after_click);
  console.log(`  ✔ Đã chọn thư mục tàu.`);

  // [Nav 6] Tab "Thêm/xóa phương tiện"
  console.log(`\n  [Nav 6/7] Click tab "Thêm/xóa phương tiện"...`);
  await clickButtonByFallback(
    page,
    SEL_TAB_THEM_XOA_PT,
    "Tab Thêm/xóa phương tiện"
  );
  await page.waitForTimeout(T.tab_switch);
  await waitForAny(
    page,
    SEL_TABLE_THIET_BI_READY,
    "bảng danh sách thiết bị",
    10000
  );
  console.log(`  ✔ Tab và bảng thiết bị đã load.`);

  // [Nav 7] Click icon Chỉnh sửa → mở modal Form 1
  console.log(`\n  [Nav 7/7] Click icon Chỉnh sửa → mở modal cấu hình...`);
  await clickButtonByFallback(page, SEL_BTN_EDIT_DEVICE, "icon Chỉnh sửa");
  await page.waitForTimeout(T.modal_open);
  await waitForAny(
    page,
    SEL_MODAL_FORM1_READY,
    "modal Form 1 (Thông tin thiết bị)",
    12000
  );
  console.log(`  ✔ Modal đã mở — Form 1 sẵn sàng.`);

  console.log("\n  ✅ Navigation hoàn tất (7/7 bước).");
  console.log("─".repeat(60));
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: continueToNextForm
// Chỉ click "Tiếp tục" — KHÔNG click "Lưu" giữa các form.
//
// Lý do: Trong wizard Viettel, "Lưu" chỉ lưu thật khi ở form cuối.
// Giữa các form chỉ cần "Tiếp tục" để chuyển tab — dữ liệu chưa vào DB.
// ─────────────────────────────────────────────────────────────────────────────

async function continueToNextForm(page, currentFormKey) {
  console.log(`\n  ➡️  [Transition] ${currentFormKey} → Click "Tiếp tục"...`);

  // KHÔNG nhấn Escape ở đây — Bootstrap modal cũng lắng nghe Escape để tự đóng,
  // nên nhấn Escape sẽ đóng luôn cả modal thay vì chỉ đóng calendar.
  // Calendar được xử lý bằng cách điền Ngày sinh ĐẦU TIÊN trong mỗi form:
  // khi bot click field tiếp theo, calendar tự đóng một cách tự nhiên.
  await page.waitForTimeout(300);

  await clickButtonByFallback(page, BTN_NEXT_SELECTORS, "Tiếp tục");

  const nextReadySel = NEXT_FORM_READY_SELECTORS[currentFormKey];
  if (nextReadySel) {
    await page.waitForSelector(nextReadySel, { timeout: 15000 });
    console.log(`  ✔ Form tiếp theo đã tải.`);
  } else {
    await page.waitForTimeout(T.form_load);
    console.log(`  ✔ Chờ ${T.form_load}ms.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: prepareMasterData
// ─────────────────────────────────────────────────────────────────────────────

function prepareMasterData(masterData) {
  const data = { ...masterData };
  if (data.captain_is_owner === true) {
    console.log(
      "\n  ℹ️  captain_is_owner=true — Copy chủ tàu → thuyền trưởng."
    );
    data.captain_name = data.captain_name || data.owner_name;
    data.captain_phone = data.captain_phone || data.owner_phone;
    data.captain_cccd = data.captain_cccd || data.owner_cccd;
    data.captain_address = data.captain_address || data.owner_address;
    console.log(
      `    name ← "${data.captain_name}", phone ← "${data.captain_phone}"`
    );
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: fillField
// ─────────────────────────────────────────────────────────────────────────────

async function fillField(page, fieldKey, fieldConfig, masterData, formKey) {
  try {
    await executeAction(page, fieldConfig, masterData);
  } catch (err) {
    const label = fieldConfig.label_vi || fieldKey;
    console.error(`\n  ❌ LỖI field "${label}" (${formKey}): ${err.message}`);
    await screenshotOnError(page, `${formKey}_${fieldKey}`);
    throw new Error(
      `[Cấu hình] ${formKey}/"${label}" thất bại: ${err.message}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: processForm
// ─────────────────────────────────────────────────────────────────────────────

async function processForm(page, formKey, formConfig, masterData) {
  const fields = formConfig.fields;
  const fieldKeys = Object.keys(fields);
  const total = fieldKeys.length;
  const formName = formConfig._name || formKey;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📋 [${formKey.toUpperCase()}] "${formName}" — ${total} fields`);
  console.log("─".repeat(60));

  for (let i = 0; i < fieldKeys.length; i++) {
    const fieldKey = fieldKeys[i];
    const fieldConfig = fields[fieldKey];
    const progress = `[${String(i + 1).padStart(2, "0")}/${total}]`;

    console.log(`\n${progress} 🔄 ${fieldConfig.label_vi || fieldKey}`);

    if (fieldConfig.master_field && !fieldConfig.required) {
      const val = masterData[fieldConfig.master_field];
      const isEmpty =
        val === null || val === undefined || String(val).trim() === "";
      if (isEmpty && fieldConfig.action_type === "fill") {
        if (!fieldConfig.fallback_static) {
          console.log(`  ⏭️  Bỏ qua — trống, không bắt buộc.`);
          continue;
        }
        console.log(`  ℹ️  Fallback static: "${fieldConfig.fallback_static}"`);
        masterData = {
          ...masterData,
          [fieldConfig.master_field]: fieldConfig.fallback_static,
        };
      }
    }

    await fillField(page, fieldKey, fieldConfig, masterData, formKey);
  }

  console.log(`\n  ✅ ${formKey.toUpperCase()} hoàn tất.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT: runCauhinh
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('playwright').Page} page
 * @param {object}  masterData
 * @param {boolean} [testMode=false]  — true: dừng trước Lưu cuối, không lưu DB
 */
async function runCauhinh(page, masterData, testMode = false) {
  const startTime = Date.now();

  console.log("\n" + "═".repeat(60));
  console.log(
    `🚀 [Cấu hình] Bắt đầu — Web Viettel S-Tracking${
      testMode ? "  🧪 [TEST MODE]" : ""
    }`
  );
  console.log(
    `   Tàu: ${masterData.ship_code}  |  S/N: ${masterData.serial_number}`
  );
  console.log("═".repeat(60));

  // ── Gợi ý đặt tên có tiền tố TEST- để dễ dọn sau khi test ─────────────────
  if (testMode) {
    console.log("\n" + "─".repeat(60));
    console.log("🧪 [Cấu hình] TEST MODE BẬT:");
    console.log(
      '   • Bot sẽ điền đầy đủ 5 forms nhưng KHÔNG click "Lưu" cuối.'
    );
    console.log("   • Dữ liệu sẽ KHÔNG được lưu vào DB của Viettel.");
    console.log("   • page.pause() sẽ được gọi để bạn kiểm tra bằng mắt.");
    console.log('💡 GỢI Ý: Hãy đặt Mã tàu có tiền tố "TEST-" ở Master Form');
    console.log("          (VD: TEST-12345) để dễ dàng nhận biết và xóa tay");
    console.log("          nếu dữ liệu lỡ bị lưu vào hệ thống.");
    console.log("─".repeat(60) + "\n");
  }

  // ══ PHASE 0: Chuẩn bị data ═══════════════════════════════════════════════
  const preparedData = prepareMasterData(masterData);

  // ══ PHASE 1: Navigation (8 bước) ═════════════════════════════════════════
  try {
    await navigateToEditForm(page, preparedData);
  } catch (err) {
    console.error(`\n  ❌ Navigation thất bại: ${err.message}`);
    await screenshotOnError(page, "navigation");
    throw new Error(`[Cấu hình] Navigation thất bại: ${err.message}`);
  }

  // ══ PHASE 2: Điền 5 forms ═══════════════════════════════════════════════
  // Production: sau mỗi form → click Lưu → click Tiếp tục (trừ form cuối chỉ Lưu)
  // Test mode:  sau mỗi form → chỉ click Tiếp tục, không Lưu gì cả
  const formKeys = Object.keys(TARGET.forms); // ['form1'..'form5']
  console.log(
    `\n📝 [Cấu hình] Điền ${formKeys.length} forms: ${formKeys.join(" → ")}`
  );
  console.log(
    testMode
      ? `   [TEST] Chỉ Tiếp tục, KHÔNG Lưu`
      : `   [PROD] Mỗi form: Điền → Lưu → Tiếp tục (form cuối: Điền → Lưu)`
  );

  for (let formIdx = 0; formIdx < formKeys.length; formIdx++) {
    const formKey = formKeys[formIdx];
    const formConfig = TARGET.forms[formKey];
    const isLastForm = formIdx === formKeys.length - 1;

    console.log(`\n${"═".repeat(60)}`);
    console.log(
      `🚀 ${formKey.toUpperCase()} (${formIdx + 1}/${formKeys.length}): "${
        formConfig._name
      }"`
    );

    await processForm(page, formKey, formConfig, preparedData);

    // ── Lưu từng form (chỉ Production) ───────────────────────────────────
    if (!testMode) {
      const saveSels = BTN_SAVE_PER_FORM[formKey];
      try {
        await clickButtonByFallback(page, saveSels, `Lưu (${formKey})`);
        await page.waitForTimeout(T.after_save);
        console.log(`  ✔ Đã Lưu ${formKey.toUpperCase()}.`);
      } catch (err) {
        console.error(`\n  ❌ Lưu "${formKey}" thất bại: ${err.message}`);
        await screenshotOnError(page, `save_${formKey}`);
        throw new Error(`[Cấu hình] Lưu ${formKey} thất bại: ${err.message}`);
      }
    }

    // ── Tiếp tục sang form kế (trừ form cuối) ────────────────────────────
    if (!isLastForm) {
      try {
        await continueToNextForm(page, formKey);
      } catch (err) {
        console.error(
          `\n  ❌ Transition sau "${formKey}" thất bại: ${err.message}`
        );
        await screenshotOnError(page, `transition_after_${formKey}`);
        throw new Error(
          `[Cấu hình] Transition ${formKey}→next thất bại: ${err.message}`
        );
      }
    }
  }

  // ══ PHASE 3: Kết thúc ════════════════════════════════════════════════════
  console.log("\n" + "─".repeat(60));

  if (testMode) {
    // ── TEST MODE: KHÔNG Lưu gì, chỉ pause để kiểm tra ──────────────────────
    console.log("🧪 [Cấu hình] TEST MODE — Tất cả 5 forms đã điền xong.");
    console.log('🧪 [Cấu hình] KHÔNG click "Lưu" — dữ liệu chưa vào DB.');
    console.log("🧪 [Cấu hình] Gọi page.pause() — Kiểm tra form trên browser.");
    console.log(
      "🧪 [Cấu hình] Nhấn Resume (▶) trong Playwright Inspector để thoát."
    );
    if (masterData.ship_code && !masterData.ship_code.startsWith("TEST-")) {
      console.log(
        `\n  💡 Lưu ý: Mã tàu "${masterData.ship_code}" — cân nhắc dùng tiền tố TEST- lần sau.`
      );
    }
    console.log("─".repeat(60));
    await page.pause();
    console.log("\n🧪 [Cấu hình] Đã resume. Kết thúc Test Mode.");
  } else {
    // ── PRODUCTION MODE: Lưu đã được click từng form ở Phase 2 ──────────────
    // Chỉ cần kiểm tra indicator thành công sau form5
    console.log(
      "📤 [Cấu hình] Tất cả 5 forms đã Lưu xong. Kiểm tra kết quả..."
    );
    let found = false;
    for (const sel of SEL_FINAL_SUCCESS) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 8000 }).catch(() => false)) {
        console.log(`  ✔ Thành công! [${sel}]`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.warn(
        "  ⚠️  Không thấy indicator thành công — kiểm tra thủ công."
      );
    }
  }

  // ══ Done ══════════════════════════════════════════════════════════════════
  const duration = Date.now() - startTime;
  console.log("\n" + "═".repeat(60));
  console.log(
    `✅ [Cấu hình] Hoàn tất! ${(duration / 1000).toFixed(1)}s${
      testMode ? " 🧪 TEST" : ""
    }`
  );
  console.log("═".repeat(60) + "\n");

  return { success: true, duration_ms: duration, test_mode: testMode };
}

module.exports = { runCauhinh };
