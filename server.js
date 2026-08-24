/**
 * server.js
 * =========
 * Express backend — phục vụ Master Form UI và điều phối automation.
 *
 * CSKH   → Direct DB Insert vào Supabase (cskh-db-handler.js) — không dùng browser
 * Viettel → Playwright automation (cauhinh-handler.js) — vẫn dùng browser
 *
 * Khởi động: node server.js
 * Truy cập:  http://localhost:3000
 */

"use strict";

const path = require("path");
const fs = require("fs");

const isPkg = !!process.pkg;
const APP_ROOT = isPkg ? path.dirname(process.execPath) : __dirname;

function appPath(...parts) {
  return path.join(APP_ROOT, ...parts);
}

function bundledPath(...parts) {
  return path.join(__dirname, ...parts);
}

require("dotenv").config({ path: appPath(".env") }); // Load .env sớm nhất có thể

const express = require("express");
const multer = require("multer");

const { createClient } = require("@supabase/supabase-js");
const {
  runAutomation,
  formatSkippedResult,
} = require("./automation/run-automation"); // orchestrator dùng chung (HTTP + worker)
const {
  extractFromImages,
} = require("./automation/image-extract-handler"); // AI đọc ảnh giấy tờ
const captchaBridge = require("./automation/captcha-bridge"); // captcha BCCS ↔ giao diện
const billingBridge = require("./automation/billing-bridge"); // sửa Địa chỉ hóa đơn cước ↔ giao diện

// Supabase client dùng cho các API nhẹ (search, lookup) — không phải automation
const _supabaseUrl = (process.env.SUPABASE_URL || "")
  .replace(/\/rest\/v1\/?$/, "")
  .replace(/\/$/, "");
const _supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase =
  _supabaseUrl && _supabaseKey
    ? createClient(_supabaseUrl, _supabaseKey, {
        auth: { persistSession: false },
      })
    : null;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — Chỉnh tại đây, không cần sửa code bên dưới
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  headless: false, // false = thấy browser (dễ debug); true = chạy ẩn
  slowMo: 60, // ms delay giữa các action Playwright
  run_mode: "parallel", // 'parallel' | 'sequential'
  logs_dir: appPath("logs", "runs"),
  errors_dir: appPath("logs", "errors"),
  request_timeout: 180_000, // 3 phút timeout cho toàn bộ automation
  address_api_base_url: (
    process.env.ADDRESS_API_BASE_URL || "https://provinces.open-api.vn/api/v1"
  ).replace(/\/$/, ""),

  // ── TEST MODE (độc lập từng hệ thống) ────────────────────────────────────
  // cskh:    false → Ghi thật vào Supabase DB
  //          true  → Dry-run: in payload ra console, KHÔNG insert
  // cauhinh: false → Playwright click Lưu từng form, lưu vào Viettel DB
  //          true  → Playwright điền form nhưng KHÔNG click Lưu, gọi page.pause()
  //                  Browser luôn hiện khi cauhinh test_mode = true
  // ──────────────────────────────────────────────────────────────────────────
  // Đọc từ .env để đổi test/thật KHÔNG cần build lại (chỉ cần sửa .env + khởi động lại).
  // true = chạy nháp (điền hết nhưng KHÔNG lưu/đấu nối). Mặc định: BCCS nháp, CSKH/Viettel thật.
  test_mode: {
    cskh: /^true$/i.test(process.env.CSKH_TEST_MODE || "false"),
    cauhinh: /^true$/i.test(process.env.CAUHINH_TEST_MODE || "false"),
    bccs: /^true$/i.test(process.env.BCCS_TEST_MODE || "true"),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(bundledPath("public")));

const UPLOADS_DIR = appPath("logs", "uploads");
const ADDRESS_CONVERT_DB_PATH = appPath("data", "address-convert-map.json");
fs.mkdirSync(CONFIG.logs_dir, { recursive: true });
fs.mkdirSync(CONFIG.errors_dir, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Multer — lưu file tạm vào logs/uploads/ ────────────────────────────────
const _multerStorage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${ts}_${file.fieldname}_${safe}`);
  },
});
const upload = multer({
  storage: _multerStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB mỗi file
});

const UPLOAD_FIELDS = [
  { name: "file_bbnt", maxCount: 1 },
  { name: "file_cmnd_sau", maxCount: 1 },
  { name: "file_cmnd_truoc", maxCount: 1 },
  { name: "file_hop_dong", maxCount: 1 },
  { name: "file_phu_luc", maxCount: 1 },
];

// ─── Ảnh cho AI trích xuất (điền form tự động) ──────────────────────────────
// field name (multipart)  →  slot key mà image-extract-handler hiểu
const EXTRACT_FIELD_TO_SLOT = {
  img_device: "device",
  img_cccd_front: "cccd_front",
  img_cccd_back: "cccd_back",
  img_ship: "ship",
  img_captain: "captain",
  img_fishing_license: "fishing_license",
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Lưu log chạy ra file JSON
// ─────────────────────────────────────────────────────────────────────────────
function saveRunLog(masterData, results, totalDuration) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `run_${timestamp}.json`;
  const filepath = path.join(CONFIG.logs_dir, filename);

  const logEntry = {
    timestamp: new Date().toISOString(),
    run_mode: CONFIG.run_mode,
    test_mode: CONFIG.test_mode, // { cskh: bool, cauhinh: bool }
    total_duration_ms: totalDuration,
    input: {
      ship_code: masterData.ship_code,
      serial_number: masterData.serial_number,
      owner_name: masterData.owner_name,
    },
    results,
  };

  try {
    fs.writeFileSync(filepath, JSON.stringify(logEntry, null, 2), "utf8");
    return filename;
  } catch (err) {
    console.error(`⚠️  Không thể lưu log: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Validate masterData tối thiểu
// ─────────────────────────────────────────────────────────────────────────────
function validateMasterData(data) {
  const REQUIRED = [
    "ship_code",
    "serial_number",
    "owner_name",
    "owner_phone",
    "owner_cccd",
    "owner_address_province",
    "owner_address_district",
    "owner_address_precinct",
    "owner_address_group_street",
    "owner_address_street",
    "so_thang",
  ];
  return REQUIRED.filter((k) => {
    const v = data[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

// (formatSettledResult / formatSkippedResult đã chuyển sang automation/run-automation.js)

// ─────────────────────────────────────────────────────────────────────────────
// API: POST /api/login
// Xác thực người dùng qua Supabase Auth.
// Nhận { username, password } — tự ghép domain thành email đầy đủ.
// ─────────────────────────────────────────────────────────────────────────────
const LOGIN_DOMAIN = process.env.LOGIN_DOMAIN || "@sdvico.local";

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password." });
  }
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }

  const email = username.includes("@") ? username : username + LOGIN_DOMAIN;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      console.warn(`[login] Thất bại cho "${username}": ${error.message}`);
      return res
        .status(401)
        .json({ error: "Tên đăng nhập hoặc mật khẩu không đúng." });
    }
    const id = data.user?.id ?? null;
    console.log(`[login] ✅ "${username}" đăng nhập thành công — id: ${id}`);
    return res.json({ id, username });
  } catch (err) {
    console.error(`[login] Lỗi server: ${err.message}`);
    return res.status(500).json({ error: "Lỗi server nội bộ." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/search-account?q=...
// Tìm kiếm tương đối trong bảng account theo tên (ilike), trả về name + phone
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/search-account", async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }
  try {
    const { data, error } = await supabase
      .from("accounts")
      .select("name, phone")
      .ilike("name", `%${q}%`)
      .limit(10);
    if (error) throw error;
    res.json({ results: data ?? [] });
  } catch (err) {
    console.error(`[search-account] Lỗi: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/search-ship?q=...
// Tìm kiếm tương đối trong bảng vnf_data theo cột so_dang_ky (ilike), trả về mảng mã tàu
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/search-ship", async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }
  try {
    const { data, error } = await supabase
      .from("vnf_data")
      .select("so_dang_ky")
      .ilike("so_dang_ky", `%${q}%`)
      .limit(10);
    if (error) throw error;
    const results = (data ?? []).map((r) => r.so_dang_ky).filter(Boolean);
    res.json({ results });
  } catch (err) {
    console.error(`[search-ship] Lỗi: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/search-serial?q=...
// Tìm kiếm tương đối trong bảng order_item_serials theo cột serial_number (ilike)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/search-serial", async (req, res) => {
  const q = (req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  if (!supabase) {
    return res.status(503).json({ error: "Supabase chưa được cấu hình." });
  }
  try {
    const { data, error } = await supabase
      .from("order_item_serials")
      .select("serial_number")
      .ilike("serial_number", `%${q}%`)
      .limit(10);
    if (error) throw error;
    const results = (data ?? []).map((r) => r.serial_number).filter(Boolean);
    res.json({ results });
  } catch (err) {
    console.error(`[search-serial] Lỗi: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: POST /api/run-automation
// ─────────────────────────────────────────────────────────────────────────────
app.post(
  "/api/run-automation",
  upload.fields(UPLOAD_FIELDS),
  async (req, res) => {
    console.log(
      `\n>>> [API] POST /api/run-automation nhận được — ${new Date().toLocaleTimeString(
        "vi-VN"
      )}`
    );
    const startTime = Date.now();
    captchaBridge.clear(); // dọn phiên captcha cũ (nếu có) trước khi chạy
    billingBridge.clear(); // dọn phiên sửa địa chỉ cũ (nếu có)

    // masterData gửi lên dưới dạng JSON string trong multipart field "masterData"
    let masterData;
    try {
      masterData = JSON.parse(req.body?.masterData || "{}");
    } catch {
      return res.status(400).json({
        success: false,
        error:
          "Không thể parse masterData — phải là JSON string trong FormData.",
      });
    }

    if (!masterData || typeof masterData !== "object") {
      return res.status(400).json({
        success: false,
        error: 'Request body phải có field "masterData" chứa JSON.',
      });
    }

    // Gắn đường dẫn file temp vào masterData để bccs-handler dùng
    UPLOAD_FIELDS.forEach(({ name }) => {
      masterData[name] = req.files?.[name]?.[0]?.path ?? null;
    });

    const _uploadedPaths = UPLOAD_FIELDS.map(
      ({ name }) => masterData[name]
    ).filter(Boolean);
    if (_uploadedPaths.length > 0) {
      console.log(
        `  📎 File đính kèm: ${_uploadedPaths
          .map((p) => path.basename(p))
          .join(", ")}`
      );
    }

    const missingFields = validateMasterData(masterData);
    if (missingFields.length > 0) {
      _uploadedPaths.forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* bỏ qua */
        }
      });
      return res.status(400).json({
        success: false,
        error: `Thiếu các trường bắt buộc: ${missingFields.join(", ")}`,
        missing: missingFields,
      });
    }

    console.log("\n" + "═".repeat(60));
    console.log(
      `📨 [API] Nhận request — ${new Date().toLocaleString("vi-VN")}`
    );
    console.log(
      `   Tàu: ${masterData.ship_code} | Serial: ${masterData.serial_number}`
    );
    console.log(
      `   Chủ tàu: ${masterData.owner_name} | Chế độ: ${CONFIG.run_mode}`
    );

    // ── Chạy automation qua orchestrator dùng chung ──────────────────────────
    // captcha bỏ trống → BCCS dùng cầu nối localhost (ảnh hiện lên giao diện tool).
    let results;
    try {
      const outcome = await runAutomation(masterData, {
        config: {
          headless: CONFIG.headless,
          slowMo: CONFIG.slowMo,
          run_mode: CONFIG.run_mode,
        },
        testMode: CONFIG.test_mode,
      });

      if (outcome.ranNothing) {
        return res.status(400).json({
          success: false,
          error: "Vui lòng bật ít nhất một luồng cần chạy.",
          results: outcome.results,
        });
      }
      results = outcome.results;
    } finally {
      // Xoá file upload tạm sau khi automation xong
      _uploadedPaths.forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* bỏ qua */
        }
      });
      if (_uploadedPaths.length > 0) {
        console.log(`  🗑️  Đã xoá ${_uploadedPaths.length} file tạm.`);
      }
    }

    const totalDuration = Date.now() - startTime;
    const activeResults = Object.values(results).filter(
      (item) => item && !item.skipped
    );
    const overallSuccess =
      activeResults.length > 0 && activeResults.every((item) => item.success);
    const partialSuccess =
      activeResults.some((item) => item.success) &&
      activeResults.some((item) => !item.success);
    const logFile = saveRunLog(masterData, results, totalDuration);

    console.log("\n" + "═".repeat(60));
    const testSuffix = [
      CONFIG.test_mode.cskh ? "CSKH🧪" : "",
      CONFIG.test_mode.cauhinh ? "Viettel🧪" : "",
      CONFIG.test_mode.bccs ? "BCCS🧪" : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${overallSuccess ? "✅" : "⚠️ "} [API] Kết thúc — ${(
        totalDuration / 1000
      ).toFixed(1)}s${testSuffix ? `  [TEST: ${testSuffix}]` : ""}`
    );
    console.log(
      `   CSKH:     ${
        results.cskh.skipped
          ? "⏭️ SKIP"
          : results.cskh.success
          ? "✅ OK"
          : "❌ " + results.cskh.error
      }`
    );
    console.log(
      `   Cấu hình: ${
        results.cauhinh.skipped
          ? "⏭️ SKIP"
          : results.cauhinh.success
          ? "✅ OK"
          : "❌ " + results.cauhinh.error
      }`
    );
    console.log(
      `   BCCS:     ${
        results.bccs.skipped
          ? "⏭️ SKIP"
          : results.bccs.success
          ? "✅ OK"
          : "❌ " + results.bccs.error
      }`
    );
    if (logFile) console.log(`   Log: logs/runs/${logFile}`);
    console.log("═".repeat(60) + "\n");

    res.json({
      success: overallSuccess,
      partial_success: partialSuccess,
      test_mode: CONFIG.test_mode, // { cskh: bool, cauhinh: bool }
      automation_options: {
        run_cskh: !results.cskh.skipped,
        run_cauhinh: !results.cauhinh.skipped,
        run_bccs: !results.bccs.skipped,
      },
      results,
      total_duration_ms: totalDuration,
      log_file: logFile,
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// API: POST /api/extract-image
// Nhận tối đa 5 ảnh giấy tờ → AI đọc → trả JSON { fields, captain_is_owner, notes }
// để frontend tự điền vào form. Bật IMAGE_EXTRACT_MOCK=true để test miễn phí.
// ─────────────────────────────────────────────────────────────────────────────
// upload.any() + bắt lỗi → luôn trả JSON (không rơi vào HTML error page của Express),
// và dung nạp field lạ (không crash "Unexpected field" nếu frontend/server lệch phiên bản).
function extractUpload(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        error: "Lỗi khi tải ảnh lên: " + err.message,
        fields: {},
        notes: [],
      });
    }
    next();
  });
}

app.post("/api/extract-image", extractUpload, async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  // Đường dẫn của MỌI file đã upload (kể cả field lạ) — để xoá sạch ở cuối
  const allUploadedPaths = files.map((f) => f.path).filter(Boolean);
  const cleanup = () =>
    allUploadedPaths.forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* bỏ qua */
      }
    });

  const slots = [];
  for (const f of files) {
    const slotKey = EXTRACT_FIELD_TO_SLOT[f.fieldname];
    if (slotKey && f.path) slots.push({ key: slotKey, path: f.path });
  }

  if (slots.length === 0) {
    cleanup();
    return res.status(400).json({
      success: false,
      error: "Chưa chọn ảnh nào để đọc.",
      fields: {},
      notes: [],
    });
  }

  console.log(
    `\n📷 [API] POST /api/extract-image — ${slots.length} ảnh (${slots
      .map((s) => s.key)
      .join(", ")})`
  );

  try {
    const result = await extractFromImages(slots);
    return res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error(`❌ [extract-image] Lỗi server: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: err.message,
      fields: {},
      notes: [],
    });
  } finally {
    cleanup(); // Xoá ảnh tạm — không giữ giấy tờ cá nhân trên đĩa
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/logs
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// API: Vietnam address proxy
// ─────────────────────────────────────────────────────────────────────────────
function normalizeAddressName(name) {
  return String(name || "")
    .trim()
    .replace(/^(Tỉnh|Thành phố|Thị xã|Thị trấn|Phường|Quận|Huyện|Xã)\s+/i, "")
    .replace(/\s*-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAddressResults(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      code: item?.code,
      name: normalizeAddressName(item?.name),
    }))
    .filter((item) => item.code !== undefined && item.name);
}

async function fetchAddressApi(pathname, params = {}) {
  const url = new URL(CONFIG.address_api_base_url + pathname);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      url.searchParams.set(key, String(value).trim());
    }
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`Address API HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAddressText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
}

function normalizeConvertedAddressText(value) {
  return normalizeAddressText(value)
    .split(",")
    .map((part) => normalizeAddressText(part))
    .filter(Boolean)
    .join(", ");
}

function stripVietnamese(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function addressLookupPart(value) {
  return stripVietnamese(normalizeAddressName(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addressLookupKey(province, district, ward) {
  return [
    addressLookupPart(province),
    addressLookupPart(district),
    addressLookupPart(ward),
  ].join("|");
}

let addressConvertDb = null;

function loadAddressConvertDb() {
  if (addressConvertDb) return addressConvertDb;
  if (!fs.existsSync(ADDRESS_CONVERT_DB_PATH)) {
    throw new Error(
      `Missing local address convert DB: ${ADDRESS_CONVERT_DB_PATH}`
    );
  }

  const payload = JSON.parse(fs.readFileSync(ADDRESS_CONVERT_DB_PATH, "utf8"));
  const records = Array.isArray(payload.records) ? payload.records : [];
  const byKey = new Map();
  for (const record of records) {
    const key =
      record.key ||
      addressLookupKey(record.oldProvince, record.oldDistrict, record.oldWard);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(record);
  }
  addressConvertDb = { meta: payload.meta || {}, records, byKey };
  return addressConvertDb;
}

function uniqueAddressTargets(records) {
  const seen = new Set();
  const targets = [];
  for (const record of records) {
    const target = {
      newProvince: normalizeAddressText(record.newProvince),
      newWard: normalizeAddressText(record.newWard),
      newWardCode: record.newWardCode || "",
    };
    const key = `${target.newProvince}|${target.newWard}`;
    if (!target.newProvince || !target.newWard || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function parseLegacyAddress(address) {
  const parts = normalizeAddressText(address)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    ward: parts.at(-3) || "",
    district: parts.at(-2) || "",
    province: parts.at(-1) || "",
  };
}

function convertAddressLocal({ address, province, district, ward }) {
  const parsed = parseLegacyAddress(address);
  const oldProvince = normalizeAddressText(province || parsed.province);
  const oldDistrict = normalizeAddressText(district || parsed.district);
  const oldWard = normalizeAddressText(ward || parsed.ward);
  if (!oldProvince || !oldDistrict || !oldWard) {
    return {
      success: false,
      error:
        "Missing province, district, or ward for local address conversion.",
    };
  }

  const db = loadAddressConvertDb();
  const key = addressLookupKey(oldProvince, oldDistrict, oldWard);
  const matches = db.byKey.get(key) || [];
  if (!matches.length) {
    return {
      success: false,
      noMatch: true,
      error: "No local address mapping found.",
      key,
      input: { province: oldProvince, district: oldDistrict, ward: oldWard },
    };
  }

  const targets = uniqueAddressTargets(matches);
  if (targets.length !== 1) {
    return {
      success: false,
      ambiguous: true,
      error: "Local address mapping is ambiguous.",
      key,
      input: { province: oldProvince, district: oldDistrict, ward: oldWard },
      results: targets,
    };
  }

  const target = targets[0];
  const converted = normalizeConvertedAddressText(
    [target.newWard, target.newProvince].join(", ")
  );
  return {
    success: true,
    converted,
    input: { province: oldProvince, district: oldDistrict, ward: oldWard },
    match: matches[0],
  };
}

app.get("/api/address/provinces", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const data = q
      ? await fetchAddressApi("/p/search/", { q })
      : await fetchAddressApi("/p/");
    res.json({ success: true, results: normalizeAddressResults(data) });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message, results: [] });
  }
});

app.get("/api/address/districts", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const provinceCode = req.query.provinceCode || req.query.p;
    let data;
    if (q) {
      data = await fetchAddressApi("/d/search/", { q, p: provinceCode });
    } else if (provinceCode) {
      const province = await fetchAddressApi(
        `/p/${encodeURIComponent(provinceCode)}`,
        { depth: 2 }
      );
      data = province?.districts || [];
    } else {
      data = await fetchAddressApi("/d/");
    }
    res.json({ success: true, results: normalizeAddressResults(data) });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message, results: [] });
  }
});

app.get("/api/address/wards", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const districtCode = req.query.districtCode || req.query.d;
    const provinceCode = req.query.provinceCode || req.query.p;
    let data;
    if (q) {
      data = await fetchAddressApi("/w/search/", {
        q,
        d: districtCode,
        p: provinceCode,
      });
    } else if (districtCode) {
      const district = await fetchAddressApi(
        `/d/${encodeURIComponent(districtCode)}`,
        { depth: 2 }
      );
      data = district?.wards || [];
    } else {
      data = await fetchAddressApi("/w/");
    }
    res.json({ success: true, results: normalizeAddressResults(data) });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message, results: [] });
  }
});

app.post("/api/address/convert-new", async (req, res) => {
  try {
    const address = normalizeAddressText(req.body?.address);
    const province = normalizeAddressText(req.body?.province);
    const district = normalizeAddressText(req.body?.district);
    const ward = normalizeAddressText(req.body?.ward || req.body?.precinct);
    if (!address && !(province && district && ward)) {
      return res.status(400).json({
        success: false,
        error: "Missing address or structured province/district/ward.",
      });
    }

    const result = convertAddressLocal({ address, province, district, ward });
    res.json(result);
  } catch (err) {
    console.warn("[address-convert] failed", {
      input: req.body?.address,
      error: err.message,
    });
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: Captcha BCCS — bàn giao cho người dùng nhập qua giao diện
//   GET  /api/bccs/captcha         → ảnh captcha đang chờ (nếu có)
//   POST /api/bccs/captcha         → { id, code } gửi mã
//   POST /api/bccs/captcha/reload  → { id } đổi mã captcha
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/bccs/captcha", (_req, res) => {
  const pending = captchaBridge.getPending();
  res.json(pending || { none: true });
});

app.post("/api/bccs/captcha", (req, res) => {
  const { id, code } = req.body ?? {};
  if (!id) return res.status(400).json({ ok: false, error: "Thiếu id." });
  const ok = captchaBridge.answer(id, code);
  res.json({ ok });
});

app.post("/api/bccs/captcha/reload", (req, res) => {
  const { id } = req.body ?? {};
  if (!id) return res.status(400).json({ ok: false, error: "Thiếu id." });
  const ok = captchaBridge.reload(id);
  res.json({ ok });
});

// ─────────────────────────────────────────────────────────────────────────────
// BILLING (sửa Địa chỉ hóa đơn cước — master form)
//   GET  /api/bccs/billing  → { id, value } | { none:true }
//   POST /api/bccs/billing  → { id, value } gửi địa chỉ đã sửa
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/bccs/billing", (_req, res) => {
  const pending = billingBridge.getPending();
  res.json(pending || { none: true });
});

app.post("/api/bccs/billing", (req, res) => {
  const { id, value } = req.body ?? {};
  if (!id) return res.status(400).json({ ok: false, error: "Thiếu id." });
  const ok = billingBridge.answer(id, value);
  res.json({ ok });
});

app.get("/api/logs", (_req, res) => {
  try {
    const files = fs
      .readdirSync(CONFIG.logs_dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 20);

    const logs = files.map((filename) => {
      try {
        const content = JSON.parse(
          fs.readFileSync(path.join(CONFIG.logs_dir, filename), "utf8")
        );
        return { filename, ...content };
      } catch {
        return { filename, error: "Không đọc được file" };
      }
    });

    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/config — Trả về config hiện tại (để frontend hiển thị badge)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    test_mode: CONFIG.test_mode,
    run_mode: CONFIG.run_mode,
    headless: CONFIG.headless,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API: GET /api/scrape-vas-address
// Quét Tỉnh/Huyện/Xã (mã VAS) từ F9 địa chỉ KH của SFive → tải về file JSON.
// Chạy TRÊN MÁY SFIVE: mở 1 job BCCS test (SFive mở, tới captcha), mở modal
// "Địa chỉ" của khách hàng, rồi mở URL này trong trình duyệt của máy SFive.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/scrape-vas-address", async (req, res) => {
  const { scrapeVasAddress } = require("./automation/scrape-vas");
  const outPath = appPath("logs", "vas-address.json");
  // Quét 4 cấp có thể ~30-60 phút → bỏ timeout request; ghi đĩa dần sau mỗi tỉnh.
  try { req.setTimeout(0); res.setTimeout(0); if (req.socket) req.socket.setTimeout(0); } catch {}

  const countG = (p) =>
    (p.districts || []).reduce((a, d) => a + (d.wards || []).reduce((x, w) => x + (w.groupStreets ? w.groupStreets.length : 0), 0), 0);
  const countW = (p) => (p.districts || []).reduce((a, d) => a + (d.wards ? d.wards.length : 0), 0);

  try {
    console.log(`\n🗺️  [scrape-vas] Bắt đầu quét 4 cấp (Tỉnh→Huyện→Xã→Tổ/thôn) — có thể ~30-60 phút.`);
    console.log(`   Ghi dần vào: ${outPath}`);
    // RESUME: đọc file cũ (nếu có) để chỉ quét tỉnh còn thiếu.
    let existing = [];
    try {
      if (fs.existsSync(outPath)) {
        const prev = JSON.parse(fs.readFileSync(outPath, "utf8"));
        if (prev && Array.isArray(prev.provinces)) existing = prev.provinces;
        if (existing.length) console.log(`   ♻️  Đã có ${existing.length} tỉnh trong file — chỉ quét phần còn thiếu.`);
      }
    } catch (e) { console.warn("   ⚠️ đọc file cũ lỗi:", e.message); }

    const data = await scrapeVasAddress({
      existing,
      onProvince: (out, idx, total) => {
        try { fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8"); } catch (e) { console.warn("  ⚠️ ghi file lỗi:", e.message); }
        const p = out.provinces[out.provinces.length - 1];
        console.log(`🗺️  [scrape-vas] ${idx}/${total} ${p.name}: huyện ${(p.districts || []).length}, xã ${countW(p)}, tổ/thôn ${countG(p)}`);
      },
    });
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
    const provs = data.provinces || [];
    const nDist = provs.reduce((s, p) => s + (p.districts ? p.districts.length : 0), 0);
    const nWard = provs.reduce((s, p) => s + countW(p), 0);
    const nGrp = provs.reduce((s, p) => s + countG(p), 0);
    console.log(`🗺️  [scrape-vas] XONG → ${outPath}`);
    console.log(`   Tỉnh ${provs.length} | Huyện ${nDist} | Xã ${nWard} | Tổ/thôn ${nGrp}`);
    res.json({ success: true, file: outPath, provinces: provs.length, districts: nDist, wards: nWard, groupStreets: nGrp });
  } catch (err) {
    console.error("❌ [scrape-vas] Lỗi:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message, file_partial: outPath });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK SPA
// ─────────────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(bundledPath("public", "index.html"));
});

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(CONFIG.port, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║         AUTO ENTRY — MASTER CONTROL           ║
╠═══════════════════════════════════════════════╣
║  🌐  http://localhost:${CONFIG.port}                   ║
║  🤖  Chế độ:  ${
    CONFIG.run_mode === "parallel"
      ? "Song song (3 luồng độc lập) "
      : "Tuần tự (CSKH → Viettel → BCCS)"
  }  ║
║  👁️   Browser: ${
    CONFIG.headless && !CONFIG.test_mode.cauhinh
      ? "Ẩn (headless)              "
      : "Hiện (có thể thấy thao tác)"
  }  ║
║  📁  Logs:    ./logs/runs/                    ║
║  🗄️   CSKH:   ${
    CONFIG.test_mode.cskh
      ? "🧪 TEST — Không ghi Supabase  "
      : "🟢 THẬT — Ghi vào Supabase    "
  }  ║
║  🤖  Viettel: ${
    CONFIG.test_mode.cauhinh
      ? "🧪 TEST — Không click Lưu    "
      : "🟢 THẬT — Lưu vào Viettel DB "
  }  ║
║  🌐  BCCS:    ${
    CONFIG.test_mode.bccs
      ? "🧪 TEST — Không click Lưu    "
      : "🟢 THẬT — Lưu vào BCCS       "
  }  ║
╚═══════════════════════════════════════════════╝
${
  CONFIG.test_mode.cauhinh
    ? "\n  ⚠️  VIETTEL TEST MODE: Bot không click Lưu, gọi page.pause().\n"
    : ""
}${
    CONFIG.test_mode.cskh
      ? "  ⚠️  CSKH TEST MODE: Dry-run, không insert vào Supabase.\n"
      : ""
  }
  Nhấn Ctrl+C để dừng server.
`);

  // Timeout 12 phút cho mỗi request — luồng BCCS có thể chờ người dùng nhập captcha
  // qua giao diện (tối đa ~5 phút) nên cần dài hơn để không cắt kết nối giữa chừng.
  server.setTimeout(12 * 60 * 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
// WORKER MODE — nhận job remote từ Supabase (hub/điện thoại) và chạy automation.
// Bật bằng WORKER_ENABLED=true trong .env. Máy này vẫn phục vụ web local như cũ.
// ─────────────────────────────────────────────────────────────────────────────
if (String(process.env.WORKER_ENABLED || "").toLowerCase() === "true") {
  if (!supabase) {
    console.error(
      "❌ [worker] WORKER_ENABLED=true nhưng thiếu SUPABASE_URL/SERVICE_ROLE_KEY — bỏ qua worker."
    );
  } else {
    const { start: startWorker } = require("./automation/worker");
    const machineId = process.env.MACHINE_ID || "PC-01";
    startWorker({
      supabase,
      config: {
        headless: CONFIG.headless,
        slowMo: CONFIG.slowMo,
        run_mode: CONFIG.run_mode,
      },
      testMode: CONFIG.test_mode,
      machineId,
      label: process.env.MACHINE_LABEL || machineId,
      uploadsDir: UPLOADS_DIR,
      pollMs: Number(process.env.WORKER_POLL_MS) || 3000,
    });
  }
}
