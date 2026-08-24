# Triển khai remote relay — Hướng dẫn từng bước

Code đã xong ở cả 3 nơi. Việc còn lại là **bạn chạy trên hạ tầng** (Supabase dashboard + máy SFive + hub). Làm theo thứ tự, test xong bước nào mới qua bước sau.

## Bước 1 — Supabase (chạy tay trên dashboard)

1. **SQL migration:** mở Supabase Studio → SQL Editor → dán toàn bộ nội dung
   `csku-tasker-hub/supabase/migrations/20260729090000_automation_relay.sql` → Run.
   - Tạo bảng `automation_jobs`, `automation_workers`, bucket `automation-docs` (private),
     RLS, RPC `claim_next_job` / `submit_captcha` / `requeue_stale_jobs`, bật realtime.
2. **Secret cho Edge Function:** Project Settings → Edge Functions → Secrets → thêm
   `OPENAI_API_KEY` (và tùy chọn `OPENAI_MODEL=gpt-5-mini`).
3. **Deploy Edge Function** `extract-image`:
   ```bash
   cd csku-tasker-hub
   npx supabase functions deploy extract-image
   ```
   (đã có `verify_jwt = true` trong `supabase/config.toml`).
4. **(Tùy chọn) Regenerate types** để hub hết cast `as any`:
   ```bash
   npx supabase gen types typescript --project-id exueouggmbjtjvsvpfya > src/integrations/supabase/types.ts
   ```

**Kiểm tra nhanh (SQL Editor):**
> Trong SQL Editor `auth.uid()` = NULL (không có phiên đăng nhập) nên phải truyền UUID giả
> cho `created_by`. Test này chỉ để xác nhận RPC claim hoạt động.
```sql
-- 1) Tạo job giả
insert into automation_jobs (created_by, master_data, automation_options)
values (gen_random_uuid(), '{"ship_code":"TEST-1"}'::jsonb, '{"run_bccs":true}'::jsonb);

-- 2) Claim thử → phải trả job vừa tạo, status đổi 'queued' → 'running'
select id, status, worker_id from claim_next_job('PC-01');

-- 3) Dọn job test
delete from automation_jobs where master_data->>'ship_code' = 'TEST-1';
```

## Bước 2 — Máy SFive (tool worker)

Trong `auto-cskh ch-tool/.env` (đã tự thêm khóa mặc định), đặt:
```
WORKER_ENABLED=true
MACHINE_ID=PC-VungTau-01
MACHINE_LABEL=PC Vũng Tàu 01
```
(Đã có sẵn `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.)

Build + chạy:
```bash
npm run build:exe
dist/auto-cskh.exe
```
- exe vẫn phục vụ web local `http://localhost:3000` như cũ **+** chạy worker nền.
- Log sẽ in `🤖 [worker] Bật WORKER MODE`. Heartbeat 15s → `automation_workers.last_seen`.

**Kiểm tra:** insert 1 job `queued` (Bước 1) → xem log worker claim → chạy → ghi `result`.
Với BCCS test_mode (`CONFIG.test_mode.bccs=true`), khi tới captcha job sẽ chuyển
`captcha_pending` và `captcha_image` có ảnh.

## Bước 2b — Bổ sung parity form (autocomplete + địa chỉ)

Chạy thêm trên Supabase để form hub đủ tính năng như master form:
1. **SQL:** SQL Editor → dán `csku-tasker-hub/supabase/migrations/20260729093000_automation_search_serials.sql` → Run
   (RPC `search_order_item_serials` — vì bảng serial bị RLS chặn đọc trực tiếp).
2. **Deploy Edge Function** `convert-address` (cascade Tỉnh/Huyện/Xã + đổi địa chỉ cũ→mới, bundle sẵn dataset 10k dòng):
   ```bash
   cd csku-tasker-hub
   npx supabase functions deploy convert-address --project-ref exueouggmbjtjvsvpfya
   ```
   - Không cần secret. `verify_jwt = true` (chỉ user đăng nhập gọi).
   - Nếu CLI báo lỗi cú pháp `with { type: "json" }`, đổi thành `assert { type: "json" }` trong `supabase/functions/convert-address/index.ts` rồi deploy lại.

Các autocomplete Số đăng ký tàu (`vnf_data`) và Người yêu cầu (`accounts`) query thẳng Supabase — không cần thêm gì (đã có RLS cho authenticated).

## Bước 3 — Hub (điện thoại)

```bash
cd csku-tasker-hub
npm run dev   # http://localhost:8080
```
- Menu **CSKH → "Nhập liệu tự động"** (`/automation-entry`).
- Badge góc phải báo **Máy SFive online/offline** (đọc `automation_workers.last_seen`).
- Tải ảnh → **AI đọc ảnh** (gọi Edge Function) → kiểm tra form → **Gửi cho máy SFive chạy**.
- Job hiện tiến trình realtime; khi `captcha_pending` → modal nhập captcha → **Xác nhận**/**Đổi mã**.

## Bước 4 — Test đầu-cuối

Điện thoại tạo job → PC nhận → chạy (để BCCS test_mode trước) → captcha lên điện thoại →
nhập → PC điền SFive → kết quả về điện thoại. Kiểm thêm:
- RLS: tài khoản khác **không** thấy job của mình.
- Ảnh trong `automation-docs` bị **xóa** sau khi job `done`/`error`.
- Tắt exe → hub báo **offline**; job nằm `queued` chờ.
- Bật lại exe → job cũ (nếu treo) bị `requeue_stale_jobs` chuyển `error` sau ~15 phút.

## Ghi chú
- Đường dẫn ảnh Storage: `jobs/<uid>/<job_id>/<field>.<ext>` (uid trong path để RLS kiểm soát).
- Captcha luôn do **người thật** giải trên điện thoại (không auto).
- Menu "Nhập liệu tự động" hiện **cho mọi người đăng nhập** (không gắn `resourceType`).
  Muốn giới hạn theo vai trò: thêm `resource_type='automation_entry'` vào ma trận quyền
  rồi gắn `resourceType` cho item trong `HomeSidebar.tsx`.
- Các file mã (ngành nghề/cảng/tỉnh) trong hub sinh tự động từ `public/index.html`
  bằng `scripts` tạm — nếu tool cập nhật danh sách, chạy lại script trích xuất.
```
