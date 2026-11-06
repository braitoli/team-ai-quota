# Hướng Dẫn Cài Đặt Claude Quota Monitor Trên Windows

Hệ thống theo dõi Quota Claude Code 5 giờ tập trung toàn team qua Cloudflare Worker & KV.

- **Dashboard Cockpit**: `https://team-ai-quota.your-worker.workers.dev/?key=<ACCESS_KEY>`
- **Worker Status API**: `https://team-ai-quota.your-worker.workers.dev/status?key=<ACCESS_KEY>`
- **Secret Key**: (xem `.secrets/quota-key.txt`, không commit; hướng dẫn: [LOCAL_SECRETS.md](LOCAL_SECRETS.md))

---

## 1. Cài Đặt Tự Động (Khuyến Nghị)

Script cần chạy từ bên trong một bản clone của repo (không còn cài qua 1-liner `curl | bash` / `irm | iex`). Mở PowerShell và chạy:

```powershell
gh repo clone braitoli/team-ai-quota   # hoặc: git clone https://github.com/braitoli/team-ai-quota.git
cd team-ai-quota
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

**Cập nhật bản cài đặt có sẵn**: vào thư mục clone, chạy `git pull` rồi chạy lại script trên.

---

## 2. Cơ Chế Hoạt Động (Windows Task Scheduler)

**Chỉ báo cho CLI đã cài.** Khi chạy, setup dò `claude` (Claude Code) và `agy` (Antigravity CLI) bằng chính các đường dẫn tìm kiếm của client (`report_quota.py --detect`, `report_agy.py --detect`) và chỉ cài job cho CLI tìm thấy; in rõ máy này có CLI nào. Không tìm thấy CLI nào thì không cài job báo cáo nào. Client cũng tự im lặng: thiếu `claude` thì `report_quota.py` (hoặc thiếu `agy` thì `report_agy.py`) thoát với mã 0 và **không gửi gì** (không báo lỗi, không số liệu giả). Còn CLI đã cài nhưng chưa đăng nhập thì vẫn gửi báo lỗi `auth_required`. Máy có `agy` được thêm 2 task `AgyQuotaMonitor` (mỗi 15 phút, lệch 7 phút so với Claude) và `AgyQuotaMonitorOnBoot`, log `%USERPROFILE%\.claude\quota-monitor\agy-quota.log`.

Trên Windows, script tự động tạo 2 Scheduled Tasks độc lập:
1. **`ClaudeQuotaMonitorOnBoot` (`/sc onlogon`)**: Kích hoạt chạy ngay khi người dùng đăng nhập vào Windows.
2. **`ClaudeQuotaMonitor` (`/sc minute /mo 2`)**: Kích hoạt task mỗi 2 phút; script tự động đo tốc độ đốt token trên tài khoản hiện tại để điều chỉnh tần suất cập nhật thông minh từ 2 phút (khi đốt nhanh) đến 15 phút (khi rảnh/idle). Nếu chưa tới chu kỳ, script bỏ qua ngay lập tức.
3. **Overload Suppression**: Khi quota chạm 100%, script tự động tạm ngưng hỏi Claude cho tới khi qua thời điểm `resets_at`.
4. **Không đụng vào token**: Client v3 chạy `claude -p "/usage"` (0 token); không đọc credentials, không cache token. Script tự tìm `claude.exe`/`claude.cmd` trong PATH, `%APPDATA%\npm`, `%USERPROFILE%\.local\bin`, binary nền tảng của gói npm và binary đi kèm extension VS Code/Cursor (hoặc đặt `CLAUDE_QUOTA_CLAUDE_BIN`). Từ client v3.10, script thử lần lượt từng bản bằng `claude --version` và dùng bản đầu tiên chạy được (bỏ qua file giữ chỗ `bin\claude.exe` 0 byte của gói npm khi postinstall chưa chép binary thật, vốn báo lỗi "not compatible with the version of Windows"), rồi nhớ lựa chọn trong `claude_bin.json`. Không bản nào chạy được thì vẫn gửi `claude_failed`, kèm các file tìm thấy (dung lượng), kiến trúc CPU và bản Windows; khi đó cần cài lại Claude Code trên máy (`irm https://claude.ai/install.ps1 | iex`). Email lấy từ `claude auth status`.
5. **Chống chạy chồng & lệch giờ**: khoá `run.lock`, trễ ngẫu nhiên 0–30 giây.
6. **Dự phòng Haiku**: Client v3 hỏi chính Claude Code (`claude -p "/usage"`, **0 token**, không trừ quota) rồi dùng regex tách thành JSON. Chỉ khi regex không đọc được (Anthropic đổi câu chữ) mới có **một** lần gọi dự phòng `claude -p --model haiku` (≈4k token đầu vào Haiku, vài phần nghìn USD), tối đa 1 lần mỗi lượt chạy, và không gọi lại trong 6 giờ nếu chính đoạn text đó đã thất bại (sau 3 lần thất bại liên tiếp cũng chỉ thử lại mỗi 6 giờ). Kết quả dự phòng chỉ được nhận khi số % và giờ reset khớp từng chữ số với text gốc, reset nằm trong 8 ngày tới; ngược lại gửi `error_kind=parse_error` chứ không bao giờ gửi 0%. (Nếu `claude` chỉ có dạng shim `.cmd`, bước dự phòng bị bỏ qua vì quoting tham số không an toàn; cài bản native `claude.exe` để dùng đủ tính năng.) Python trên Windows cần gói `tzdata` (`pip install tzdata`) để đọc múi giờ lạ; múi giờ phổ biến (Asia/Saigon, UTC...) có bảng offset dự phòng.

Setup tự xoá `.token_cache.json` của các bản cũ.

Từ client v3.4, client **tự cập nhật** chính nó bằng `gh` (cần `gh auth login` trên máy này; tắt bằng `CLAUDE_QUOTA_NO_UPDATE=1` hoặc file rỗng `%USERPROFILE%\.claude\quota-monitor\no_update`). Việc tự cập nhật chỉ thay file `report_quota.py` (và `report_agy.py` trên máy có `agy`, cùng quy tắc); đổi lịch chạy hay script cài đặt vẫn cần chạy lại `scripts/setup-*`. Chi tiết: mục "Tự cập nhật client" trong README.

---

## 2b. Agy (Antigravity CLI) — tuỳ chọn

Nếu máy có lệnh `agy`, `setup-windows.ps1` copy thêm `client\report_agy.py` vào `%USERPROFILE%\.claude\quota-monitor\` và đăng ký 2 task `AgyQuotaMonitor` (mỗi 15 phút, lệch 7 phút so với Claude) và `AgyQuotaMonitorOnBoot` (khi đăng nhập); log `%USERPROFILE%\.claude\quota-monitor\agy-quota.log`. Không có `agy` thì in thông báo bỏ qua, không báo lỗi. Script chạy `agy -p /usage --output-format json` (0 token, từ thư mục rỗng, timeout 120s) và gửi **mỗi pool một báo cáo** (`provider="agy"`, `pool="gemini"|"claude"`). Email lấy từ trường `id_token_email` trong `~\.gemini\antigravity-cli\antigravity-oauth-token`; token không bao giờ được in, lưu hay gửi. Khi bucket 5h bị `disabled` (đã chạm trần tuần) client gửi `five_hour_disabled: true`, `resets_at: null`. Chạy thử: `python "$env:USERPROFILE\.claude\quota-monitor\report_agy.py" --no-jitter`. Gỡ: `schtasks /delete /tn "AgyQuotaMonitor" /f` và `schtasks /delete /tn "AgyQuotaMonitorOnBoot" /f`.

---

## 3. Quản Lý & Xem Log

- **Kiểm tra tác vụ trong Task Scheduler**:
  ```powershell
  schtasks /query /tn "ClaudeQuotaMonitor"
  schtasks /query /tn "ClaudeQuotaMonitorOnBoot"
  ```
- **Chạy thử bằng tay**:
  ```powershell
  python "$env:USERPROFILE\.claude\quota-monitor\report_quota.py"
  ```
- **Xem nhật ký log**:
  ```powershell
  Get-Content -Path "$env:USERPROFILE\.claude\quota-monitor\quota.log" -Tail 20 -Wait
  ```
- **Gỡ cài đặt**:
  ```powershell
  schtasks /delete /tn "ClaudeQuotaMonitor" /f
  schtasks /delete /tn "ClaudeQuotaMonitorOnBoot" /f
  ```
