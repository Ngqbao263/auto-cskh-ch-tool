/**
 * cskh-db-handler.js
 * ==================
 * Tạo phiếu đấu nối CSKH bằng cách gọi RPC create_connection_record trên Supabase.
 * RPC tự động: tạo connection_records + payment_collections + cập nhật linked_payment_collection_id.
 *
 * Logic mapping:
 *   - captain_is_owner = true  → copy toàn bộ thông tin chủ tàu sang thuyền trưởng
 *   - requester_is_owner = true → requester_name = owner_name
 *   - monthly_price mặc định 385,000 VNĐ
 *   - payment_snapshot được tính từ monthsCount × monthlyPrice - discount
 *
 * Lưu ý: RPC không nhận captain_* hoặc serial_number — các trường đó xử lý ở Viettel (cauhinh-handler).
 *
 * Test Mode:
 *   - true  → In rpcParams ra console, KHÔNG gọi RPC
 *   - false → Gọi RPC thật (tạo cả connection_records lẫn payment_collections)
 *
 * Export:
 *   insertCSKH(masterData, testMode?) → Promise<{ success, duration_ms, test_mode, inserted_id?, payment_id? }>
 */

"use strict";

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// ─── Khởi tạo Supabase Client ─────────────────────────────────────────────────
const RAW_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!RAW_URL || !SERVICE_KEY) {
  throw new Error(
    "[CSKH-DB] Thiếu biến môi trường.\n" +
      "  Cần: SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY trong file .env"
  );
}

// Chuẩn hoá URL: bỏ /rest/v1/ nếu có (SDK tự thêm)
const SUPABASE_URL = RAW_URL.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false }, // Server-side: không cần lưu session
});

// ─── Constants ────────────────────────────────────────────────────────────────
const RPC_NAME             = "create_connection_record"; // Gọi RPC giống web CSKH
const DEFAULT_MONTHLY_PRICE = 385_000;                  // VNĐ
const CREATE_BY            = "fb3b7e50-5bbd-41a1-a46f-e1b98d5798dd"; // ID admin/người tạo

// Map giá trị Master Form → label lưu vào DB
const PROMO_TYPE_LABEL = {
  none: null,
  fixed: "VNĐ",
  percent: "%",
  month: "Tháng",
};

// ─── Helper: Tính Payment Snapshot ───────────────────────────────────────────
/**
 * @returns {{
 *   monthlyPrice, monthsCount, promotionType, promotionValue,
 *   originalAmount, discountAmount, finalAmount, paidAmount, remainingDebt
 * }}
 */
function calcPaymentSnapshot(
  monthlyPrice,
  monthsCount,
  promotionType,
  promotionValue
) {
  const originalAmount = monthlyPrice * monthsCount;
  const pv = Number(promotionValue) || 0;

  let discountAmount = 0;
  if (promotionType === "month") discountAmount = monthlyPrice * pv;
  else if (promotionType === "percent")
    discountAmount = originalAmount * (pv / 100);
  else if (promotionType === "fixed") discountAmount = pv;

  const finalAmount = Math.max(0, originalAmount - discountAmount);

  return {
    monthlyPrice,
    monthsCount,
    promotionType: PROMO_TYPE_LABEL[promotionType] ?? null,
    promotionValue: promotionType !== "none" ? pv : null,
    originalAmount,
    discountAmount,
    finalAmount,
    paidAmount: 0,           // Chưa thu tiền — khớp với luồng web (thu tiền riêng sau)
    remainingDebt: finalAmount,
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────
async function insertCSKH(masterData, testMode = false) {
  const startTime = Date.now();

  console.log("\n" + "═".repeat(60));
  console.log(
    `🗄️  [CSKH-DB] Bắt đầu — Direct Insert vào Supabase${
      testMode ? "  🧪 [TEST MODE]" : ""
    }`
  );
  console.log(
    `   Tàu: ${masterData.ship_code}  |  S/N: ${masterData.serial_number}`
  );
  console.log("═".repeat(60));

  // ── 1. Giải quyết captain_is_owner / requester_is_owner ──────────────────
  const isCapOwner = masterData.captain_is_owner === true;
  const isReqOwner = masterData.requester_is_owner === true;

  if (isCapOwner)
    console.log(
      "  ℹ️  captain_is_owner=true → copy thông tin chủ tàu vào thuyền trưởng."
    );
  if (isReqOwner)
    console.log("  ℹ️  requester_is_owner=true → requester_name = owner_name.");

  const captainName = isCapOwner
    ? masterData.owner_name
    : masterData.captain_name ?? null;
  const captainPhone = isCapOwner
    ? masterData.owner_phone
    : masterData.captain_phone ?? null;
  const captainCccd = isCapOwner
    ? masterData.owner_cccd
    : masterData.captain_cccd ?? null;
  const captainAddress = isCapOwner
    ? masterData.owner_address
    : masterData.captain_address ?? null;

  const requesterName = isReqOwner
    ? masterData.owner_name
    : masterData.requester_name ?? null;
  const requesterPhone = isReqOwner
    ? masterData.owner_phone
    : masterData.requester_phone ?? null;

  // ── 2. Tính toán thanh toán ───────────────────────────────────────────────
  const monthsCount = Number(masterData.so_thang) || 1;
  const promotionType = masterData.loai_khuyen_mai || "none";
  const promotionValue = Number(masterData.gia_tri_khuyen_mai) || 0;

  const paymentSnapshot = calcPaymentSnapshot(
    DEFAULT_MONTHLY_PRICE,
    monthsCount,
    promotionType,
    promotionValue
  );

  console.log(
    `  💰 ${monthsCount} tháng × ${DEFAULT_MONTHLY_PRICE.toLocaleString(
      "vi-VN"
    )} VNĐ` +
      `  |  Gốc: ${paymentSnapshot.originalAmount.toLocaleString("vi-VN")}` +
      `  |  Giảm: ${paymentSnapshot.discountAmount.toLocaleString("vi-VN")}` +
      `  |  Cuối: ${paymentSnapshot.finalAmount.toLocaleString("vi-VN")}`
  );

  // ── 3. Build RPC Params ───────────────────────────────────────────────────
  // Lưu ý: RPC không nhận captain_* hoặc serial_number.
  // Các trường đó do cauhinh-handler.js xử lý ở phía Viettel.
  const rpcParams = {
    p_vessel_code:        masterData.ship_code     ?? null,
    p_vessel_owner_name:  masterData.owner_name    ?? null,
    p_vessel_owner_phone: masterData.owner_phone   ?? null,
    p_vessel_address:     masterData.owner_address ?? null,
    p_vessel_cccd:        masterData.owner_cccd    ?? null,
    p_requester_name:     requesterName,
    p_requester_phone:    requesterPhone,
    p_months_count:       monthsCount,
    p_promotion_type:     PROMO_TYPE_LABEL[promotionType] ?? null,
    p_promotion_value:    promotionType !== "none" ? promotionValue : null,
    p_monthly_price:      DEFAULT_MONTHLY_PRICE,
    p_payment_snapshot:   paymentSnapshot,
    p_category:           "Đấu mới",
    p_type_fee:           "S-Tracking",
    p_created_by:         CREATE_BY,
    p_assigned_to:        CREATE_BY, // assigned_to = created_by theo yêu cầu
    p_customer_id:        null,
    p_dealer_id:          null,
    p_description:        null,
  };

  // ── 4. Test Mode: Dry run — in params, KHÔNG gọi RPC ─────────────────────
  if (testMode) {
    console.log(
      "\n🧪 [CSKH-DB] TEST MODE — rpcParams (DRY RUN, không gọi RPC):"
    );
    console.dir(rpcParams, { depth: null, colors: true });
    console.log("\n🧪 [CSKH-DB] Kết thúc Test Mode.");
    return {
      success: true,
      duration_ms: Date.now() - startTime,
      test_mode: true,
    };
  }

  // ── 5. Gọi RPC create_connection_record ──────────────────────────────────
  // RPC tự động: insert connection_records → insert payment_collections → UPDATE linked_payment_collection_id
  console.log(`\n  📤 Đang gọi RPC "${RPC_NAME}"...`);

  const RPC_TIMEOUT_MS = 30_000;
  const { data, error } = await Promise.race([
    supabase.rpc(RPC_NAME, rpcParams),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`[CSKH-DB] RPC timeout sau ${RPC_TIMEOUT_MS / 1000}s — Supabase không phản hồi`)),
        RPC_TIMEOUT_MS
      )
    ),
  ]);

  if (error) {
    console.error(`  ❌ Supabase RPC error [${error.code}]: ${error.message}`);
    throw new Error(`[CSKH-DB] Gọi RPC thất bại: ${error.message}`);
  }

  // RPC trả về jsonb: { success: true, connection_id: uuid, payment_id: uuid }
  //                hoặc: { success: false, error: "message" }
  if (!data?.success) {
    const rpcErr = data?.error ?? "RPC trả về success=false (không có thông tin lỗi).";
    console.error(`  ❌ RPC logic error: ${rpcErr}`);
    throw new Error(`[CSKH-DB] RPC thất bại: ${rpcErr}`);
  }

  const connectionId = data.connection_id ?? null;
  const paymentId    = data.payment_id    ?? null;

  console.log(`  ✅ RPC thành công!`);
  console.log(`     connection_id : ${connectionId}`);
  console.log(`     payment_id    : ${paymentId}`);

  // ── 6. UPDATE captain + serial_number (RPC không nhận các trường này) ────
  const extraFields = {
    captain_name:    captainName,
    captain_phone:   captainPhone,
    captain_cccd:    captainCccd,
    captain_address: captainAddress,
    serial_number:   masterData.serial_number ?? null,
  };

  console.log(`\n  📝 Đang UPDATE captain + serial_number cho connection_id: ${connectionId}...`);

  const { error: updateError } = await supabase
    .from("connection_records")
    .update(extraFields)
    .eq("id", connectionId);

  if (updateError) {
    console.error(`  ⚠️  UPDATE captain/serial thất bại [${updateError.code}]: ${updateError.message}`);
    // Không throw — phiếu đã tạo thành công, chỉ thiếu thông tin phụ
    console.error(`  ⚠️  connection_id ${connectionId} đã tạo nhưng thiếu captain/serial.`);
  } else {
    console.log(`  ✅ UPDATE captain + serial_number thành công.`);
  }

  const duration = Date.now() - startTime;
  console.log(`  ⏱  ${(duration / 1000).toFixed(1)}s`);
  console.log("═".repeat(60) + "\n");

  return {
    success: true,
    duration_ms: duration,
    test_mode: false,
    inserted_id: connectionId, // Tương thích với server.js (val.inserted_id)
    payment_id:  paymentId,
  };
}

module.exports = { insertCSKH };
