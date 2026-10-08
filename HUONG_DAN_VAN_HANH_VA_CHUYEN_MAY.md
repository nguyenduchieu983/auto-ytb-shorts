# AUTO YTB SHORTS — LUỒNG HOẠT ĐỘNG VÀ CHUYỂN MÁY

Cập nhật: 08/10/2026. Tài liệu độc lập cho phiên bản có voice liền mạch, chống trùng sự kiện và Telegram polling. Repo: https://github.com/nguyenduchieu983/auto-ytb-shorts.git

## 1. Cách vận hành đã chọn

- Chạy Node.js, PostgreSQL và Redis trên máy local. **Không Docker, không cần public domain/tunnel.**
- Chủ động gửi **`/gen-new-video`** vào Telegram để bắt đầu. `SCHEDULE_ENABLED=false`; cron không chạy.
- Một run cho mỗi ngày theo `Asia/Ho_Chi_Minh`. Gửi lệnh nhiều lần trả lại run trong ngày, không sinh nhiều video. Ngày hôm sau sẽ tạo run mới.
- Pipeline gửi preview để người dùng duyệt. `AUTO_PUBLISH=false`; upload mặc định **private**.
- Local nghĩa là chương trình và dữ liệu chạy trên máy; OpenAI, Telegram, YouTube và việc đọc tin vẫn cần internet/tài khoản API.
- Muốn tiếp tục máy cũ: chuyển **code + .env + PostgreSQL backup + storage**. Muốn cài mới không giữ lịch sử: code + cấu hình tài khoản là đủ, nhưng mất khả năng đối chiếu các tin cũ đã đăng trên máy trước.

## 2. Sơ đồ toàn bộ pipeline

```text
Telegram /gen-new-video
  → polling trong worker → PostgreSQL inbox → kiểm tra admin và update_id
  → tạo/lấy run hôm nay → transactional outbox → BullMQ/Redis
  → discover → rank + kiểm tra trùng sự kiện → script → verify
  → storyboard chia lời bằng code, AI thiết kế hình
  → voice ───────────→ subtitles ──┐
  → visuals ──────────────────────→ render → QC → Telegram preview
  → metadata ────────────────────────────────┘
  → người dùng /publish <runId> <revision>
  → YouTube resumable upload → thông báo link/trạng thái
```

API và worker là **hai process riêng**. PostgreSQL giữ trạng thái/lịch sử/approval/chi phí; Redis là hàng đợi; `storage` giữ audio, hình, video, diagnostics. API `/health` chỉ kiểm tra DB, không chứng minh worker/Redis đang hoạt động.

### Discovery và nguồn

1. Responses API bắt buộc `web_search`, high context, nguồn live; không dùng câu trả lời từ trí nhớ làm tin.
2. Lấy raw answer + URLs/citations, tải nội dung bài thật; request riêng trích xuất JSON.
3. Loại URL nội bộ, trang listing/archive, trang không đọc được; ghi rõ lý do. Nguồn ưu tiên chỉ cộng điểm, không phải whitelist chặn tất cả nguồn khác.
4. Tìm trong 24 giờ; dưới 5 ứng viên hợp lệ thì mở 48 rồi 72 giờ, giữ các ứng viên cũ để xét lại.
5. Nếu vẫn thiếu: RSS/Atom OpenAI, Anthropic, Google AI, GitHub, Microsoft, NVIDIA, TechCrunch, The Verge. Feed lỗi/404 được bỏ qua; Anthropic từng trả 404.
6. Ngày không xác định giữ `null`, không gán ngày mới giả. Evidence lấy từ nội dung nguồn, không kiểm tra nguyên văn quotation AI có dấu `...` như lỗi cũ.

Domain ưu tiên hiện tại: openai.com, anthropic.com, blog.google, deepmind.google, github.blog, microsoft.com, nvidia.com, amd.com, aws.amazon.com, cloudflare.com, reuters.com, apnews.com, techcrunch.com, theverge.com, venturebeat.com, arstechnica.com, thenewstack.io, bleepingcomputer.com.

RSS cấu hình: `https://openai.com/news/rss.xml`, `https://www.anthropic.com/rss.xml`, `https://blog.google/technology/ai/rss/`, `https://github.blog/feed/`, `https://blogs.microsoft.com/feed/`, `https://blogs.nvidia.com/feed/`, `https://techcrunch.com/feed/`, `https://www.theverge.com/rss/index.xml`.

### Chọn tin và hạn chế đăng trùng

- Canonical URL bỏ tracking và so độ giống tiêu đề trước.
- Model so **sự kiện** giữa ứng viên, các ứng viên trước nó và lịch sử 90 ngày. Đổi báo/URL/tiêu đề nhưng cùng một thông báo vẫn là duplicate. Cùng công ty nhưng sự kiện mới không tự động bị chặn.
- Follow-up chỉ giữ khi có diễn biến mới cụ thể; lưu `new/update/duplicate`, tin đối chiếu và lý do trong `novelty.json`.
- History lấy `rank.selected` của **revision hiện tại** trong các run live `WAITING_APPROVAL`, `UPLOADING`, `UPLOAD_UNCERTAIN`, `UPLOADED_PRIVATE`, `PUBLISHED`. Loại mock, failed/skipped và chính run đang tạo lại.
- Chọn tối đa 3 tin; ưu tiên đa dạng, 2 news + 1 tool nếu phù hợp. Có 1–2 tin vẫn làm với số tin thực; 0 tin thì skip, không bịa tin thứ ba.
- Đây là biện pháp giảm trùng, không bảo đảm phân loại đúng 100%. Giữ duyệt thủ công. Nếu không chuyển DB sang máy mới, lịch sử này không còn.

### Script, voice, hình và QC

- Script tiếng Việt: 120–150 token tính theo khoảng trắng, tính cả hook/ngày nguồn/CTA. Kiểm tra bằng code, tối đa 3 lần tạo/viết gọn trước TTS.
- Verify đối chiếu claims với evidence, tối đa 2 lượt sửa. Không đạt thì `NEEDS_REVISION`.
- Storyboard chia nguyên lời đã duyệt thành khoảng 10 cảnh bằng code. AI chỉ trả thiết kế hình; không được thêm/bớt lời.
- **Một request TTS cho cả video**, hướng dẫn giọng ở `prompts/voice.md`. Không tăng tốc audio để ép thời lượng.
- Whisper `whisper-1` trả word timestamps, căn với script; token không khớp được nội suy. Coverage thấp/mất cảnh thì dừng. Subtitle theo các mốc này, có highlight theo lời.
- Mỗi tin có minh họa chủ đề; xen thẻ số liệu/so sánh/diễn giải có nhãn. Hình tạo bằng AI ghi rõ minh họa; nền chuyển động nhẹ, chữ cố định. Image quality mặc định medium; lỗi tạm thời có thể dùng card fallback.
- FFmpeg render 1080×1920, 30fps, H.264/AAC, chữ tiếng Việt, audio chuẩn hóa âm lượng. Audio ngoài 40–65 giây bị chặn; mục tiêu 45–60 giây.
- QC kiểm tra file/codecs/resolution/fps/duration/audio/subtitles, facts, nguồn, hình phủ đủ cảnh và checksum. QC kỹ thuật không đo độ hấp dẫn hoặc bảo đảm lượt xem.

## 3. Chuẩn bị máy Windows mới

Đường dẫn ví dụ: `D:\ME\auto-ytb-shorts`. Có thể chọn đường dẫn khác khi cài mới. Nếu chuyển cả run/asset cũ, đọc mục 9 trước vì DB đang lưu đường dẫn tuyệt đối.

Cài Git, **Node.js 22+**, PostgreSQL native (máy hiện tại dùng 18), WSL2 + Ubuntu có Redis. Không copy `node_modules` hoặc `dist` từ máy cũ. Cần font Arial hoặc font hỗ trợ tiếng Việt; kiểm tra lại hình chữ sau khi đổi hệ điều hành.

### WSL và Redis

PowerShell Administrator, chỉ khi máy chưa có distro:

```powershell
wsl --list --online
wsl --install -d Ubuntu-22.04
```

Restart nếu Windows yêu cầu, mở Ubuntu lần đầu để tạo Linux user/password. Nếu chọn distro khác, thay tên trong các lệnh và đặt biến `REDIS_WSL_DISTRO` khi chạy helper. Kiểm tra bằng `wsl --list --verbose`.

Trong terminal Ubuntu:

```bash
sudo apt update
sudo apt install -y redis-server
redis-server --version
```

Helper dự án sẽ tạo instance riêng port 6380, có password, AOF và `noeviction`; không dùng/thay đổi instance port 6379 sẵn có. Redis và PostgreSQL không cần mở ra internet.

### Clone và setup

Trong PowerShell:

```powershell
git clone https://github.com/nguyenduchieu983/auto-ytb-shorts.git D:\ME\auto-ytb-shorts
Set-Location D:\ME\auto-ytb-shorts
npm.cmd ci
npm.cmd run setup
```

`setup` tạo `.env` với admin token và password DB ngẫu nhiên; nếu file đã tồn tại thì giữ nguyên. Mặc định tất cả provider là mock. Không dùng `npm ci --omit=dev` ở quy trình này vì build/scripts/FFmpeg fallback cần devDependencies.

### PostgreSQL

Cài PostgreSQL 18, ghi nhớ password admin `postgres`, giữ service chạy. Điền vào `.env` bằng editor local:

```dotenv
POSTGRES_ADMIN_URL="postgresql://postgres:<PASSWORD_ADMIN>@127.0.0.1:5432/postgres"
```

Giữ `DATABASE_URL` do setup sinh hoặc sửa thành role/database riêng. URL có mật khẩu chứa ký tự đặc biệt phải percent-encode; quote `.env` để dấu `#` không biến thành comment. Không đưa mật khẩu lên chat/Git.

```powershell
npm.cmd run db:init
```

Lệnh tạo role/database còn thiếu, không đổi password role đã tồn tại. Admin URL chỉ dùng để setup; app dùng `DATABASE_URL`. Sau khi setup có thể để trống `POSTGRES_ADMIN_URL`. **Nếu restore dữ liệu cũ, restore vào database trống ở mục 9 trước khi migrate.**

### Bật Redis dự án và kiểm tra

```powershell
# Nếu distro khác mặc định:
# $env:REDIS_WSL_DISTRO = 'Ubuntu-24.04'
npm.cmd run redis:start
npm.cmd run doctor
npm.cmd run migrate
npm.cmd run check
```

`redis:start` tự cập nhật `REDIS_URL` theo IP WSL mới và giữ password phù hợp. Sau reboot/WSL đổi IP, chạy lại helper rồi restart API/worker. `doctor` cần 4 mục postgresql, redis, ffmpeg, ffprobe đều `ok: true`.

FFmpeg/ffprobe có fallback binary qua npm packages. Nếu không chạy được, cài FFmpeg có libass và đặt `FFMPEG_PATH`, `FFPROBE_PATH` tuyệt đối theo máy mới. Không mang nguyên đường dẫn binary Windows sang Linux.

## 4. Cấu hình chạy thật

Chỉ sửa các mục dưới đây trong `.env` đã tạo; giữ database/admin token và các giá trị khác. Không thay cả file bằng block này.

```dotenv
HOST=127.0.0.1
PORT=3000
APP_TIMEZONE=Asia/Ho_Chi_Minh
STORAGE_ROOT=./storage
QUEUE_PREFIX=ai-tech-shorts
SCHEDULE_ENABLED=false
AUTO_PUBLISH=false
MOCK_OPENAI=false
OPENAI_API_KEY=<KEY_OPENAI>
OPENAI_SEARCH_MODEL=gpt-4.1
OPENAI_TEXT_MODEL=gpt-4.1-mini
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=coral
OPENAI_IMAGE_MODEL=gpt-image-1
OPENAI_IMAGE_QUALITY=medium
MOCK_TELEGRAM=false
TELEGRAM_UPDATE_MODE=polling
TELEGRAM_BOT_TOKEN=<TOKEN_BOT>
TELEGRAM_ADMIN_CHAT_ID=<CHAT_ID>
TELEGRAM_ADMIN_USER_IDS=<USER_ID_HOAC_DANH_SACH_PHAN_CACH_DAU_PHAY>
MOCK_YOUTUBE=false
GOOGLE_CLIENT_ID=<CLIENT_ID>
GOOGLE_CLIENT_SECRET=<CLIENT_SECRET>
YOUTUBE_REFRESH_TOKEN=<REFRESH_TOKEN>
YOUTUBE_PRIVACY_STATUS=private
```

Các tên model là cấu hình hiện tại của dự án, không bảo đảm tài khoản mới có quyền truy cập. Có thể đổi model qua `.env`, nhưng cần tương thích API/structured output/TTS. Word timestamp hiện dùng `whisper-1` trong code.

| Nhóm khác | Ý nghĩa |
| --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Kết nối local theo máy thực tế; Redis WSL helper tự cập nhật URL |
| `POSTGRES_PASSWORD` | Hỗ trợ setup; app thực sự kết nối bằng `DATABASE_URL` |
| `ADMIN_TOKEN` | Bảo vệ HTTP API; ít nhất 32 ký tự, setup tự tạo |
| `MAX_RUN_COST_USD` | Mặc định template 5; `0` tắt cap reservation local. Máy cũ đã chọn 0 |
| `TEXT_CALL_RESERVE_USD`, `SEARCH_CALL_RESERVE_USD` | Dự toán mỗi call; mặc định 0.10 / 0.50 USD |
| `IMAGE_CALL_RESERVE_USD`, `VOICE_CALL_RESERVE_USD` | Dự toán mỗi call; mặc định 0.25 / 0.25 USD |
| `TRANSCRIPTION_CALL_RESERVE_USD` | Dự toán transcription, mặc định 0.02 USD |
| `TELEGRAM_WEBHOOK_SECRET` | Chỉ bắt buộc ở mode webhook, ít nhất 32 ký tự; polling không cần |
| `CHANNEL_NAME` | Brand overlay, mặc định AI Tech Daily |
| `BACKGROUND_MUSIC_PATH` | Tùy chọn file nhạc có quyền sử dụng; bỏ trống nếu không dùng |
| `RENDER_CONCURRENCY`, `ASSET_CONCURRENCY` | Mặc định 1 và 2; phù hợp máy local |
| `DAILY_JOB_CRON` | Còn để tương thích, nhưng không được dùng khi schedule=false |

Reservation **không phải hóa đơn OpenAI**. Tắt cap không có nghĩa API miễn phí; usage vẫn lưu. Các call rewrite/retry và image medium có thể làm chi phí tăng. Startup chặn live YouTube nếu OpenAI còn mock.

## 5. Telegram và YouTube OAuth

### Telegram local polling

1. Tạo bot bằng BotFather, đặt token vào `.env`.
2. Mở chat với bot và gửi một tin nhắn. Cần đúng numeric chat ID và user ID, không phải username.
3. Nếu chưa biết ID: khi **worker đang tắt**, gọi Bot API `getUpdates` từ công cụ local bằng token của mình và đọc `message.chat.id`, `message.from.id`. Không chạy consumer `getUpdates` riêng song song với worker. Nếu bot đang dùng webhook ở hệ thống khác, ngắt hệ thống cũ trước khi chuyển.
4. Điền whitelist trong `.env`, giữ polling. Worker tự gỡ webhook bằng `drop_pending_updates=false`, bảo toàn lệnh đang chờ.
5. Log thành công: `Telegram polling ready (local; pending updates preserved)`.

Poller xác thực chat/user, lưu inbox PostgreSQL trước khi tăng offset. `update_id` chống trùng qua restart; sai quyền bị từ chối; lệnh thiếu tham số từ admin được trả hướng dẫn. Chỉ một máy vận hành cùng bot/channel trong quy trình chuyển máy này.

### Google/YouTube

1. Tạo Google Cloud project, bật YouTube Data API v3; cấu hình consent và Web OAuth client. Nếu app Testing, thêm tài khoản dùng để đăng nhập vào test users.
2. Authorized redirect URI phải đúng từng ký tự:

```text
http://127.0.0.1:8765/oauth/callback
```

3. Điền `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, rồi chạy:

```powershell
npm.cmd run oauth
```

4. Giữ terminal đó chạy, mở consent URL, chọn tài khoản/kênh cần upload. Callback do **script OAuth** phục vụ trên port 8765, không phải API port 3000.
5. Script lưu `storage/youtube-oauth.json`; copy giá trị `refresh_token` vào `YOUTUBE_REFRESH_TOKEN` trong `.env`. Không commit file token.
6. Scope gồm `youtube.upload` và `youtube.readonly` để upload/đối soát kênh. Token có thể cần consent lại khi hết hiệu lực hoặc quyền bị thu hồi.

Giữ upload private để kiểm tra. App chưa được audit có thể bị giới hạn private từ Google; đổi env không tự gỡ giới hạn tài khoản. Source chưa có lệnh riêng để chuyển video private đã upload sang public: làm việc đó trong YouTube Studio.

## 6. Start source và thao tác hàng ngày

Sau khi cấu hình đủ:

```powershell
Set-Location D:\ME\auto-ytb-shorts
npm.cmd run redis:start
npm.cmd run doctor
npm.cmd run migrate
npm.cmd run build
npm.cmd start
```

Mở **terminal PowerShell thứ hai**:

```powershell
Set-Location D:\ME\auto-ytb-shorts
npm.cmd run worker
```

Giữ cả hai terminal và máy chạy. Worker báo `schedule enabled: false` và `Telegram polling ready`. Thay code cần build + restart cả hai process; thay `.env` cũng phải restart. Đóng laptop/sleep/tắt máy thì pipeline không tiếp tục.

Gửi vào bot:

```text
/gen-new-video
```

Bot trả run ID, revision và trạng thái. Alias `/gen_new_video` cũng dùng được (phù hợp Telegram command menu). Lệnh có dấu gạch ngang cần gõ/copy nguyên chuỗi.

Khi nhận preview, **copy nguyên dòng gồm ID và revision**:

```text
/status <runId> <revision>
/publish <runId> <revision>
/regenerate <runId> <revision> script
/regenerate <runId> <revision> voice
/regenerate <runId> <revision> visuals
/regenerate <runId> <revision> render
/skip <runId> <revision>
```

Không gõ dấu `< >` thật; thay bằng dữ liệu bot trả. Bấm riêng chữ `/publish` thường chỉ gửi tên lệnh, không mang các tham số bên cạnh.

Nếu hôm nay đã có run: `/gen-new-video` trả lại run đó. Với run lỗi/skip cần regenerate phù hợp; với video đã upload không tạo lại cùng ngày bằng lệnh này. Muốn thay đổi quy tắc nhiều video/ngày cần sửa thiết kế run, không xóa DB để lách.

| Trạng thái | Cần hiểu/làm gì |
| --- | --- |
| `PENDING`, `RUNNING` | Đang xếp hàng/xử lý; theo dõi log |
| `WAITING_APPROVAL` | Xem preview rồi publish/regenerate/skip |
| `NEEDS_REVISION` | Nội dung, thời lượng hoặc QC cần sửa; regenerate đúng bước |
| `SKIPPED` | Không có đủ nội dung hợp lệ; đọc lý do trước khi làm lại |
| `FAILED` | Lỗi có step; API retry chỉ dành cho FAILED |
| `UPLOADING` | Đang upload, không trigger upload khác |
| `UPLOAD_UNCERTAIN` | Kiểm tra YouTube Studio và đối soát, không tự tạo upload mới |
| `UPLOADED_PRIVATE` | Upload thành công, riêng tư |
| `PUBLISHED` | Upload trả về trạng thái public |

Approval hết hạn sau 24 giờ kể từ QC; cần regenerate script để verify lại. Regenerate tạo revision mới, giữ upstream đã thành công và vô hiệu approval cũ. Không regenerate khi upload đã bắt đầu. Upload theo resumable session/chunk 8 MiB; link và trạng thái được bot báo khi hoàn tất. Upload thành công chưa đồng nghĩa YouTube đã xử lý video xong.

## 7. HTTP API và log khi cần kiểm tra

Các lệnh sau đọc admin token từ `.env` **không in token**; dùng trong terminal ở thư mục repo sau `npm ci`:

```powershell
$shortsAdminToken = node -r dotenv/config -e 'process.stdout.write(process.env.ADMIN_TOKEN || "")'
$shortsHeaders = @{ Authorization = "Bearer $shortsAdminToken" }
$shortsToday = Invoke-RestMethod http://127.0.0.1:3000/pipeline/today -Headers $shortsHeaders
$shortsToday
Invoke-RestMethod http://127.0.0.1:3000/health
```

Thay bot bằng HTTP manual trigger nếu cần:

```powershell
$shortsRun = Invoke-RestMethod http://127.0.0.1:3000/pipeline/run -Method Post -Headers $shortsHeaders
Invoke-RestMethod "http://127.0.0.1:3000/pipeline/$($shortsRun.id)" -Headers $shortsHeaders
```

Các route mutation nhận JSON:

| Route POST | Body |
| --- | --- |
| `/pipeline/:id/publish` | `{ "revision": 8 }` |
| `/pipeline/:id/skip` | `{ "revision": 8 }` |
| `/pipeline/:id/regenerate` | `{ "revision": 8, "target": "script" }` |
| `/pipeline/:id/retry` | `{ "revision": 8, "step": "upload" }` |
| `/pipeline/:id/reconcile-upload` | `{ "revision": 8, "video_id": "ID_DA_KIEM_TRA_TREN_KENH" }` |

Dùng revision thực tế, không mặc định là 8. `/reconcile-upload` chỉ dùng sau khi kiểm tra đúng video/kênh, không đoán video ID.

Khi chạy foreground như mục 6, log hiện ngay ở hai terminal. Muốn vừa thấy terminal vừa lưu file, thay lệnh start của từng terminal bằng:

```powershell
npm.cmd start 2>&1 | Tee-Object -FilePath storage/api.console.log
# Terminal thứ hai:
npm.cmd run worker 2>&1 | Tee-Object -FilePath storage/worker.console.log
```

Nếu chạy nền bằng process helper cũ, log là `storage/api.stdout.log`, `api.stderr.log`, `worker.stdout.log`, `worker.stderr.log`. Xem realtime:

```powershell
Get-Content storage/worker.stdout.log -Tail 100 -Wait
Get-Content storage/worker.stderr.log -Tail 100 -Wait
```

Ctrl+C trong `Get-Content -Wait` chỉ dừng xem log; Ctrl+C ở terminal thực sự chạy Node/npm dừng process tương ứng. `storage/runtime-pids.json` là PID riêng của lần start nền trên máy đó; không dùng PID copy từ máy cũ để stop process máy mới.

## 8. Kiểm thử/preview riêng và vị trí dữ liệu

```powershell
npm.cmd run check
npm.cmd run news:discover
npm.cmd run video:preview -- <runId>
```

- `check`: TypeScript + tests (56 tests ở bản tài liệu này).
- `news:discover`: API thật tìm/extract/rank, không tạo video, không đổi run/queue, không gửi Telegram/YouTube. Đây là audit discovery, không chứng minh đầy đủ history novelty của pipeline chính.
- `video:preview`: dùng tin của run đã có, tạo preview riêng. Không thay run/revision, không upload, không có command publish cho file preview riêng.
- `demo`: hoàn toàn mock nội dung/provider, FFmpeg thật, không đánh giá chất lượng TTS thật.
- `test:redis`: smoke BullMQ. `test:native`: dùng DB/Redis thật nhưng provider mock; chỉ chạy trong môi trường test phù hợp, tránh trộn với worker live.

| Đường dẫn | Nội dung |
| --- | --- |
| `storage/<ngày>/<runId>/rev-N/<step>-attempt-N/` | Assets, result.json, MP4, logs kiểm chứng theo bước |
| `storage/diagnostics/<runId>/rev-N/` | Raw search/extraction, nguồn tải, lỗi API đã redacted |
| Thư mục rank, `novelty.json` | Quyết định chống trùng sự kiện |
| `storage/discovery-live/latest.json` | Audit discovery và reservation/usage |
| `storage/quality-preview/<id>/report.json` | Script/storyboard/voice/visuals/QC của preview riêng |
| `storage/quality-preview/<id>/render/final.mp4` | Video preview riêng |
| `storage/youtube-oauth.json` | Refresh token — bí mật |
| `storage/redis/` | Redis config/AOF/log — có thông tin kết nối bí mật |

Điểm chỉnh code: `src/engine.ts` điều phối; `src/db.ts` state/outbox/history; `src/queues.ts` worker; `src/telegram-polling.ts` receiver; `src/telegram-commands.ts` command; `src/news/` discovery; `src/providers/openai.ts` AI; `src/narration.ts` alignment; `src/visual-design.ts` cards; `src/media.ts` FFmpeg/subtitles; `src/providers/youtube.ts` upload. Prompt nằm ở `prompts/`.

## 9. Chuyển máy và giữ lịch sử

### 9.1. Trước khi backup

1. Giữ `SCHEDULE_ENABLED=false`, không gửi lệnh tạo/publish mới. Chờ run đang gen/upload xong hoặc giải quyết trạng thái upload chưa rõ trước khi chuyển.
2. Chọn mốc yên: đã upload, chờ duyệt, hoặc run đã dừng lỗi/skip. Không chuyển kiểu Redis mới rỗng khi còn job QUEUED/RUNNING cần tiếp tục.
3. Dừng API và worker máy cũ. Không chạy song song hai máy dùng cùng bot/channel khi cutover.
4. Backup DB rồi copy `storage` ở cùng mốc dừng. Chỉ backup từ nguồn do mình quản lý.

Lý do cần mốc yên: Redis có job đã được outbox đánh dấu delivered. Chỉ restore PostgreSQL sang Redis rỗng **không tự phát lại mọi job QUEUED**. Hướng dẫn này dùng Redis mới tại mốc yên; không giả định thay queue giữa chừng là an toàn. Nếu cần chuyển một pipeline đang chạy, phải chuyển cả trạng thái Redis nhất quán hoặc thực hiện quy trình phục hồi riêng.

### 9.2. Backup PostgreSQL (PowerShell máy cũ)

Dùng client PostgreSQL 18; thay đường dẫn nếu bản cài khác. Password nhập ở prompt, không ghi vào câu lệnh:

```powershell
New-Item -ItemType Directory -Force D:\shorts-transfer
& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' -h 127.0.0.1 -p 5432 -U shorts -W -d shorts -Fc -f D:\shorts-transfer\shorts.dump
if ($LASTEXITCODE -ne 0) { throw 'Backup failed; do not continue transfer' }
& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' --list D:\shorts-transfer\shorts.dump
```

Copy riêng `.env`, toàn bộ `storage` và file dump sang thiết bị/thư mục chuyển máy an toàn. Có thể copy code bằng Git clone; giữ commit tương ứng backup (`git rev-parse HEAD`). Không commit dump, `.env`, token hoặc assets lên Git. Không cần copy `node_modules`/`dist`.

### 9.3. Đường dẫn assets — điểm phải giữ

DB outputs/artifacts có **đường dẫn tuyệt đối**, gồm hình, voice, subtitles, render. `STORAGE_ROOT` mới không tự sửa các đường dẫn này.

- Cách chuyển đã hỗ trợ trực tiếp: dùng cùng đường dẫn storage tuyệt đối trên Windows mới, ví dụ `D:\ME\auto-ytb-shorts\storage`. Source có thể nằm nơi khác nếu `STORAGE_ROOT` trỏ đúng thư mục cũ.
- Không có ổ D hoặc chuyển Windows → Linux: cài mới hoạt động ở đường dẫn bất kỳ; nhưng để resume/publish run cũ cần remap các path trong DB/metadata và kiểm tra lại assets. Source hiện chưa có helper tự động remap. Không gọi publish bản cũ khi path còn trỏ máy trước.
- Giữ toàn bộ bytes assets để checksum approved video còn đúng. Không sửa MP4 thủ công sau QC.

### 9.4. Restore trên máy mới

1. Cài môi trường như mục 3, clone code đúng commit, `npm ci`.
2. Copy `.env` qua kênh riêng; cập nhật kết nối PostgreSQL, đường dẫn media/music và storage. Giữ schedule/auto-publish false.
3. `db:init` tạo role/database đích **trống**. Nếu database đã có dữ liệu, chọn database mới; không dùng `--clean` bừa hoặc đè dữ liệu đang có.
4. Restore **trước migrate**:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' -h 127.0.0.1 -p 5432 -U postgres -W -d shorts --no-owner --role=shorts --exit-on-error D:\shorts-transfer\shorts.dump
if ($LASTEXITCODE -ne 0) { throw 'Restore failed; inspect before starting worker' }
```

`postgres` đăng nhập admin rồi `SET ROLE shorts` khi restore; không dùng password app cho prompt admin. Dùng PostgreSQL cùng major version 18 để giảm khác biệt. Dump không mang password role; role/password máy mới phải khớp `DATABASE_URL`.

5. Copy assets về đúng path mục 9.3. Với Redis mới ở mốc yên, **không copy thư mục `storage/redis` cũ vào instance mới**: giữ bản đó trong backup; để helper sinh config/IP/data mới. Các file PID/log config máy cũ không phải dịch vụ đã cài trên máy mới.
6. Kiểm tra cấu hình live; token YouTube có thể dùng tiếp nếu client/grant còn hợp lệ, nếu không chạy lại OAuth.
7. Chạy:

```powershell
npm.cmd run redis:start
npm.cmd run doctor
npm.cmd run migrate
npm.cmd run check
npm.cmd start
# Terminal thứ hai:
npm.cmd run worker
```

8. Gửi `/status <runId> <revision>` của run đã chuyển để xác nhận polling và DB. Kiểm tra MP4/source/approval trước publish; nếu approval quá 24h cần regenerate.
9. Giữ máy cũ tắt worker. Nếu rollback: dừng máy mới trước, tránh tạo hai nguồn cập nhật lịch sử độc lập cho cùng kênh.

### Linux

Ứng dụng có thể chạy Node trên Linux với PostgreSQL/Redis native; thay `npm.cmd` bằng `npm`, cài FFmpeg có libass và font hỗ trợ tiếng Việt. `redis:start` là helper **Windows WSL**, không chạy trên Linux; tự cấu hình Redis service và `REDIS_URL`. OAuth callback vẫn cần browser truy cập đúng máy có script OAuth. Khác OS/path phải xử lý mục 9.3 khi mang run/assets cũ. Chưa nghiệm thu chuyển máy thực tế chỉ bằng việc tài liệu này tồn tại.

## 10. Lỗi thường gặp

| Hiện tượng | Kiểm tra/xử lý |
| --- | --- |
| Bot gửi preview nhưng không nhận command | Worker/polling có chạy không; đúng chat/user IDs; chỉ một consumer; xem stdout/stderr |
| `/publish` không chạy | Gửi đầy đủ runId + revision, không chỉ bấm tên lệnh |
| `/gen-new-video` trả video hôm nay | Đúng quy tắc một run/ngày; regenerate nếu muốn sửa bản chưa upload |
| `redirect_uri_mismatch` | Web OAuth client đăng ký đúng `http://127.0.0.1:8765/oauth/callback` |
| Redis lỗi sau reboot | Mở WSL, chạy `redis:start`, restart API/worker vì IP đã đổi |
| DB password authentication failed | DATABASE_URL và role password phải khớp; db:init không đổi password role có sẵn |
| `NEWS_DISCOVERY_EMPTY` / skip rank | Xem counts và diagnostics từng nguồn/date/duplicate/novelty; không kết luận web không có tin chỉ từ thông báo cuối |
| OpenAI HTTP 400 schema/model | Xem message/param diagnostics; xác minh model được cấp quyền và schema đang dùng |
| Voice ngoài 40–65s | Regenerate script; không retry nguyên voice dài mãi hoặc tăng tốc cưỡng ép |
| Voice alignment coverage thấp | Xem transcription/script, tên riêng/số/ngày; sửa cách diễn đạt/phát âm rồi tạo lại |
| Budget reservation chặn | Xem api_costs và MAX_RUN_COST_USD; 0 tắt cap local, không xóa số đo usage |
| Video/font/caption lỗi | doctor kiểm tra FFmpeg; xác minh libass/font trên máy mới và xem preview |
| Upload 401/invalid_grant | Kiểm tra OAuth/client/grant, consent lại nếu cần |
| Upload uncertain | Kiểm tra Studio và đối soát video đúng kênh; không tự xóa session tạo upload thứ hai |
| Run cũ báo asset không tồn tại | Kiểm tra copy storage và tuyệt đối path trong DB, không chỉ sửa STORAGE_ROOT |
| Máy mới không chống trùng lịch sử | Chưa restore DB hoặc chạy mock; clone Git không có lịch sử máy cũ |

## 11. Checklist bàn giao

- [ ] Code cùng commit, Node 22+, npm ci/check pass.
- [ ] doctor: PostgreSQL/Redis/FFmpeg/ffprobe OK.
- [ ] API + worker đều chạy; polling ready; scheduler false; auto-publish false.
- [ ] Credentials đúng tài khoản/kênh, không nằm trong Git/tài liệu.
- [ ] History/approval/asset checksum được giữ nếu chuyển dữ liệu.
- [ ] Máy cũ không còn nhận command/chạy worker.
- [ ] `/status` được bot phản hồi; `/gen-new-video` chỉ tạo/lấy một run hôm nay.
- [ ] Nghe/xem preview thật trước publish; xác nhận YouTube private ở đúng kênh.

## 12. Tài liệu chính thức để đối chiếu khi môi trường thay đổi

- WSL: https://learn.microsoft.com/en-us/windows/wsl/basic-commands
- PostgreSQL backup/restore: https://www.postgresql.org/docs/18/app-pgdump.html và https://www.postgresql.org/docs/18/app-pgrestore.html
- Telegram polling: https://core.telegram.org/bots/api#getupdates
- OpenAI speech timestamps: https://developers.openai.com/api/docs/guides/speech-to-text
- YouTube resumable upload: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol

Các command/pipeline/config trong tài liệu được đối chiếu source tại thời điểm cập nhật. Việc setup trên một máy mới vẫn cần chạy doctor/check và một lượt kiểm chứng live tại máy đó; tài liệu không thay thế credentials/dịch vụ/dữ liệu thật.
