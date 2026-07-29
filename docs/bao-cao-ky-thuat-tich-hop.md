# Báo cáo kỹ thuật (tóm tắt) — Tool `auto-cskh` & Tích hợp vào `cskh-tasker-hub`

> Mục tiêu tích hợp: người dùng vào trang tool trong **cskh-tasker-hub** (kể cả trên điện thoại) →
> **tải file lên → AI đọc ảnh → tự động remote sang máy có SFive để chạy automation** (CSKH / Viettel / BCCS).

---

## 1. Tool hiện tại là gì

Một ứng dụng **Node.js (Express)** chạy **local trên máy nhân viên**, đóng gói thành **`auto-cskh.exe`** (pkg, Windows x64), mở web UI ở `http://localhost:3000`. Nó điều phối **3 luồng độc lập**:

| Luồng | Cách hoạt động | Phụ thuộc |
|---|---|---|
| **CSKH** | Insert thẳng vào **Supabase** qua RPC `create_connection_record` | Supabase (service role key) |
| **Viettel (Cấu hình)** | **Playwright/Chromium** điền web S-Tracking (5 form con) | Internet |
| **BCCS** | **CDP (chrome-remote-interface)** điều khiển **SFive.exe** điền form đấu nối | SFive + **mạng nội bộ Viettel** (10.240.x) |

Ngoài ra có 2 tính năng phụ trợ:
- **AI đọc ảnh giấy tờ** → tự điền form (OpenAI Vision).
- **Captcha BCCS**: chụp ảnh captcha trong SFive → hiện lên giao diện cho người nhập → tool điền lại vào SFive (KHÔNG auto-giải captcha).

**Quan trọng:** hub và tool **đã dùng CHUNG 1 Supabase project** (`exueouggmbjtjvsvpfya`) → thuận lợi để dùng Supabase làm cầu nối.

---

## 2. Các module chính (source)

| File | Vai trò |
|---|---|
| `server.js` | Express: phục vụ UI + toàn bộ API, đọc CONFIG/.env |
| `automation/cskh-db-handler.js` | `insertCSKH(masterData, testMode)` → Supabase RPC |
| `automation/cauhinh-handler.js` | `runCauhinh(page, masterData, testMode)` → Playwright Viettel |
| `automation/bccs-handler.js` | `runBCCS(masterData, testMode)` → CDP/SFive (login, điền form, upload hồ sơ, captcha, đấu nối) |
| `automation/image-extract-handler.js` | `extractFromImages(slots)` → OpenAI Vision, trả JSON theo id field của form |
| `automation/captcha-bridge.js` | Cầu nối captcha (in-memory) giữa automation ↔ giao diện |
| `public/index.html` | Toàn bộ master form + JS (autocomplete, validate, AI fill, modal captcha) |
| `data/mapping.json` | Bản đồ field ↔ selector cho 3 hệ thống (tài liệu tham chiếu) |

---

## 3. API hiện có (local, `http://localhost:3000`)

**Automation & dữ liệu**
- `POST /api/run-automation` — **multipart/form-data**:
  - field `masterData`: JSON (xem mục 4)
  - file: `file_bbnt, file_cmnd_sau, file_cmnd_truoc, file_hop_dong, file_phu_luc`
  - Trả `{ success, results:{cskh,cauhinh,bccs}, ... }`
- `POST /api/extract-image` — **multipart**: `img_device, img_cccd_front, img_cccd_back, img_ship, img_captain, img_fishing_license`
  → trả `{ success, fields:{<field_id>:value}, captain_is_owner, notes[] }`
- `POST /api/login` `{username,password}` (Supabase Auth)
- `GET /api/search-account|search-ship|search-serial?q=` (autocomplete từ Supabase)
- Address proxy: `GET /api/address/provinces|districts|wards`, `POST /api/address/convert-new`

**Captcha BCCS (bàn giao cho người nhập)**
- `GET  /api/bccs/captcha` → `{ id, image(dataURL), test_mode } | { none:true }`
- `POST /api/bccs/captcha` `{ id, code }`
- `POST /api/bccs/captcha/reload` `{ id }`

**Khác:** `GET /api/config`, `GET /api/logs`.

---

## 4. Hợp đồng dữ liệu — `masterData`

JSON phẳng, các nhóm chính (tên field = id trên form):

- **Tàu:** `ship_code, serial_number, bien_so_tau, co_hieu, ho_hieu, imo, ma_nganh_nghe, ma_cang, ma_cang_phu, tinh_thanh, tong_tai_trong, chieu_dai_toan_bo, chieu_dai_thiet_ke, chieu_rong, mon_nuoc, cong_suat, so_thuyen_vien, loai_tau, dung_tich_ham_ca, van_toc_danh_bat, van_toc_tu_do, toc_do_toi_da, tan_so_vhf, tan_so_hf, so_di_dong, primary_fishing_tool`
- **Chủ tàu:** `owner_name, owner_phone, owner_phone_2, owner_cccd, owner_loai_ma_so, issue_date, issue_place, vessel_owner_gender, owner_birthday, owner_fax, owner_email, owner_address_province/district/precinct/group_street/road/street (+ *_code)`
- **Thuyền trưởng:** `captain_is_owner, captain_name, captain_phone, captain_cccd, captain_address, captain_gender, captain_birthday, captain_fax`
- **Người yêu cầu:** `requester_is_owner, requester_name, requester_phone`
- **Thanh toán:** `so_thang, loai_khuyen_mai, gia_tri_khuyen_mai`
- **Tùy chọn:** `automation_options:{run_cskh, run_cauhinh, run_bccs}`

Một số field là **mã nội bộ** cần chọn từ danh sách (validate bắt buộc là mã): `ma_cang`, `ma_nganh_nghe`, `tinh_thanh` (UI có autocomplete → code). Giới tính mã `T/G/U`.

---

## 5. Ràng buộc bắt buộc (vì sao KHÔNG thể chạy 100% trên cloud/điện thoại)

- **BCCS** chỉ chạy được trên **máy Windows có SFive** + **trong mạng nội bộ Viettel** (BCCS ở `10.240.147.109:8400`, login qua Passport). Điều khiển bằng CDP → **bắt buộc là tiến trình local**.
- **Viettel Cấu hình** cần **Playwright/Chromium** (không chạy trong trình duyệt/điện thoại).
- **Captcha** bắt buộc **người thật giải** (không auto).
- **Khóa nhạy cảm** hiện ở phía server/PC: `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `BCCS_USERNAME/PASSWORD` → **không được lộ ra client (điện thoại)**.

➡️ **Kết luận:** phần **nhập liệu (form + đọc ảnh AI)** có thể đưa lên hub/điện thoại; phần **thực thi automation** **phải** ở máy có SFive. Cần một **cầu nối** giữa 2 nơi.

---

## 6. Kiến trúc tích hợp đề xuất — "Hàng đợi job" qua Supabase

Dùng chính **Supabase chung** làm trạm trung chuyển. Cả điện thoại lẫn máy SFive chỉ cần **internet ra Supabase** (không mở port/NAT).

```
📱 Hub (React)                         ☁️ SUPABASE (chung)                 💻 Máy SFive (worker)
 điền form + đọc ảnh AI  ── tạo job ──►  bảng automation_jobs  ── poll ──►  nhận job → chạy
 upload ảnh              ── Storage ──►  bucket automation-docs ──tải──►    insertCSKH/runCauhinh/runBCCS
 theo dõi + nhập captcha ◄── realtime ──  (captcha_image/answer) ◄──ghi──   đẩy captcha / đọc đáp án
```

### 6.1 Supabase — schema tối thiểu
- **`automation_jobs`**: `id, created_by, status, master_data(jsonb), automation_options(jsonb), doc_paths(jsonb), captcha_image(text), captcha_round(int), captcha_answer(text), captcha_action(text), result(jsonb), error(text), worker_id, created_at, updated_at`
  - status: `queued → running → captcha_pending → captcha_submitted → done | error`
- **`automation_workers`**: `worker_id, label, last_seen` (heartbeat → hub biết máy online)
- **Storage bucket** `automation-docs` (**private**): `jobs/{job_id}/{field}.{ext}` — ảnh hồ sơ; **xóa sau khi job xong**
- **RLS:** phone (anon key) chỉ thao tác job của mình; worker (service key) đọc/ghi tất cả
- **RPC:** `claim_next_job(worker)` (atomic, `FOR UPDATE SKIP LOCKED`), `submit_captcha(job_id, answer, action)`

### 6.2 Máy SFive — thêm "worker mode" cho tool (tái dùng ~90% code)
- exe chạy nền: `heartbeat` 15s; vòng lặp `claim_next_job` → tải ảnh từ Storage → dựng `masterData` → gọi `runBCCS/runCauhinh/insertCSKH` **có sẵn** → ghi `result`/`error`.
- Captcha: thay `captcha-bridge` (localhost) bằng bản **Supabase** (đẩy `captcha_image` + set `captcha_pending`, poll `captcha_answer`). Việc chụp ảnh captcha + điền vào SFive **giữ nguyên**.
- Thêm `MACHINE_ID` vào `.env`. (Hiện chỉ **1 máy** → routing đơn giản.)

### 6.3 Hub (React, điện thoại) — trang mới
- Master form (port từ `public/index.html`: field + validate + autocomplete mã cảng/ngành nghề/tỉnh + AI đọc ảnh).
- **AI đọc ảnh** gọi **Supabase Edge Function** `extract-image` (bê prompt từ `image-extract-handler.js`) — để `OPENAI_API_KEY` **không lộ** ra client.
- Submit: upload ảnh hồ sơ → Storage; tạo row `automation_jobs (queued)`.
- Theo dõi job (realtime); khi `captcha_pending` → hiện ảnh + ô nhập → `submit_captcha`.
- Chỉ báo máy online (đọc `automation_workers.last_seen`); nếu offline → báo "không gửi được".

---

## 7. Việc cần làm (chia đầu việc)

**A. Backend/Supabase (chung)**
1. Migration: 2 bảng + bucket + RLS + 2 RPC.
2. Edge Function `extract-image` + đặt secret `OPENAI_API_KEY`.

**B. Máy SFive (sửa tool này)** — *người quen codebase tool làm*
3. Thêm `automation/worker.js` (claim/heartbeat/tải ảnh/chạy handler/ghi kết quả).
4. Tách captcha thành callback + bản Supabase.
5. Build exe worker.

**C. Hub (React)** — *dev hub làm*
6. Trang "Nhập liệu tự động": form + validate + gọi Edge Function AI.
7. Submit (upload + tạo job) + màn theo dõi realtime + modal captcha + chỉ báo online.

*(Chi tiết schema/SQL/state-machine: xem `docs/remote-relay-plan.md`.)*

---

## 8. Bảo mật & lưu ý
- `SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, tài khoản BCCS: **chỉ ở PC worker / Edge Function**, tuyệt đối không xuống client.
- Ảnh CCCD/hồ sơ là **dữ liệu cá nhân** → bucket **private** + RLS chặt + **xóa sau xử lý** (giống tool đang xóa file tạm).
- Captcha luôn do **người thật** giải (trên điện thoại) — không auto.
- Máy SFive cần vào được mạng nội bộ Viettel; một số script phụ trợ của BCCS (`10.60.x`) có thể không tới được nhưng không ảnh hưởng đấu nối.
- Selector BCCS hay đổi `j_idt####` (PrimeFaces) → codebase đã chuyển sang **khớp đuôi `[id$=...]` / thuộc tính ổn định**; giữ nguyên tắc này khi bảo trì.

---

*Tài liệu liên quan: `docs/remote-relay-plan.md` (kế hoạch chi tiết + SQL/state-machine).*
