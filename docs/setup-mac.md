# Hướng Dẫn Cài Đặt Claude Quota Monitor Trên macOS

Hệ thống theo dõi Quota Claude Code 5 giờ tập trung toàn team qua Cloudflare Worker & KV.

- **Dashboard Cockpit**: `https://team-ai-quota.your-worker.workers.dev/?key=<ACCESS_KEY>`
- **Worker Status API**: `https://team-ai-quota.your-worker.workers.dev/status?key=<ACCESS_KEY>`
- **Secret Key**: (xem `.secrets/quota-key.txt`, không commit; hướng dẫn: [LOCAL_SECRETS.md](LOCAL_SECRETS.md))

---

## 1. Cài Đặt Tự Động (Khuyến Nghị)

Script cần chạy từ bên trong một bản clone của repo (không còn cài qua 1-liner `curl | bash` / `irm | iex`). Mở Terminal và chạy:

```bash
gh repo clone braitoli/team-ai-quota   # hoặc: git clone https://github.com/braitoli/team-ai-quota.git
cd team-ai-quota
bash scripts/setup-mac.sh
```

**Cập nhật bản cài đặt có sẵn**: vào thư mục clone, chạy `git pull` rồi chạy lại script trên.

---

## 2. Cơ Chế Hoạt Động (`launchd` LaunchAgent)

Trên macOS, script sử dụng **`launchd` LaunchAgent** (`~/Library/LaunchAgents/com.yourteam.claude-quota-monitor.plist`) thay vì `cron` truyền thống vì những lý do cốt lõi:
1. **Không đụng vào token**: Client v3 chạy `claude -p "/usage"` (0 token) trong GUI user session (`gui/$(id -u)`) để Claude Code tự xác thực. Script không đọc Keychain, không lưu token. Email lấy từ `claude auth status`.
2. **Khởi Động Cùng Hệ Điều Hành (`RunAtLoad: true`)**: Ngay khi máy Mac khởi động hoặc đăng nhập, script tự động chạy ngay 1 lượt báo cáo trạng thái Online mà không phải đợi tới phút thứ 30.
3. **Tần Suất Cập Nhật Thích Ứng 2–15 Phút (`StartInterval: 120`)**: LaunchAgent kích hoạt mỗi 2 phút; script tự động đo tốc độ đốt token trên tài khoản hiện tại để điều chỉnh tần suất cập nhật thông minh từ 2 phút (khi đốt nhanh) đến 15 phút (khi rảnh/idle). Nếu chưa tới chu kỳ, script bỏ qua ngay lập tức mà không gọi Claude Code. Nếu máy Mac gập nắp ngủ (Sleep), khi mở máy thức dậy `launchd` tự động bù chạy ngay lập tức.
4. **Overload Suppression (Ngủ Đông Khi Quá Tải)**: Khi tài khoản chạm 100% quota, script tự động ghi nhận mốc `resets_at` và tạm dừng hỏi Claude đến khi qua giờ reset.
5. **Chống chạy chồng & lệch giờ**: khoá `run.lock` để hai lượt không chạy cùng lúc, trễ ngẫu nhiên 0–30 giây trước khi gọi `claude` (giảm khả năng trùng lúc Claude Code đang refresh token).
6. **Dự phòng Haiku**: Client v3 hỏi chính Claude Code (`claude -p "/usage"`, **0 token**, không trừ quota) rồi dùng regex tách thành JSON. Chỉ khi regex không đọc được (Anthropic đổi câu chữ) mới có **một** lần gọi dự phòng `claude -p --model haiku` (≈4k token đầu vào Haiku, vài phần nghìn USD), tối đa 1 lần mỗi lượt chạy, và không gọi lại trong 6 giờ nếu chính đoạn text đó đã thất bại (sau 3 lần thất bại liên tiếp cũng chỉ thử lại mỗi 6 giờ). Kết quả dự phòng chỉ được nhận khi số % và giờ reset khớp từng chữ số với text gốc, reset nằm trong 8 ngày tới; ngược lại gửi `error_kind=parse_error` chứ không bao giờ gửi 0%.

Setup tự xoá `.token_cache.json` của các bản cũ.

Từ client v3.4, client **tự cập nhật** chính nó bằng `gh` (cần `gh auth login` trên máy này; tắt bằng `CLAUDE_QUOTA_NO_UPDATE=1` hoặc file rỗng `~/.claude/quota-monitor/no_update`). Việc tự cập nhật chỉ thay file `report_quota.py` (và `report_agy.py` trên máy có `agy`, cùng quy tắc); đổi lịch chạy hay script cài đặt vẫn cần chạy lại `scripts/setup-*`. Chi tiết: mục "Tự cập nhật client" trong README.

---

## 2b. Agy (Antigravity CLI) — tuỳ chọn

**Chỉ báo cho CLI đã cài.** Khi chạy, setup dò `claude` (Claude Code) và `agy` (Antigravity CLI) bằng chính các đường dẫn tìm kiếm của client (`report_quota.py --detect`, `report_agy.py --detect`) và chỉ cài job cho CLI tìm thấy; in rõ máy này có CLI nào. Không tìm thấy CLI nào thì không cài job báo cáo nào. Client cũng tự im lặng: thiếu `claude` thì `report_quota.py` (hoặc thiếu `agy` thì `report_agy.py`) thoát với mã 0 và **không gửi gì** (không báo lỗi, không số liệu giả). Còn CLI đã cài nhưng chưa đăng nhập thì vẫn gửi báo lỗi `auth_required`.

Nếu máy có lệnh `agy`, `setup-mac.sh` cài thêm LaunchAgent `com.yourteam.agy-quota-monitor` (RunAtLoad + mỗi 15 phút vào phút 7/22/37/52 để lệch với job Claude chạy phút 0/15/30/45, log `~/.claude/quota-monitor/agy-quota.log`, không đặt `ProcessType`) chạy `client/report_agy.py`. Script chạy `agy -p /usage --output-format json` (0 token, từ thư mục rỗng, timeout 120s) và gửi **mỗi pool một báo cáo** (`provider="agy"`, `pool="gemini"|"claude"`). Email lấy từ trường `id_token_email` trong `~/.gemini/antigravity-cli/antigravity-oauth-token`; token không bao giờ được in, lưu hay gửi. Khi bucket 5h bị `disabled` (đã chạm trần tuần) client gửi `five_hour_disabled: true`, `resets_at: null`. Chạy thử: `launchctl kickstart -k gui/$(id -u)/com.yourteam.agy-quota-monitor`. Gỡ: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.yourteam.agy-quota-monitor.plist; rm -f ~/Library/LaunchAgents/com.yourteam.agy-quota-monitor.plist`.

---

## 3. Các Lệnh Quản Trị Hữu Ích

- **Kiểm tra trạng thái daemon**:
  ```bash
  launchctl list | grep yourteam
  ```
- **Kích hoạt chạy ngay lập tức (Test manual)**:
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.yourteam.claude-quota-monitor
  ```
- **Xem nhật ký log thời gian thực**:
  ```bash
  tail -f ~/.claude/quota-monitor/quota.log
  ```
- **Gỡ cài đặt**:
  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.yourteam.claude-quota-monitor.plist 2>/dev/null || true
  rm -f ~/Library/LaunchAgents/com.yourteam.claude-quota-monitor.plist
  ```
