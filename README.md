# AI & Tech YouTube Shorts

Hướng dẫn đầy đủ trong một file: [Vận hành local và chuyển máy](HUONG_DAN_VAN_HANH_VA_CHUYEN_MAY.md). Bắt đầu thủ công qua Telegram bằng `/gen-new-video`; cron mặc định tắt.

Pipeline NestJS/TypeScript tạo một bản tin tiếng Việt mỗi ngày: tìm nguồn → chọn 3 mục → script/verify → storyboard → voice + visuals → subtitle → FFmpeg → QC → Telegram review → YouTube.

## Chạy demo ngay trên Windows

Yêu cầu Node.js 22+. Không cần PostgreSQL, Redis hay API key cho demo.

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run check
npm.cmd run demo
```

Demo chạy database PostgreSQL mô phỏng trong RAM, điều phối từng step trực tiếp và dùng FFmpeg thật. `storage/demo-latest.json` ghi run, logs, QC và đường dẫn MP4/thumbnail. Video 55 giây, 1080×1920, 30fps, H.264/AAC, có motion và subtitle tiếng Việt. Dữ liệu demo là giả; voice demo là âm thanh thử nghiệm, không phải TTS. YouTube/Telegram đều mock. Không dùng demo để kiểm chứng chất lượng tin hoặc giọng đọc thật.

FFmpeg/ffprobe cho dev được cung cấp qua package theo hệ điều hành; nếu không chạy được, cài FFmpeg có libass rồi đặt `FFMPEG_PATH` và `FFPROBE_PATH`. Production cần cài FFmpeg/ffprobe trực tiếp trên máy chạy worker. Font hiện dùng Arial/Liberation Sans để hỗ trợ tiếng Việt.

## Chạy với PostgreSQL/Redis

Chạy Node.js trực tiếp trên Windows hoặc Linux. Cài [PostgreSQL native](https://www.postgresql.org/download/windows/) hoặc dùng server PostgreSQL riêng. Với Redis trên Windows, dùng [Memurai hoặc Redis qua WSL theo hướng dẫn chính thức](https://redis.io/docs/latest/operate/oss_and_stack/install/archive/install-redis/install-redis-on-windows/); cũng có thể trỏ đến Redis server riêng.

Tạo role/database `shorts`, đặt password đúng giá trị `POSTGRES_PASSWORD` được `setup` tạo trong `.env`; cập nhật `DATABASE_URL` và `REDIS_URL` theo host/port thực tế. `POSTGRES_PASSWORD` là giá trị hỗ trợ thiết lập database, app kết nối bằng `DATABASE_URL`. Có thể tạo bằng SQL dưới đây, hoặc điền `POSTGRES_ADMIN_URL` ở `.env` rồi chạy `npm.cmd run db:init`. Lệnh chỉ tạo role/database chưa có, giữ nguyên password của role đã tồn tại. Admin connection chỉ được script khởi tạo sử dụng; API/worker dùng role riêng trong `DATABASE_URL`.

```sql
CREATE ROLE shorts LOGIN PASSWORD '<password-tu-env>';
CREATE DATABASE shorts OWNER shorts;
```

```powershell
npm.cmd run setup
# Nếu dùng Ubuntu WSL đã có Redis (mặc định distro Ubuntu-22.04):
npm.cmd run redis:start
# Sau khi điền POSTGRES_ADMIN_URL vào .env:
npm.cmd run db:init
npm.cmd run doctor
npm.cmd run migrate
npm.cmd run build
npm.cmd start
# Terminal thứ hai:
npm.cmd run worker
```

`setup` tạo `.env` với admin token và mật khẩu DB ngẫu nhiên, giữ nguyên file nếu đã có. `.env` và `storage` được gitignore. `doctor` kiểm tra kết nối PostgreSQL/Redis và FFmpeg, không in secrets. Nếu dịch vụ chưa cài/chưa chạy hoặc URL chưa đúng, sửa cấu hình trước khi migrate/start.

`redis:start` dùng Redis binary đã có trong Ubuntu WSL, tạo instance riêng ở cổng 6380, chỉ bind loopback/IP của WSL, có mật khẩu ngẫu nhiên, AOF persistence và `noeviction`. Không thay đổi Redis hiện có ở cổng 6379. Data/config/log nằm ở `storage/redis`; `REDIS_URL` được cập nhật cục bộ, không in password. Có thể chọn distro bằng `REDIS_WSL_DISTRO`. Sau khi reboot/WSL đổi IP, chạy lại lệnh rồi restart API/worker. Helper không cài Redis, không đăng ký startup service cho Windows/WSL.

Queue được tách namespace qua `QUEUE_PREFIX=ai-tech-shorts`, tránh trộn job với các app khác trên cùng Redis.

### Tự chạy khi đăng nhập Windows

Sau khi setup/build và chạy `doctor` thành công, đăng ký Task Scheduler cho tài khoản
Windows sở hữu distro WSL (chọn đúng tên từ `wsl --list --quiet`):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-autostart.ps1 -Action Install -RedisDistro Ubuntu
# Chạy ngay; lần sau tự chạy sau đăng nhập 30 giây:
Start-ScheduledTask -TaskName AutoYtbShorts-Logon
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-autostart.ps1 -Action Status
# Gỡ tự khởi động, giữ nguyên process đang chạy:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-autostart.ps1 -Action Remove
```

PostgreSQL native cần có Startup type Automatic trong Windows Services. Tác vụ chạy
với quyền thường, không lưu mật khẩu Windows; không cần mở Codex hay terminal.
Redis helper cập nhật IP WSL trước khi khởi động API/worker; tiến trình đang chạy
được tái sử dụng để tránh Telegram polling trùng. Nếu process đang có nhưng Redis
đã đổi IP, dừng API/worker có kiểm soát rồi chạy lại tác vụ. Không tự kill worker
đang sản xuất video. Script chờ dependency và kiểm tra API health + heartbeat worker;
Task Scheduler thử lại tối đa 3 lần khi startup thất bại. Đây là tác vụ khởi động,
không phải dịch vụ giám sát crash liên tục sau khi đã ready.

Log khởi động: `storage/runtime/startup.log`; logs API/worker hiện trong dashboard
Hệ thống. Logs process cũ được giữ trong `storage/runtime/archive` trước lần bật mới.
Tác vụ dùng Node path lúc cài; sau khi đổi bản Node hoặc chuyển folder, build rồi
đăng ký lại. Giữ `.env` hiện có, không tự bật scheduler/auto-publish hoặc đổi provider.
App chạy khi đã đăng nhập; máy tắt/ngủ sẽ không nhận lệnh Telegram. Mở dashboard
tại `http://127.0.0.1:3000/dashboard` khi cần quản lý.

API mặc định bind `127.0.0.1:3000` qua `HOST`; cần truy cập từ máy khác thì cấu hình bind/reverse proxy. PostgreSQL và Redis nên chỉ nhận kết nối từ app. Nếu triển khai webhook Telegram từ internet, đặt API sau reverse proxy HTTPS và chỉ expose đường dẫn webhook cần thiết. Production chạy API và worker thành hai process/service riêng; khi restart, worker phục hồi job từ DB/Redis.

## Trigger và duyệt

### Dashboard quản lý sản xuất

Mở `http://127.0.0.1:3000/dashboard` sau khi chạy API và worker. Trang `/`
tự chuyển đến dashboard. Đăng nhập bằng `ADMIN_TOKEN` trong `.env` cục bộ;
không gửi token lên chat. Phiên dùng cookie HttpOnly/SameSite=Strict, hết hạn
sau 12 giờ; token không được lưu vào localStorage hoặc trả trong HTML.

- Tổng quan tất cả run, lọc trạng thái/tìm ID hoặc ngày, phân trang 20 run.
- Cập nhật mỗi 3 giây khi tab đang mở; hiển thị 13 bước, các nhánh chạy song
  song, trạng thái, attempts và lỗi. Chuyển revision để xem bản cũ.
- Xem tin nguồn, script, metadata, voice, hình minh họa, MP4, phụ đề và QC.
  Media chỉ được đọc sau đăng nhập, hỗ trợ seek video bằng byte ranges.
- Logs pipeline gồm bắt đầu/kết thúc/lỗi, request OpenAI, tiến độ discovery và
  render từng cảnh. UI hiện 200 sự kiện gần nhất của revision, lọc bước/mức log.
  Các log cũ vẫn nằm trong PostgreSQL.
- Tạo run độc lập; duyệt & upload, bỏ qua, retry đúng bước lỗi, regenerate
  script/voice/visuals/render, hoặc đối soát upload bằng video ID đã kiểm tra.
  Thao tác có xác nhận; revision cũ khóa nút. Backend giữ nguyên approval,
  checksum, QC, revision và chống upload trùng.
- Trang Hệ thống kiểm tra Redis/DB và heartbeat worker (15 giây; offline nếu
  quá 45 giây). Worker heartbeat chứng minh process đang sống, không chứng minh
  provider bên ngoài đang kết nối thành công. Inbox Telegram và modes cũng hiện.
- Logs process đọc tối đa 4 KB cuối mỗi file `storage/runtime/api.stdout.log`,
  `api.stderr.log`, `worker.stdout.log`, `worker.stderr.log`. Nếu khởi động bằng
  terminal không redirect vào các file đó, xem logs terminal và logs pipeline.
- Chi phí hiển thị reservation qua mọi revision và token usage nếu có; đây
  không phải hóa đơn thật của nhà cung cấp.

Dashboard không thay đổi defaults mock/manual/private và không bật scheduler
hay auto-publish. Không expose dashboard ra internet trực tiếp. Nếu dùng reverse
proxy, giữ HTTPS và chuyển tiếp đúng Origin/Host cho các request dùng cookie.

API dashboard nằm dưới `/dashboard/api`; bearer `ADMIN_TOKEN` vẫn dùng được
cho API và test. `npm run check` có tests đăng nhập, chặn mutation khác origin,
dedup yêu cầu tạo run, revision lịch sử, redaction và byte ranges media. Các tests
dùng pg-mem và provider mock, không chứng minh API live.

Đọc `ADMIN_TOKEN` từ `.env` và đặt vào biến shell cục bộ, không gửi token lên chat.

```powershell
$shortsHeaders = @{ Authorization = "Bearer $shortsAdminToken" }
$shortsRun = Invoke-RestMethod http://localhost:3000/pipeline/run -Method Post -Headers $shortsHeaders
Invoke-RestMethod "http://localhost:3000/pipeline/$($shortsRun.id)" -Headers $shortsHeaders
# Chỉ thực hiện sau khi run có status WAITING_APPROVAL:
$shortsBody = @{ revision = 1 } | ConvertTo-Json
Invoke-RestMethod "http://localhost:3000/pipeline/$($shortsRun.id)/publish" -Method Post -Headers $shortsHeaders -ContentType application/json -Body $shortsBody
```

Endpoints:

| Endpoint                              | Body                                                  |
| ------------------------------------- | ----------------------------------------------------- |
| `POST /pipeline/run`                  | Không cần body; trả lại run đã có nếu cùng ngày       |
| `GET /pipeline/today`                 | —                                                     |
| `GET /pipeline/:id`                   | —                                                     |
| `POST /pipeline/:id/publish`          | `{ "revision": 1 }`                                   |
| `POST /pipeline/:id/skip`             | `{ "revision": 1 }`                                   |
| `POST /pipeline/:id/regenerate`       | `{ "revision": 1, "target": "script" }`               |
| `POST /pipeline/:id/retry`            | `{ "revision": 1, "step": "upload" }`                 |
| `POST /pipeline/:id/reconcile-upload` | `{ "revision": 1, "video_id": "..." }`                |
| `GET /health`                         | DB readiness; không thể hiện worker/Redis readiness   |
| `POST /telegram/webhook`              | Telegram update; xác thực webhook secret và whitelist |

`target` nhận `script`, `voice`, `visuals`, `render`. Mỗi regenerate tạo revision mới, tái sử dụng step upstream đã thành công, chạy lại các bước phụ thuộc và hủy approval cũ. Bản đã bắt đầu upload không được regenerate để tránh tạo video trùng.

## Nối OpenAI thật

Trong `.env`, đặt `OPENAI_API_KEY`, `MOCK_OPENAI=false`, chọn các model qua `OPENAI_*_MODEL`. Model defaults là cấu hình khởi điểm; cần kiểm tra quyền truy cập model của project trước khi dùng.

NEWS DISCOVERY dùng Responses API với Web Search live bắt buộc và context high. Request search trả raw answer/source list; request riêng trích xuất JSON từ raw answer và bài nguồn đã tải. Nguồn ưu tiên chỉ cộng điểm, không chặn publisher khác. URL nội bộ/không hợp lệ, trang listing và nguồn không truy cập được được loại với lý do cụ thể. Bằng chứng lấy trực tiếp từ nội dung bài, không đối chiếu chuỗi quotation do AI tự viết.

Tự mở 24 → 48 → 72 giờ nếu dưới 5 tin; nếu vẫn dưới 5, bổ sung RSS/Atom từ 16 nguồn: OpenAI, Anthropic, Google AI, GitHub, Microsoft, NVIDIA, TechCrunch, The Verge, The Register, The New Stack, BleepingComputer, AWS Machine Learning, The Decoder, ZDNet, Hugging Face và VnExpress Công nghệ. Bộ lọc RSS nhận cả từ khóa AI/tech tiếng Anh và các cụm tiếng Việt như trí tuệ nhân tạo, lập trình, bảo mật. Mỗi feed lấy tối đa 5 mục phù hợp trong 72 giờ; chọn luân phiên từng mục giữa các nguồn rồi loại URL trùng, tối đa 30 trang mỗi lần fallback. Cách chọn này giúp nguồn mới được đọc dù các feed đứng đầu có nhiều bài. Các báo mới cũng được thêm vào ưu tiên web search/ranking; nguồn công bố chính thức vẫn có điểm ưu tiên cao hơn. Feed không tồn tại/lỗi được ghi log và bỏ qua. Ngày thiếu hoặc không parse được giữ null với date_parse_failed=true và freshness_hours=null; không giả làm tin mới. Tin cũ được ghi ngày nguồn. MAX_NEWS_AGE_HOURS đã được thay bằng flow cố định 24/48/72 theo yêu cầu.

NewsDiscoveryService ghi raw response, source snapshots, extraction, lý do loại và counts vào storage/diagnostics/<runId>/rev-<revision>/discovery-<timestamp>/. API search/extraction lỗi có mã rõ; chỉ khi không còn tin hợp lệ mới SKIPPED. Mỗi video chọn đúng 1 sự kiện/tin/công cụ có điểm cao nhất sau kiểm tra nguồn và trùng sự kiện; confidence dùng để phân xử khi bằng điểm. Không ghép ba tin hoặc bù thêm tin. Auto-publish (opt-in) yêu cầu tin có ngày nguồn và tất cả QC đạt.

Chạy acceptance live riêng discovery/rank, không tạo video hay gửi Telegram/YouTube:

```powershell
npm.cmd run news:discover
```

Lệnh in RAW SOURCES, EXTRACTED, AFTER DATE FILTER, AFTER DEDUP, AFTER SOURCE FILTER, FINAL SELECTED và top 3. Report + ledger reservation/usage lưu trong storage/discovery-live/latest.json. [Điều tra root cause](docs/news-discovery.md).

Prompt nằm trong `prompts/*.md`. Mỗi video mới chọn đúng 1 chủ đề, kiểm tra trùng sự kiện với lịch sử 90 ngày. Kịch bản dành toàn bộ 120–150 token tiếng Việt (mục tiêu 45–60 giây) để giải thích sự kiện, bối cảnh/cách hoạt động và tác động thực tế, với 2–3 chi tiết từ toàn bộ article evidence; ví dụ hoặc giới hạn chỉ dùng khi nguồn hỗ trợ. Hook và CTA ngắn, không dùng format roundup. Storyboard chia cùng chủ đề thành nhiều nhịp giải thích. Rank lưu format single-story; QC yêu cầu đúng một tin. Revision đã rank trước thay đổi giữ format cũ khi regenerate downstream; muốn đổi video cũ sang một chủ đề thì regenerate từ rank. Voice đọc toàn bản tin trong một request và dùng word timestamps để căn cảnh/phụ đề; xem phần chất lượng ở cuối tài liệu.

Chi phí hiện là **reservation theo cấu hình**, không phải hóa đơn thực tế. Mỗi lần gọi kể cả retry đều giữ reservation; lưu thêm usage/tokens nếu provider trả. Đặt các giá trị reserve đủ cao cho model, search tool và chất lượng ảnh đang dùng. `MAX_RUN_COST_USD` chặn khi tổng reservation vượt ngân sách; đặt `MAX_RUN_COST_USD=0` để tắt chặn local, vẫn ghi reservation/usage. Mặc định vẫn là 5 USD. Đây không phải giới hạn spend tuyệt đối tại nhà cung cấp. V1 chưa tự tải bảng giá hoặc tính chính xác search/image/TTS billing.

## Telegram

Tạo bot qua BotFather; đặt `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS` (ID user, phân cách bằng dấu phẩy), `TELEGRAM_WEBHOOK_SECRET` (ngẫu nhiên ít nhất 32 ký tự), `MOCK_TELEGRAM=false`.

Mặc định `TELEGRAM_UPDATE_MODE=polling`: worker nhận lệnh bằng long polling ngay trên máy local, không cần domain, HTTPS public hoặc tunnel. Chạy cả API và worker; giữ máy bật và có internet. Worker tự bỏ webhook khi chuyển sang polling bằng `drop_pending_updates=false`, giữ các lệnh đang chờ. Log `Telegram polling ready` xác nhận receiver hoạt động; `Telegram update <id>: PENDING/REJECTED` ghi kết quả nhận. Inbox PostgreSQL chống trùng theo `update_id`, kiểm tra chat/user whitelist và xử lý tuần tự. Khi lỗi mạng, polling tự thử lại; không chạy một receiver khác cho cùng bot ở ứng dụng khác.

Muốn dùng webhook thì đặt `TELEGRAM_UPDATE_MODE=webhook`, restart API/worker và cấu hình webhook như dưới đây. Polling mode không nhận HTTP webhook.

Đăng ký webhook qua Bot API `setWebhook` với HTTPS URL trỏ tới `/telegram/webhook` và `secret_token` đúng giá trị `.env`. Webhook ghi update vào inbox bền vững; worker xử lý theo `update_id`. Cần cả chat ID và user ID đúng whitelist. Lệnh `/gen-new-video` không cần tham số, tạo run mới cho mỗi tin nhắn mới, kể cả cùng ngày; Telegram gửi lại cùng `update_id` chỉ nhận lại run đã tạo. Các command thao tác run cần ID và revision:

```text
/gen-new-video
/publish <runId> <revision>
/regenerate <runId> <revision> script|voice|visuals|render
/skip <runId> <revision>
/status <runId> <revision>
```

Bot gửi video preview, nguồn, QC, reservation chi phí và các lệnh. Approval hết hạn sau 24h kể từ QC; cần regenerate script để kiểm chứng lại. Preview quá 49 MiB bị chặn, cần giảm bitrate/độ phức tạp rồi render lại. Telegram gửi message có thể lặp khi provider timeout; publish và các thay đổi trạng thái có kiểm tra revision/idempotency nên không upload lặp theo số message.

## YouTube OAuth và private upload

1. Tạo Google Cloud project, bật YouTube Data API v3.
2. Cấu hình OAuth consent và Web OAuth client; thêm test user nếu app đang Testing.
3. Đăng ký redirect chính xác `http://127.0.0.1:8765/oauth/callback`.
4. Đặt `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET`, chạy `npm.cmd run oauth`.
5. Mở consent URL được in ở terminal, chọn tài khoản sở hữu kênh. Scope gồm `youtube.upload` và `youtube.readonly` để đối soát ownership.
6. Script lưu refresh token tại `storage/youtube-oauth.json`. Copy token vào `.env` mục `YOUTUBE_REFRESH_TOKEN`; token không được in ra console.
7. Đặt `MOCK_YOUTUBE=false`, `YOUTUBE_PRIVACY_STATUS=private`. Cần `MOCK_OPENAI=false`; startup chặn live upload nội dung mock.

Token được refresh tự động khi hết hạn. Nếu OAuth app đang Testing hoặc grant bị thu hồi, có thể cần consent lại; xem cấu hình OAuth trên Google Cloud trước khi vận hành lâu dài.

Upload chia chunk 8 MiB, lưu resumable session trước khi truyền file. Retry chỉ chạy step upload, kiểm tra byte offset từ YouTube trước khi tiếp tục. Nếu không xác định được kết quả khởi tạo/session hết hạn, chuyển `UPLOAD_UNCERTAIN`; không tự tạo upload mới. Kiểm tra YouTube Studio, lấy ID video đã tồn tại và gọi reconcile endpoint; ownership được đối chiếu với kênh OAuth. Endpoint này là quyết định của admin rằng video ID đúng với revision đang đối soát. Không có endpoint tự reset session để tránh duplicate vô ý.

Upload private có status `UPLOADED_PRIVATE`; chỉ `PUBLISHED` khi response xác nhận public. V1 chưa tự chờ YouTube processing xong và chưa chuyển video private sang public bằng một lệnh riêng. Project API chưa qua audit có thể bị buộc private; thay env sang public không gỡ được giới hạn này.

## Scheduler và phục hồi

Mặc định `SCHEDULE_ENABLED=false`, `AUTO_PUBLISH=false`, privacy private. Dùng lịch dashboard UTC+7 ở phần cuối tài liệu để đặt giờ, số video và tự upload riêng cho các run theo lịch. Khi chưa từng lưu lịch dashboard, cấu hình legacy `SCHEDULE_ENABLED=true` vẫn đăng ký BullMQ Job Scheduler lúc 07:30 `Asia/Ho_Chi_Minh` (hoặc `DAILY_JOB_CRON`). Legacy scheduler/API mặc định dùng một run cho mỗi ngày địa phương; lệnh Telegram và lịch dashboard tạo các run độc lập. Timestamp DB lưu UTC.

DB transaction ghi trạng thái bước và outbox cùng nhau. Dispatcher đẩy outbox vào BullMQ với job ID `runId-step-rN`. Job hoàn thành không được chạy lại nếu step đã thành công. Các bước assets chạy độc lập; render chờ visuals và subtitles. Worker heartbeat lease; lease hết hạn được đưa lại vào outbox. Retry tạm thời tối đa 3 lần thực thi; `FAILED`, `NEEDS_REVISION`, `SKIPPED`, `UPLOAD_UNCERTAIN` được lưu với step/lỗi cụ thể.

Regenerate target từ API có thể khôi phục run thất bại trước upload; upstream nào chưa thành công sẽ chạy lại. `retry` chỉ áp dụng run `FAILED`, chạy lại đúng step lỗi với revision hiện tại và giữ các bước đã thành công. Với upload có session hợp lệ, retry sẽ đối chiếu trạng thái session rồi tiếp tục; `UPLOAD_UNCERTAIN` cần kiểm tra Studio và đối soát, không dùng regenerate hoặc tự mở session mới. Không có cron catch-up cho ngày đã bỏ lỡ; trigger manual tạo run cho ngày hiện tại.

Chỉ bật auto-publish sau giai đoạn review ổn định: tất cả providers live, fact verification pass, tất cả hard QC pass, score ≥85, duration 45–60s. V1 vẫn upload theo privacy config, mặc định private.

## Kiểm tra và giới hạn nghiệm thu

`npm run check`: TypeScript build và tests cho timezone, dedup/selection, source parsing, subtitle, revision/approval, dependency join, cost budget và upload gates. Tests DB mặc định dùng pg-mem, không chứng minh được transaction/row locking của PostgreSQL thật. `npm run demo` kiểm tra FFmpeg/ffprobe và toàn bộ mock flow.

Khi PostgreSQL/Redis đã kết nối: `npm run test:redis` kiểm tra retry/dedup BullMQ bằng namespace riêng; `npm run test:native` chạy full mock pipeline trên PostgreSQL/Redis thật, kiểm tra 8 trigger đồng thời, lease hết hạn, regenerate voice/tái sử dụng visuals, từ chối approval cũ và 8 yêu cầu publish đồng thời. Test native tạo run với ngày thử nghiệm xa tương lai để không chiếm run hôm nay, giữ assets/log để audit và ghi `storage/native-latest.json`. Chỉ chạy khi tất cả provider mock và scheduler/auto-publish tắt. Test native tự đóng API/worker của lượt test khi xong; không xóa dữ liệu dự án. Test HTTP cần quyền kết nối localhost, nếu môi trường sandbox chặn socket thì chạy ở terminal máy.

Trước production cần chạy với PostgreSQL/Redis thật, thử concurrent trigger, kill/restart worker, Telegram live, OpenAI live (nghe/xem tiếng Việt), OAuth refresh và upload private trên đúng kênh. Chưa nghiệm thu dịch vụ ngoài chỉ bằng mock pass.

Backup database PostgreSQL và thư mục storage; bật persistence Redis và giữ revision đang chờ duyệt/đang upload. V1 không tự xóa assets, không có analytics feedback, text-to-video hay đa nền tảng. Scheduler và auto-publish là opt-in. Mốc vận hành 7 ngày/30 ngày trong đặc tả cần theo dõi thực tế sau deployment.

Nguồn kỹ thuật: [OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [Image API](https://developers.openai.com/api/docs/guides/image-generation), [BullMQ Job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [Job Schedulers](https://docs.bullmq.io/guide/job-schedulers), [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), [videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert).


## Chất lượng voice, hình và chống trùng sự kiện

Voice live đọc cả bản tin trong **một request mỗi lần thu** để giữ giọng/cadence nhất quán. `prompts/voice.md` yêu cầu đọc đủ cả câu hỏi cuối, điều khiển nhấn giọng và ngắt nghỉ; không tăng tốc audio để ép thời lượng. Whisper word timestamps được căn với script gốc bằng sequence alignment; các token không khớp được nội suy giữa mốc khớp. Nếu alignment thất bại, tự thu lại toàn bản tin tối đa một lần; vẫn thiếu sẽ dừng NEEDS_REVISION, nêu rõ scene thiếu và coverage riêng. Không giảm ngưỡng kiểm tra để cho qua cảnh mất lời. Audio/transcription/lỗi từng lần thu lưu ở thư mục voice step, logs hiện trên UI. Phụ đề dùng các mốc này; bản cũ không có word timestamps vẫn dùng đường tương thích. Mỗi lần thu có thêm một request transcription (`TRANSCRIPTION_CALL_RESERVE_USD=0.02`, là reservation, không phải hóa đơn); lần thu lại tính cả TTS và transcription vào ngân sách run.

Storyboard chia lời bằng code thành khoảng 10 nhịp, AI chỉ thiết kế hình cho lời đã khóa: minh họa chủ thể, số liệu có nguồn, diễn giải tác động và kết luận. Typography/source nằm trên lớp cố định; nền có chuyển động nhẹ luân phiên. Hình AI ghi rõ minh họa, không đóng vai ảnh sản phẩm chính thức. `OPENAI_IMAGE_QUALITY=medium` mặc định; thay đổi chất lượng có thể tăng chi phí. Hình lỗi dùng card và ghi fallback. Chất lượng cảm nhận vẫn cần xem/nghe preview; technical QC không đo mức hấp dẫn hay bảo đảm lượt xem.

Chống trùng gồm canonical URL/tiêu đề và kiểm tra **cùng sự kiện** bằng model trước khi rank. Lịch sử 90 ngày lấy đúng `rank.selected` của revision hiện tại ở video đã upload/public hoặc đang chờ duyệt/upload (kể cả upload chưa rõ kết quả); bỏ mock, skipped/failed và chính run đang tạo lại. Khác báo, URL hay cách giật title vẫn bị loại nếu cùng sự kiện. Follow-up chỉ giữ khi có diễn biến mới cụ thể. Quyết định/lý do nằm trong `rank/novelty.json`. Đây là phân loại có thể sai, không cam kết loại trùng tuyệt đối; giữ duyệt thủ công. Telegram chống xử lý trùng theo `update_id`; mỗi tin nhắn mới được tạo run riêng. Approval/upload vẫn idempotent theo run và revision.

Novelty và chấm điểm chạy theo nhóm tối đa 8 tin; schema ràng buộc số lượng kết quả
và ID được phép. Kiểm tra local vẫn chặn ID lặp/lạ, điểm ngoài khoảng và tham chiếu
duplicate/update tới chính nó hoặc tin đứng sau. Giữ kết quả hợp lệ và chỉ hỏi lại
các ID chưa đủ, tối đa 3 lượt mỗi nhóm. Novelty giữ toàn bộ ngữ cảnh và thứ tự ứng
viên để phát hiện trùng xuyên nhóm; chấm điểm dùng metadata/summary, không gửi lại
toàn bộ article evidence. Phản hồi cùng input lưu trong
`storage/diagnostics/<runId>/rev-<revision>/news-novelty-*.json` và `news-rank-*.json`,
kể cả JSON sai schema. Logs ghi số tin đã kiểm tra và ID chưa đủ. Hết số lượt vẫn
thiếu thì FAILED để retry sau, không coi đó là lỗi nội dung cần viết lại và không
tự gán điểm hay bỏ qua kiểm tra trùng.

Schema novelty còn ràng buộc `matched_id` riêng cho từng candidate: chỉ lịch sử
hoặc candidate đứng trước trong thứ tự input. NEW bắt buộc null; DUPLICATE/UPDATE
bắt buộc một ID hợp lệ, kể cả khi publication date của tin đứng sau cũ hơn.
Logs/lỗi nêu rõ thiếu kết quả, lặp ID, sai field/điểm hay sai tham chiếu.

Tạo preview cải tiến từ tin đã chọn của một run, **không sửa run, không gửi Telegram, không upload**:

```powershell
npm.cmd run video:preview -- <runId>
```

Kết quả/usage/QC nằm ở `storage/quality-preview/<id>/report.json`; MP4 ở `render/final.mp4`. Preview dùng provider theo cấu hình mock/live hiện tại. Khi muốn dùng bản mới trong luồng duyệt chính, regenerate `script` cho run chưa bắt đầu upload; preview riêng không có lệnh publish.

Kiểm chứng bản nâng cấp: build và 54 tests pass; preview live một lượt TTS dài 56,35 giây, word alignment 97,8%, technical QC 1080x1920/30fps/H.264/AAC đạt. Kiểm tra novelty bằng API thật đã loại cùng sự kiện đổi tiêu đề và giữ hai tin khác; không thay thế kiểm chứng độ chính xác của nguồn.

## Lịch video trên dashboard (UTC+7)

Mở mục **Lịch tạo video & upload YouTube** trên dashboard, chọn giờ bắt đầu hằng ngày (Việt Nam, UTC+7), số video từ 1–20, bật lịch và tùy chọn tự upload rồi lưu. Mặc định lịch dashboard tắt và vẫn duyệt thủ công. Cấu hình lưu PostgreSQL, worker đọc mỗi vòng dispatch (khoảng 2 giây), không cần sửa `.env` hay restart. Khi đã lưu lịch dashboard, lịch cron `.env` cũ ngừng tạo run để tránh hai lịch cùng chạy. Mỗi ngày tối đa một đợt; đổi giờ trong ngày đã khởi động không tạo thêm đợt.

Giờ đặt là giờ bắt đầu sản xuất; từng video một chủ đề được tạo lần lượt, upload khi render/kiểm chứng/QC đủ điều kiện. Đợt giữ số lượng và lựa chọn auto-upload tại lúc bắt đầu; thay đổi giờ/số lượng áp dụng cho đợt mới. Số lượng là số lượt tạo, không bảo đảm tất cả đăng thành công: video lỗi/cần sửa/bỏ qua được giữ để quản trị xử lý, đợt tiếp tục video kế tiếp. Video không auto-eligible vẫn chờ duyệt. Không bật auto-upload khi providers mock/mixed; upload giữ privacy trong `.env` (mặc định private). Lựa chọn này áp dụng riêng cho video theo lịch, không tự duyệt các run manual/Telegram.

Tắt lịch ngừng cấp video tiếp theo và ngừng tự duyệt các video chưa được duyệt; video đã chạy hoặc upload đã được xếp hàng vẫn tiếp tục. Bật lại tiếp tục đợt dở. Máy, PostgreSQL, Redis và worker phải chạy tại giờ đã đặt; không tạo bù một đợt chưa bắt đầu nếu máy tắt qua giờ đó. Đợt đã bắt đầu được tiếp tục sau restart. Request key và transaction khóa cấu hình chống tạo trùng khi nhiều worker cùng tick; auto-upload vẫn dùng approval/QC, revision và resumable-upload gates hiện có. Dashboard hiển thị giờ tiếp theo và lịch sử bảy đợt gần nhất, nhấn từng video để xem steps/logs.

Kiểm tra lịch với PostgreSQL thật bằng schema tạm riêng, không chạm lịch production/Redis và không gọi API ngoài:

```powershell
npm.cmd run test:schedule
```

Kiểm tra này tạo rồi xóa schema riêng, thử tám tick đồng thời, rollover UTC+7, thứ tự video, số lượng và outbox. `npm run check` kiểm tra thêm validation, bảo vệ API, tắt lịch, giới hạn batch và phục hồi auto-approval bằng fixtures mock; không chứng minh upload YouTube thật.

Khi tự upload đang được bật cho run, bước rank chỉ chọn tin có ngày xuất bản nguồn đã xác thực, rồi chọn điểm cao nhất trong nhóm đó. Tin thiếu ngày vẫn có thể chọn ở chế độ duyệt thủ công. Nếu không còn tin có ngày, rank dừng NEEDS_REVISION với `AUTO_UPLOAD_NO_DATED_NEWS` trước khi tốn phí TTS/render; không tự bịa ngày hoặc nới gate upload. QC lưu `auto_block_reasons`; logs, tab QC và preview Telegram nêu lý do chưa đủ điều kiện tự upload (ví dụ thiếu ngày nguồn hoặc thời lượng ngoài 45–60 giây). `hard_pass=true` không đồng nghĩa `auto_eligible=true`.
