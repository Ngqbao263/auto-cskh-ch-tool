/**
 * engine.js
 * =========
 * Lõi của hệ thống Playwright Automation.
 * Gồm 2 hàm công khai chính:
 *   - findElement(page, selectors)          → Locator (có fallback chain)
 *   - executeAction(page, fieldConfig, masterData) → void (thao tác DOM)
 *
 * Thiết kế: Engine chỉ biết "làm gì" (action_type), không biết "ở đâu" (URL).
 * Các handler cụ thể (cskh-handler.js, cauhinh-handler.js) điều phối thứ tự field.
 */

"use strict";

const { applyTransform } = require("./transforms");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Timeout mặc định (ms) khi chờ element xuất hiện */
const DEFAULT_TIMEOUT = 8000;

/** Delay giữa các thao tác gõ phím (ms) — giả lập human typing */
const TYPING_DELAY = 60;

/** Delay ngắn giữa các action (ms) — tránh race condition với JS web */
const SHORT_PAUSE = 300;

/** Màu log cho từng action_type (dễ nhìn trên terminal) */
const ACTION_ICONS = {
  fill: "✏️ ",
  fill_then_tab: "✏️ ⇥",
  combobox_search: "🔍",
  datepicker_radix: "📅",
  select_native: "🔽",
  custom_select: "🔽",
  checkbox_click: "☑️ ",
  extract_and_fill: "🔗",
  static_fill: "📌",
  computed_date: "🗓️ ",
  conditional_fill: "⚡",
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: sleep
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: safeFill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * safeFill(el, value)
 * -------------------
 * Wrapper an toàn cho el.fill() — tự động xử lý input[type=number]:
 *   - Nếu element là type="number" → replace dấu phẩy "," thành dấu chấm "."
 *     (VD: "15,9" → "15.9") vì HTML number input không chấp nhận ký tự phẩy.
 *   - Các input khác (text, tel, …) → fill nguyên giá trị gốc.
 *
 * Lý do cần wrapper:
 *   Master Form đổi sang type="text" nên người dùng có thể nhập "15,9" (kiểu VN).
 *   Giá trị đó truyền tới Playwright → fill vào ô type="number" trên Viettel → lỗi.
 *
 * @param {import('playwright').Locator} el
 * @param {string} value
 */
async function safeFill(el, value) {
  const inputType = await el.getAttribute("type").catch(() => null);
  const sanitized =
    inputType === "number"
      ? String(value).replace(/,/g, ".")
      : value;

  if (sanitized !== value) {
    console.log(`    🔄 type=number → replace "," → "." : "${value}" → "${sanitized}"`);
  }

  await el.fill(sanitized);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: logAction
// ─────────────────────────────────────────────────────────────────────────────

function logAction(fieldConfig, value, extra = "") {
  const icon = ACTION_ICONS[fieldConfig.action_type] || "▶️ ";
  const label = fieldConfig.label_vi || fieldConfig.master_field || "(unknown)";
  const valStr =
    value !== undefined && value !== null
      ? `"${String(value).slice(0, 60)}"`
      : "(static/computed)";
  console.log(
    `  ${icon} [${fieldConfig.action_type}] ${label}: ${valStr}${
      extra ? " → " + extra : ""
    }`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: findElement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * findElement(page, selectors)
 * ----------------------------
 * Duyệt qua mảng selectors theo thứ tự (fallback chain).
 * Trả về Locator đầu tiên tìm thấy trên DOM.
 * Nếu duyệt hết mà không tìm được → throw Error (kèm screenshot nếu có).
 *
 * Hỗ trợ 2 loại selector:
 *   - CSS:   "#id", ".class", "input[type='text']"
 *   - XPath: "//label[...]/following-sibling::input"  (bắt đầu bằng "//")
 *
 * @param {import('playwright').Page} page
 * @param {string|string[]}           selectors  — Một string hoặc mảng string
 * @param {number}                    timeout    — ms mỗi selector (default: 8000)
 * @returns {Promise<import('playwright').Locator>}
 */
async function findElement(page, selectors, timeout = DEFAULT_TIMEOUT) {
  // Normalize: luôn làm việc với mảng
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];

  for (let i = 0; i < selectorList.length; i++) {
    const rawSelector = selectorList[i];
    const isLast = i === selectorList.length - 1;

    try {
      // XPath bắt đầu bằng "//" → dùng prefix "xpath="
      const playwrightSelector = rawSelector.startsWith("//")
        ? `xpath=${rawSelector}`
        : rawSelector;

      const locator = page.locator(playwrightSelector).first();

      // waitFor với timeout ngắn để thử nhanh, chỉ timeout đủ lâu ở selector cuối
      await locator.waitFor({
        state: "attached", // element có trong DOM (chưa cần visible)
        timeout: isLast ? timeout : Math.min(timeout, 3000),
      });

      console.log(
        `    ✔ Selector [${i + 1}/${
          selectorList.length
        }] tìm thấy: "${rawSelector}"`
      );
      return locator;
    } catch {
      const nextMsg = isLast
        ? "hết fallback"
        : `thử [${i + 2}/${selectorList.length}]`;
      console.log(
        `    ✖ Selector [${i + 1}/${
          selectorList.length
        }] không thấy ("${rawSelector}"), ${nextMsg}...`
      );
    }
  }

  // Tất cả selector đều thất bại
  throw new Error(
    `[findElement] Không tìm thấy element sau ${selectorList.length} selector(s):\n` +
      selectorList.map((s, i) => `  [${i + 1}] ${s}`).join("\n")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: executeAction — Switch-Case lớn theo action_type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * executeAction(page, fieldConfig, masterData)
 * --------------------------------------------
 * Đọc fieldConfig.action_type, lấy giá trị từ masterData,
 * apply transform, rồi thực hiện thao tác Playwright tương ứng.
 *
 * @param {import('playwright').Page} page
 * @param {object}                    fieldConfig  — Một field entry từ mapping.json
 * @param {object}                    masterData   — Dữ liệu phẳng từ Master Form
 */
async function executeAction(page, fieldConfig, masterData) {
  const {
    action_type,
    master_field,
    label_vi,
    selector,
    transform = "none",
    transformOptions = {},
    static_value,
    condition,
    pre_action,
    wait_for_enabled,
    copy_from_owner_if,
    copy_source_field,
  } = fieldConfig;

  // ── Resolve giá trị gốc từ masterData ──────────────────────────────────────
  // Với static_fill và computed_date, master_field thường null
  let rawValue = master_field ? masterData[master_field] ?? null : null;

  // Copy từ owner nếu được đánh dấu (VD: captain_is_owner = true)
  if (
    copy_from_owner_if &&
    masterData[copy_from_owner_if] === true &&
    copy_source_field
  ) {
    rawValue = masterData[copy_source_field] ?? null;
    console.log(
      `    ℹ️  Copy từ "${copy_source_field}" vì "${copy_from_owner_if}" = true`
    );
  }

  // ── Apply transform để lấy giá trị cuối cùng sẽ điền vào web ────────────────
  let finalValue;
  if (
    action_type !== "static_fill" &&
    action_type !== "computed_date" &&
    action_type !== "extract_and_fill"
  ) {
    // Với extract_and_fill, việc đọc source sẽ xảy ra trong handler riêng bên dưới
    finalValue = applyTransform(rawValue, transform, transformOptions);
  }

  logAction(fieldConfig, rawValue);

  // ── SWITCH theo action_type ─────────────────────────────────────────────────

  switch (action_type) {
    // ──────────────────────────────────────────────────────────────────────────
    // FILL — Input/textarea thông thường
    // Dùng page.fill() (clear trước, rồi set value) thay vì type() để nhanh hơn.
    // ──────────────────────────────────────────────────────────────────────────
    case "fill": {
      const el = await findElement(page, selector);
      await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

      // pre_action: "clear" — xóa giá trị mặc định trước khi fill (VD: ô Số tháng = 3)
      if (pre_action === "clear") {
        await el.clear();
        console.log(`    🧹 pre_action clear() đã thực thi.`);
      }

      await safeFill(el, finalValue);
      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // FILL_THEN_TAB — Giống fill nhưng nhấn Tab sau khi điền.
    //
    // Tại sao cần Tab?
    //   Một số web (như Viettel Form 3) gắn sự kiện onchange/onblur vào input.
    //   page.fill() SET giá trị trực tiếp vào DOM mà không trigger keyboard event.
    //   → Sự kiện onblur không bao giờ được gọi → web không validate/xử lý data.
    //   Giải pháp: sau fill(), gọi page.keyboard.press('Tab') để focus chuyển đi
    //   và trigger onblur, đúng như khi người dùng thật nhấn Tab.
    // ──────────────────────────────────────────────────────────────────────────
    case "fill_then_tab": {
      const el = await findElement(page, selector);
      await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

      // Click vào element trước để đảm bảo focus đúng chỗ
      await el.click({ force: true });
      await sleep(100);
      await safeFill(el, finalValue);

      // Nhấn Tab để trigger onblur → web nhận và validate dữ liệu
      await page.keyboard.press("Tab");
      console.log(`    ⇥  Tab đã nhấn — onblur/onchange được kích hoạt.`);

      // Chờ một chút để web xử lý AJAX response (nếu có)
      await sleep(800);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // COMBOBOX_SEARCH — Radix UI / ShadCN combobox (custom dropdown có search).
    //
    // Luồng:
    //   1. Click trigger button → dropdown/dialog mở ra
    //   2. Tìm ô search input bên trong dropdown (có thể là portal riêng)
    //   3. Gõ text để lọc options (dùng type() với delay để giả lập gõ thật)
    //   4. Chờ option xuất hiện → click option đầu tiên, hoặc nhấn Enter
    //
    // Lưu ý: Radix thường render dropdown vào body (portal), không phải trong DOM
    // của trigger button → không thể find bằng cách query con của trigger.
    // ──────────────────────────────────────────────────────────────────────────
    case "combobox_search": {
      const sel = selector; // { trigger_button: [...], search_input: [...] }

      // Bước 1: Click trigger button để mở dropdown
      // force:true bỏ qua hit-test của Playwright — cần thiết vì Radix DialogOverlay
      // (div.bg-black/80, z-50, fixed inset-0) luôn hiện diện và đôi khi intercept click.
      const triggerBtn = await findElement(page, sel.trigger_button);
      await triggerBtn.click({ force: true });
      console.log(`    🖱️  Đã click trigger button, chờ dropdown mở...`);

      // Bước 2: Chờ dropdown animation xong rồi tìm ô search
      await sleep(400);
      const searchInput = await findElement(page, sel.search_input);
      await searchInput.waitFor({ state: "visible", timeout: 5000 });

      // Bước 3: Gõ text để filter (type() với delay giả lập human — tránh debounce bị miss)
      await searchInput.type(finalValue, { delay: TYPING_DELAY });
      console.log(`    ⌨️  Đã gõ "${finalValue}", chờ options load...`);

      // Bước 4: Chờ option xuất hiện rồi chọn bằng keyboard (ArrowDown → Enter)
      // Lý do dùng keyboard thay vì click():
      //   Radix Dialog bên ngoài có "click-outside" handler. Khi combobox render dropdown
      //   vào portal (ngoài DOM của dialog), click() vào option bị handler đó bắt và
      //   đóng Dialog — dù option đã được chọn đúng. Keyboard không trigger handler này.
      await sleep(600); // chờ debounce/search request

      const OPTION_SELECTORS = [
        '[role="option"]:visible',
        "[cmdk-item]:visible",
        "li.p-autocomplete-item:visible",
        "[data-radix-collection-item]:visible",
        ".dropdown-item:visible",
      ];

      let clicked = false;
      for (const optSel of OPTION_SELECTORS) {
        const count = await page.locator(optSel).count();
        if (count > 0) {
          // Nhấn ArrowDown để highlight option đầu tiên, Enter để chọn
          await searchInput.press("ArrowDown");
          await sleep(150);
          await searchInput.press("Enter");
          console.log(`    ✔ Đã chọn option bằng keyboard (↓ → Enter) [${optSel}]`);
          clicked = true;
          break;
        }
      }

      // Fallback: nếu không tìm thấy option nào → nhấn Enter trực tiếp
      if (!clicked) {
        console.warn(`    ⚠️  Không tìm thấy option, nhấn Enter trực tiếp...`);
        await searchInput.press("Enter");
      }

      await sleep(SHORT_PAUSE);
      await sleep(500); // Chờ dropdown đóng hoàn toàn trước khi action tiếp theo
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DATEPICKER_RADIX — Radix UI Calendar / Date Picker.
    //
    // Tại sao không gõ text?
    //   Radix DatePicker render một <button> (không phải <input>).
    //   Không có ô text input để gõ ngày trực tiếp.
    //   → Phải giả lập click như người dùng thật: click button → dialog lịch → chọn ngày.
    //
    // Luồng:
    //   1. Parse ngày từ masterData
    //   2. Click trigger button → dialog/popover lịch xuất hiện
    //   3. Điều hướng tháng/năm đến đúng tháng cần chọn (click nút < > hoặc header)
    //   4. Click ô ngày tương ứng (aria-label hoặc text content)
    // ──────────────────────────────────────────────────────────────────────────
    case "datepicker_radix": {
      const sel = selector; // { trigger_button: [...] }
      const dateStr = applyTransform(rawValue, transform, transformOptions);

      // Parse ngày cần chọn để biết day, month, year
      const dayjs = require("dayjs");
      const targetDate = dayjs(rawValue);
      if (!targetDate.isValid()) {
        throw new Error(
          `[datepicker_radix] Không parse được ngày: "${rawValue}"`
        );
      }

      const targetDay = targetDate.date(); // 1-31
      const targetMonth = targetDate.month(); // 0-11 (dayjs)
      const targetYear = targetDate.year();

      console.log(
        `    📅 Mục tiêu: ngày ${targetDay}/${targetMonth + 1}/${targetYear}`
      );

      // Bước 1: Click trigger button để mở Dialog lịch
      const triggerBtn = await findElement(page, sel.trigger_button);
      await triggerBtn.click();
      console.log(`    🖱️  Đã click trigger, chờ Dialog lịch mở...`);
      await sleep(500);

      // Bước 2: Điều hướng đến đúng tháng/năm
      // Vòng lặp tối đa 36 lần (3 năm) để tránh vòng lặp vô tận
      const MAX_NAV = 36;
      for (let attempt = 0; attempt < MAX_NAV; attempt++) {
        // Đọc tháng/năm hiện tại đang hiển thị trên lịch
        // Radix thường render heading dạng: "Tháng 5 2026" hoặc "May 2026"
        const calendarHeading = page
          .locator('[role="dialog"] [role="heading"], .rdp-caption_label')
          .first();
        const headingText = await calendarHeading.textContent({
          timeout: 3000,
        });
        console.log(`    📆 Lịch đang hiển thị: "${headingText?.trim()}"`);

        // Tìm nút Previous / Next tháng
        // Radix dùng: button[name="previous-month"], button[name="next-month"]
        // Hoặc aria-label tương ứng
        const NAV_PREV_SELECTORS = [
          'button[name="previous-month"]',
          'button[aria-label*="tháng trước"], button[aria-label*="Previous"]',
          '[role="dialog"] button:has(svg):first-of-type',
        ];
        const NAV_NEXT_SELECTORS = [
          'button[name="next-month"]',
          'button[aria-label*="tháng sau"], button[aria-label*="Next"]',
          '[role="dialog"] button:has(svg):last-of-type',
        ];

        // Parse tháng/năm hiện tại từ heading
        // Thử match "MM/YYYY", "Tháng M YYYY", "Month YYYY"
        const currentDate = parseCalendarHeading(headingText || "");
        if (!currentDate) {
          console.warn(
            `    ⚠️  Không parse được heading lịch: "${headingText}". Bỏ qua điều hướng.`
          );
          break;
        }

        const monthDiff =
          (targetYear - currentDate.year) * 12 +
          (targetMonth - currentDate.month);

        if (monthDiff === 0) {
          // Đã đúng tháng rồi → thoát loop điều hướng
          console.log(
            `    ✔ Đang ở đúng tháng ${targetMonth + 1}/${targetYear}`
          );
          break;
        }

        // Click nút điều hướng
        if (monthDiff > 0) {
          const nextBtn = await findElement(page, NAV_NEXT_SELECTORS);
          await nextBtn.click();
          console.log(`    ➡️  Click Next (còn ${monthDiff} tháng nữa)`);
        } else {
          const prevBtn = await findElement(page, NAV_PREV_SELECTORS);
          await prevBtn.click();
          console.log(
            `    ⬅️  Click Prev (còn ${Math.abs(monthDiff)} tháng nữa)`
          );
        }
        await sleep(300);
      }

      // Bước 3: Click ô ngày trong lịch
      // Radix render mỗi ngày với: role="gridcell" > button, và aria-label="DD tháng MM năm YYYY"
      // Selector an toàn nhất: bắt theo text content đúng số ngày VÀ không bị disabled
      const DAY_SELECTORS = [
        `[role="gridcell"] button:not([disabled]):text-is("${targetDay}")`,
        `[role="gridcell"]:not([aria-disabled="true"]) button:text-is("${String(
          targetDay
        )}")`,
        `td[role="gridcell"] button[tabindex]:text-is("${targetDay}")`,
        `//td[@role='gridcell']//button[not(@disabled) and normalize-space(.)='${targetDay}']`,
      ];

      const dayCell = await findElement(page, DAY_SELECTORS);
      await dayCell.click();
      console.log(`    ✔ Đã click ngày ${targetDay}.`);

      // Chờ dialog đóng lại (Radix tự đóng sau khi chọn ngày)
      await sleep(500);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // SELECT_NATIVE — Thẻ <select> HTML chuẩn.
    // Dùng page.selectOption() — API Playwright hỗ trợ chọn theo value, label, hoặc index.
    // ──────────────────────────────────────────────────────────────────────────
    case "select_native": {
      const el = await findElement(page, selector);
      await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

      // finalValue đã được transform (VD: map_value "cmnd" → "1")
      await el.selectOption(finalValue);
      console.log(`    ✔ selectOption("${finalValue}") thành công.`);
      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CUSTOM_SELECT — Dropdown tùy biến có <select> ẩn + trigger button hiển thị.
    //
    // Chiến lược 2 bước:
    //   Thử 1 (nhanh & ổn định): page.selectOption() trực tiếp trên <select> ẩn.
    //     → Playwright có thể set value vào hidden element, bypass UI hoàn toàn.
    //   Thử 2 (fallback): Giả lập click UI — click trigger button → click item text.
    //     → Dùng khi web có JS listener trên select element cần trigger change event.
    // ──────────────────────────────────────────────────────────────────────────
    case "custom_select": {
      const sel = selector; // { hidden_select: [...], trigger_button: [...] }
      const displayValue = finalValue; // Giá trị hiển thị (đã qua map_value)

      // Thử 1: Tìm và select thẻ <select> ẩn
      let strategy1Success = false;
      try {
        const hiddenSelect = await findElement(page, sel.hidden_select, 3000);
        // Thử chọn theo value nội bộ (key) trước, rồi theo label hiển thị
        const masterKey = masterData[fieldConfig.master_field];
        await hiddenSelect.selectOption([
          { value: masterKey },
          { label: displayValue },
        ]);
        console.log(
          `    ✔ [custom_select Strategy 1] selectOption trên hidden <select> thành công.`
        );
        strategy1Success = true;
      } catch (e) {
        console.warn(
          `    ⚠️  [custom_select Strategy 1] Không được: ${e.message}. Thử Strategy 2...`
        );
      }

      // Thử 2: Giả lập click UI nếu Strategy 1 thất bại
      if (!strategy1Success) {
        const triggerBtn = await findElement(page, sel.trigger_button);
        await triggerBtn.click();
        console.log(
          `    🖱️  [custom_select Strategy 2] Click trigger button mở dropdown...`
        );
        await sleep(400);

        // Tìm item có text khớp với displayValue (đã được map sang giá trị hiển thị)
        const itemLocator = page
          .locator(
            `[role="option"]:text-is("${displayValue}"), ` +
              `li:text-is("${displayValue}"), ` +
              `.p-dropdown-item:text-is("${displayValue}")`
          )
          .first();

        await itemLocator.waitFor({ state: "visible", timeout: 5000 });
        await itemLocator.click();
        console.log(
          `    ✔ [custom_select Strategy 2] Đã click item "${displayValue}".`
        );
      }

      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CHECKBOX_CLICK — Checkbox (hoặc button[role="checkbox"]).
    //
    // Luồng:
    //   1. Đọc trạng thái checked hiện tại (aria-checked)
    //   2. So sánh với giá trị mong muốn (true/false từ masterData)
    //   3. Chỉ click nếu trạng thái chưa đúng (idempotent)
    // ──────────────────────────────────────────────────────────────────────────
    case "checkbox_click": {
      const wantChecked =
        rawValue === true || rawValue === "true" || rawValue === "1";
      const el = await findElement(page, selector);

      // Đọc trạng thái hiện tại qua aria-checked attribute
      const ariaChecked = await el.getAttribute("aria-checked");
      const isChecked = ariaChecked === "true";

      if (wantChecked !== isChecked) {
        await el.click({ force: true });
        console.log(`    ✔ Checkbox toggled: ${isChecked} → ${wantChecked}`);
      } else {
        console.log(
          `    ✔ Checkbox đã đúng trạng thái (${isChecked}), bỏ qua click.`
        );
      }

      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // EXTRACT_AND_FILL — Đọc value từ selector nguồn, transform, điền sang selector đích.
    //
    // Use case: Trường "Số vệ tinh" trên Viettel:
    //   Bot đọc value của #deviceId1 → lấy 9 ký tự cuối → điền vào #sovetinh
    //   Trường này KHÔNG xuất hiện trên Master Form.
    // ──────────────────────────────────────────────────────────────────────────
    case "extract_and_fill": {
      const sel = selector; // { source: [...], destination: [...] }

      // Bước 1: Đọc value từ element nguồn
      const sourceEl = await findElement(page, sel.source);
      const sourceValue = await sourceEl.inputValue(); // lấy value của input
      console.log(`    📖 Đọc từ source: "${sourceValue}"`);

      // Bước 2: Apply transform (VD: extract_last_n_chars với n=9)
      const transformedValue = applyTransform(
        sourceValue,
        transform,
        transformOptions
      );
      console.log(`    🔄 Sau transform "${transform}": "${transformedValue}"`);

      // Bước 3: Điền vào element đích
      const destEl = await findElement(page, sel.destination);
      await destEl.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await safeFill(destEl, transformedValue);

      console.log(`    ✔ Đã điền "${transformedValue}" vào destination.`);
      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // STATIC_FILL — Điền giá trị cố định, không phụ thuộc Master Form.
    // VD: Chủng loại = "S-Tracking", Màu vỏ tàu = "Xanh", Ntime = "3600"
    // ──────────────────────────────────────────────────────────────────────────
    case "static_fill": {
      if (static_value === undefined || static_value === null) {
        throw new Error(
          `[executeAction] action_type "static_fill" yêu cầu "static_value" trong config.`
        );
      }

      const el = await findElement(page, selector);
      await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await safeFill(el, String(static_value));
      console.log(`    ✔ Static value "${static_value}" đã được điền.`);
      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // COMPUTED_DATE — Tính ngày từ today() + offset, điền vào input.
    // transform = 'computed_date' đã xử lý logic tính toán.
    // VD: Ngày sản xuất = today, Ngày hết hạn = today + 5 năm
    // ──────────────────────────────────────────────────────────────────────────
    case "computed_date": {
      // computed_date không cần rawValue từ masterData
      const computedValue = applyTransform(
        null,
        "computed_date",
        transformOptions
      );
      console.log(`    🗓️  Ngày tính toán: "${computedValue}"`);

      const el = await findElement(page, selector);
      await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await safeFill(el, computedValue);
      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // CONDITIONAL_FILL — Chỉ điền khi điều kiện thoả mãn.
    // Thêm: chờ element chuyển sang enabled trước khi fill.
    // VD: "Giá trị khuyến mãi" chỉ fill khi loai_khuyen_mai !== "none"
    // ──────────────────────────────────────────────────────────────────────────
    case "conditional_fill": {
      // Kiểm tra điều kiện
      if (condition) {
        const condValue = masterData[condition.field];
        const condPassed = evaluateCondition(
          condValue,
          condition.operator,
          condition.value
        );

        if (!condPassed) {
          console.log(
            `    ⏭️  Điều kiện không thoả: ${condition.field} ${condition.operator} "${condition.value}". Bỏ qua trường này.`
          );
          return; // Thoát sớm, không fill
        }
        console.log(
          `    ✔ Điều kiện thoả: ${condition.field} ${condition.operator} "${condition.value}"`
        );
      }

      // Chờ element trở thành enabled (không còn disabled)
      const el = await findElement(page, selector);
      if (wait_for_enabled) {
        console.log(`    ⏳ Chờ element enabled...`);
        await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

        // Polling chờ enabled tối đa 10s (disabled có thể do JS ẩn/hiện)
        const MAX_WAIT = 10000;
        const POLL = 300;
        let elapsed = 0;
        while (elapsed < MAX_WAIT) {
          const isDisabled = await el.isDisabled();
          if (!isDisabled) break;
          await sleep(POLL);
          elapsed += POLL;
        }

        const stillDisabled = await el.isDisabled();
        if (stillDisabled) {
          throw new Error(
            `[conditional_fill] Element vẫn disabled sau ${MAX_WAIT}ms.`
          );
        }
        console.log(`    ✔ Element đã enabled sau ${elapsed}ms.`);
      }

      if (pre_action === "clear") await el.clear();
      await safeFill(el, finalValue);
      await sleep(SHORT_PAUSE);
      break;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // DEFAULT — action_type không được định nghĩa
    // ──────────────────────────────────────────────────────────────────────────
    default: {
      throw new Error(
        `[executeAction] action_type không hợp lệ: "${action_type}". ` +
          `Field: "${label_vi}". Kiểm tra lại mapping.json.`
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: evaluateCondition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * So sánh giá trị thực tế với điều kiện trong config.
 * Hỗ trợ: equals, not_equals, gt, lt, truthy, falsy
 */
function evaluateCondition(actualValue, operator, expectedValue) {
  switch (operator) {
    case "equals":
      return String(actualValue) === String(expectedValue);
    case "not_equals":
      return String(actualValue) !== String(expectedValue);
    case "gt":
      return Number(actualValue) > Number(expectedValue);
    case "lt":
      return Number(actualValue) < Number(expectedValue);
    case "truthy":
      return !!actualValue;
    case "falsy":
      return !actualValue;
    default:
      console.warn(
        `  ⚠️  [evaluateCondition] Operator không hỗ trợ: "${operator}". Mặc định = true.`
      );
      return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: parseCalendarHeading (dùng trong datepicker_radix)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse text heading của Radix Calendar (VD: "Tháng 5 2026", "May 2026", "05/2026")
 * Trả về { month: 0-11, year: number } hoặc null nếu không parse được.
 */
function parseCalendarHeading(text) {
  const t = text.trim();

  // Pattern: "Tháng 5 2026" hoặc "tháng 05 2026"
  const vnMatch = t.match(/tháng\s+(\d{1,2})\s+(\d{4})/i);
  if (vnMatch) {
    return {
      month: parseInt(vnMatch[1], 10) - 1,
      year: parseInt(vnMatch[2], 10),
    };
  }

  // Pattern: "May 2026" (English month name)
  const MONTHS_EN = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const enMatch = t.match(/(\w+)\s+(\d{4})/);
  if (enMatch) {
    const monthIdx = MONTHS_EN.indexOf(enMatch[1].toLowerCase());
    if (monthIdx !== -1) {
      return { month: monthIdx, year: parseInt(enMatch[2], 10) };
    }
  }

  // Pattern: "05/2026" hoặc "5/2026"
  const numMatch = t.match(/(\d{1,2})\/(\d{4})/);
  if (numMatch) {
    return {
      month: parseInt(numMatch[1], 10) - 1,
      year: parseInt(numMatch[2], 10),
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  findElement,
  executeAction,
};
