# AI & Tech YouTube Shorts Automation — Implementation Plan

## 1. Mục tiêu

Build pipeline tự động mỗi ngày:

```text
Scheduler
→ tìm tin AI & Tech mới trong 24h
→ xác minh + xếp hạng
→ chọn top 3
→ sinh script tiếng Việt 45–60s
→ sinh storyboard
→ sinh voice + visual
→ render video 9:16 bằng FFmpeg
→ QC
→ gửi Telegram review
→ upload YouTube Shorts qua OAuth2
→ lưu log/analytics
```

V1 ưu tiên ổn định, rẻ, audit được. Chưa cần API text-to-video; dùng OpenAI Image + TTS + FFmpeg.

---

## 2. Stack

- NestJS + TypeScript
- PostgreSQL
- Redis + BullMQ
- OpenAI Responses API + Web Search
- OpenAI text generation
- OpenAI Image API
- OpenAI TTS/audio API
- FFmpeg / ffprobe
- Telegram Bot
- YouTube Data API v3 + OAuth 2.0
- Node.js chạy trực tiếp; PostgreSQL + Redis native hoặc server riêng (không dùng Docker)

Optional V2:
- Seedance/Kling/Runway/Veo adapter
- analytics feedback loop
- auto-publish
- TikTok/Facebook Reels

---

## 3. Kiến trúc

```text
Cron/BullMQ Scheduler
        ↓
News Discovery
        ↓
News Validation + Dedup
        ↓
News Ranking
        ↓
Script Generator
        ↓
Fact Verification
        ↓
Storyboard Generator
        ↓
 ┌─────────────┬─────────────┐
 ↓             ↓             ↓
TTS         Images        Metadata
 └──────┬──────┘
        ↓
Subtitle Builder
        ↓
FFmpeg Renderer
        ↓
Quality Check
        ↓
Telegram Approval
        ↓
YouTube Upload
        ↓
Analytics
```

---

## 4. Scheduler

Ví dụ chạy 07:30 mỗi ngày theo `Asia/Ho_Chi_Minh`.

`.env`:

```env
APP_TIMEZONE=Asia/Ho_Chi_Minh
DAILY_JOB_CRON=0 30 7 * * *
AUTO_PUBLISH=false
```

Ưu tiên BullMQ repeatable job thay vì chạy toàn bộ pipeline trong `@Cron()`.

Mỗi ngày chỉ được có 1 `daily_run`:

```text
UNIQUE(run_date)
```

---

## 5. Pipeline states

```text
PENDING
SEARCHING_NEWS
RANKING_NEWS
GENERATING_SCRIPT
VERIFYING_SCRIPT
GENERATING_STORYBOARD
GENERATING_VOICE
GENERATING_VISUALS
RENDERING
QUALITY_CHECK
WAITING_APPROVAL
UPLOADING
PUBLISHED
FAILED
SKIPPED
```

Nếu một step fail, retry đúng step đó; không chạy lại toàn pipeline.

---

## 6. News Discovery

OpenAI Web Search tìm tin trong 24h gần nhất.

Ưu tiên:

- OpenAI
- Anthropic
- Google / DeepMind
- Meta AI
- Microsoft
- GitHub
- NVIDIA / AMD
- AWS / Cloudflare
- startup AI
- Reuters / AP / TechCrunch / The Verge
- official developer blogs

Chủ đề:

- model/API mới
- coding agent
- AI agent
- developer tools
- cybersecurity
- chips / AI infrastructure
- robotics
- startup/service mới nổi

Loại bỏ:
- tin trùng
- SEO rác
- rumor không nguồn
- bài opinion không có thông tin mới

Output JSON:

```json
{
  "items": [
    {
      "title": "",
      "source": "",
      "url": "",
      "published_at": "",
      "summary": "",
      "why_it_matters": "",
      "category": "",
      "confidence": 0.0
    }
  ]
}
```

Config:

```yaml
news:
  lookback_hours: 24
  min_items: 5
  max_items: 15
  selected_items: 3
```

Nếu không đủ 5 tin, mở rộng 48h nhưng phải đánh dấu `older_than_24h=true`.

---

## 7. Validation + dedup

Mỗi item phải có:

```text
URL hợp lệ
published_at
source
title
summary
```

Dedup:
- normalize title
- same canonical URL
- fuzzy title similarity > 0.85

Ưu tiên giữ:
1. nguồn chính thức
2. Reuters/AP
3. báo tech lớn

---

## 8. News scoring

Mỗi tin chấm 0–100:

```text
novelty            25
developer_interest 25
mass_appeal        20
practical_value    20
source_quality     10
```

Diversity rule:

```text
max 2 tin cùng một công ty
max 2 tin cùng category
```

Chọn top 3 sau diversity filter.

---

## 9. Script generation

Mục tiêu:

```text
45–60 giây
130–160 từ tiếng Việt
```

Format:

```text
0–3s   Hook
3–18s  Tin #1
18–33s Tin #2
33–48s Tin #3
48–55s Tool/takeaway
55–60s CTA
```

Tone:
- ngắn
- dễ nghe
- ưu tiên “tin → ý nghĩa → dev dùng được gì”
- không đọc y nguyên báo

Không được:
- bịa ngày
- bịa benchmark
- bịa giá
- bịa tên model
- thêm claim ngoài nguồn

Output:

```json
{
  "hook": "",
  "segments": [
    {
      "news_id": "",
      "start_sec": 3,
      "end_sec": 18,
      "narration": "",
      "headline": "",
      "key_takeaway": ""
    }
  ],
  "cta": "",
  "full_script": "",
  "estimated_duration_sec": 55
}
```

---

## 10. Fact verification

Sau khi có script, chạy thêm một pass:

Input:
- selected news
- script

Yêu cầu model trả:

```json
{
  "unsupported_claims": [],
  "needs_rewrite": false
}
```

Nếu có unsupported claim:
- rewrite
- verify lại
- max 2 vòng

Nếu vẫn fail:
- `WAITING_APPROVAL`
- không auto publish

Freshness rule:
- tin >24h không dùng từ “hôm nay vừa...”
- dùng “mới đây...”

---

## 11. Storyboard

Output JSON:

```json
{
  "scenes": [
    {
      "scene_id": 1,
      "start_sec": 0,
      "end_sec": 3,
      "narration": "",
      "visual_type": "image",
      "visual_prompt": "",
      "overlay_text": "",
      "source_label": ""
    }
  ]
}
```

Visual type V1:

```text
image
headline-card
logo-card
quote-card
motion-card
```

V2 mới thêm `video_clip`.

---

## 12. Branding

Style cố định:

```text
9:16
dark navy / black
cyan / purple accent
clean tech newsroom
high contrast
minimal
```

Config:

```yaml
branding:
  channel_name: "AI Tech Daily"
  logo_path: "./assets/logo.png"
  font: "Inter"
```

Giữ safe margins vì YouTube UI che hai bên dưới.

---

## 13. Image generation

Mỗi video tạo 4–7 ảnh.

Prompt base:

```text
vertical 9:16 editorial technology visual,
clean premium AI newsroom aesthetic,
dark navy background,
high contrast,
clear subject,
negative space for subtitles,
no embedded text unless explicitly requested
```

Lưu:

```text
storage/YYYY-MM-DD/images/01.png
...
```

---

## 14. TTS

Script → `voice.mp3`

Requirements:
- tiếng Việt
- giọng cố định
- tốc độ tự nhiên
- không quá nhanh

Sau generate dùng ffprobe lấy duration.

Rule:

```text
<40s → script quá ngắn
>65s → script quá dài
```

Regenerate script hoặc điều chỉnh TTS speed nhẹ.

---

## 15. Subtitle

Ưu tiên `.ass` để style tốt hơn SRT.

Rule:
- max 2 dòng
- 4–7 từ/chunk
- font lớn
- outline
- vùng lower-center nhưng chừa UI YouTube

Nếu chưa có word timestamp chính xác, V1 dùng scene timing. V2 dùng alignment/word timestamps.

---

## 16. FFmpeg render

Output:

```text
1080x1920
30 fps
H.264
AAC
yuv420p
45–60s target
```

Pipeline:

```text
image
→ scale/crop
→ zoom/pan
→ transition
→ overlay
→ subtitle
→ voice
→ background music
→ loudness normalize
→ final.mp4
```

Không để ảnh đứng im toàn scene.

Preset motion:
- slow zoom in
- slow zoom out
- pan left/right
- fade
- slide nhẹ

Background music phải royalty-free/owned.

---

## 17. Metadata

Generate JSON:

```json
{
  "title": "",
  "description": "",
  "hashtags": [],
  "tags": []
}
```

Rule:
- title ưu tiên <=70 chars
- 3–5 hashtags
- không keyword stuffing
- description có nguồn

Example:

```text
3 tin AI & Tech nổi bật hôm nay.

1. ...
2. ...
3. ...

Nguồn:
- ...
- ...
- ...

#AI #Tech #Shorts
```

---

## 18. YouTube OAuth

Upload KHÔNG dùng API key.

Cần OAuth 2.0 scope:

```text
https://www.googleapis.com/auth/youtube.upload
```

Setup:
1. Google Cloud Project
2. Enable YouTube Data API v3
3. OAuth Client
4. User consent lần đầu
5. lấy refresh token
6. backend lưu refresh token an toàn
7. tự refresh access token

Env:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_PRIVACY_STATUS=private
```

Ban đầu upload `private`.
Sau khi flow ổn mới chuyển public.

---

## 19. Upload flow

```text
final.mp4
↓
videos.insert
↓
title/description/tags
↓
privacyStatus
↓
save youtube_video_id
```

Nếu upload fail:
- retry 30s
- retry 2m
- retry 10m

Không rerender nếu chỉ upload fail.

---

## 20. Telegram approval

Env:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=
AUTO_PUBLISH=false
```

Bot gửi:

```text
✅ Daily AI video ready

Title: ...
Duration: 56s

Top news:
1. ...
2. ...
3. ...

Status: WAITING_APPROVAL

/publish
/regenerate
/skip
/status
```

Commands:
- `/publish <runId>`
- `/regenerate <runId> script`
- `/regenerate <runId> voice`
- `/regenerate <runId> visuals`
- `/regenerate <runId> render`
- `/skip <runId>`
- `/status <runId>`

Chỉ whitelist Telegram user/chat ID admin.

---

## 21. Quality Check

Technical:
- file tồn tại
- resolution 1080x1920
- duration 40–65s
- video H264
- audio AAC
- có audio stream
- không file zero-byte

Content:
- đủ selected news
- source URLs tồn tại
- không duplicate
- script verified
- metadata đủ
- subtitle tồn tại

QC score:

```text
source_quality
freshness
script_quality
duration
visual_coverage
audio_quality
```

0–100.

Auto-publish chỉ khi:

```text
QC >= 85
```

Nếu thấp hơn → Telegram review.

---

## 22. Database schema

### daily_runs

```text
id
run_date
status
started_at
finished_at
error_message
retry_count
created_at
updated_at
```

### news_items

```text
id
run_id
title
source
url
published_at
summary
why_it_matters
category
score
selected
created_at
```

### scripts

```text
id
run_id
script_json
full_script
estimated_duration
verification_json
created_at
```

### videos

```text
id
run_id
voice_path
video_path
thumbnail_path
duration_sec
youtube_video_id
youtube_url
status
created_at
```

### pipeline_logs

```text
id
run_id
step
level
message
payload_json
created_at
```

### api_costs

```text
id
run_id
provider
operation
model
input_tokens
output_tokens
estimated_cost
created_at
```

---

## 23. Storage

```text
storage/
└── YYYY-MM-DD/
    ├── news.json
    ├── script.json
    ├── storyboard.json
    ├── metadata.json
    ├── voice.mp3
    ├── subtitles.ass
    ├── thumbnail.png
    ├── images/
    │   ├── 01.png
    │   └── ...
    └── final.mp4
```

---

## 24. BullMQ queues

```text
daily
news
script
assets
render
youtube
analytics
```

Jobs:

```text
daily-pipeline
discover-news
rank-news
generate-script
verify-script
generate-storyboard
generate-voice
generate-images
render-video
quality-check
send-approval
upload-youtube
fetch-analytics
```

Job ID:

```text
YYYY-MM-DD:step
```

Idempotent: nếu step success thì skip trừ `force=true`.

---

## 25. Service abstraction

```ts
OpenAiService
  searchNews()
  rankNews()
  generateScript()
  verifyScript()
  generateStoryboard()
  generateMetadata()
  generateImage()
  generateVoice()

VideoService
  buildSubtitles()
  render()
  probe()
  validate()

YoutubeService
  getAccessToken()
  upload()
  getVideo()

TelegramService
  sendPreview()
  sendError()
  handleCommand()
```

---

## 26. Prompt files

```text
prompts/
├── news-search.md
├── news-rank.md
├── script.md
├── verify-script.md
├── storyboard.md
├── metadata.md
└── image.md
```

Không hard-code prompt dài trong service.

Version prompt:
```text
v1
v2
```

---

## 27. API / Admin endpoints

```http
POST /pipeline/run
GET  /pipeline/today
GET  /pipeline/:id
POST /pipeline/:id/regenerate
POST /pipeline/:id/publish
POST /pipeline/:id/skip
```

Protect bằng admin token / internal auth.

---

## 28. Runtime trực tiếp (không dùng Docker)

Processes/services:

```text
api
worker
postgres
redis
```

Máy chạy worker phải có:
- ffmpeg
- ffprobe

Storage trên filesystem:

```text
./storage
```

Không chạy FFmpeg trong HTTP request thread.

---

## 29. ENV

```env
NODE_ENV=production

DATABASE_URL=
REDIS_URL=

OPENAI_API_KEY=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=

TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=

APP_TIMEZONE=Asia/Ho_Chi_Minh
DAILY_JOB_CRON=0 30 7 * * *
AUTO_PUBLISH=false
```

Không commit `.env`.

---

## 30. Config

```yaml
pipeline:
  auto_publish: false

news:
  lookback_hours: 24
  min_items: 5
  max_items: 15
  selected_items: 3

script:
  language: vi
  target_duration_sec: 55
  min_duration_sec: 45
  max_duration_sec: 60

video:
  width: 1080
  height: 1920
  fps: 30

assets:
  image_count: 6

youtube:
  privacy_status: private
```

---

## 31. Mock mode

Bắt buộc có:

```env
MOCK_OPENAI=true
MOCK_YOUTUBE=true
```

Dùng fixtures để dev không đốt tiền API.

---

## 32. Testing

Unit:
- dedup news
- news score transform
- subtitle chunking
- duration validator
- idempotency
- metadata validation

Integration:
- OpenAI structured response parsing
- FFmpeg render
- ffprobe validation
- OAuth refresh
- YouTube upload mock

E2E:
```text
mock news
→ script
→ storyboard
→ mock assets
→ render
→ QC
→ mock upload
```

---

## 33. Failure policy

OpenAI search fail:
```text
retry
```

Không đủ tin:
```text
SKIPPED
```

Image fail:
```text
fallback headline card
```

TTS fail:
```text
retry
```

FFmpeg fail:
- log stderr
- giữ asset để debug

YouTube fail:
- retry upload only

Pipeline final fail:
- Telegram notify
- save exact failed step

---

## 34. Content fallback

Nếu chỉ có 2 tin chất lượng:

```text
2 tin + 1 tool/repo/service đáng thử
```

Nếu không đủ:
```text
skip video
```

Không bịa cho đủ 3 tin.

---

## 35. Copyright

Không:
- re-upload nguyên clip báo chí
- dùng nhạc copyrighted không license
- copy nguyên bài báo

Dùng:
- AI-generated visuals
- owned/licensed assets
- paraphrased script
- source attribution

---

## 36. Analytics V2

Sau publish:

```text
24h
48h
7d
```

Lưu:
- views
- likes
- comments
- subscriber gain
- watch metrics nếu API cung cấp

Sau >=20 video:

```text
analytics
→ OpenAI analysis
→ best hook
→ best duration
→ best topic
→ best CTA
```

Dùng kết quả làm input cho ngày sau.

---

## 37. Video generation API V2

Tạo interface:

```ts
interface VideoGenerationProvider {
  generateClip(input: {
    prompt: string;
    durationSec: number;
    aspectRatio: '9:16';
  }): Promise<string>;
}
```

Adapters:
- Seedance
- Kling
- Runway
- Veo

MVP set:

```env
VIDEO_PROVIDER=none
```

FFmpeg + image vẫn là fallback bắt buộc.

---

## 38. Multi-platform V3

Sau YouTube ổn mới thêm:

```text
TikTok
Facebook Reels
```

Không coupling upload logic với YouTube.

Interface:

```ts
interface PublishingProvider {
  publish(video, metadata): Promise<PublishResult>;
}
```

---

## 39. Development order

### Phase 1
- bootstrap NestJS
- PostgreSQL
- Redis/BullMQ
- migrations
- daily_runs

### Phase 2
- web search
- validate/dedup
- rank
- script
- verification

### Phase 3
- storyboard
- image
- TTS
- subtitles

### Phase 4
- FFmpeg renderer
- ffprobe QC

### Phase 5
- Telegram approval

### Phase 6
- Google OAuth
- YouTube private upload

### Phase 7
- Node.js API/worker + PostgreSQL/Redis native hoặc server riêng
- production schedule
- logs/retries/cost tracking

---

## 40. Acceptance criteria V1

Hoàn thành khi:

- daily scheduler chạy đúng timezone
- không duplicate run
- lấy được news có source
- dedup + rank + chọn top 3
- script 45–60s
- script được fact-check
- có voice
- có >=4 visuals
- có subtitle
- render 1080x1920 H264/AAC
- QC chạy tự động
- Telegram nhận preview
- `/publish` hoạt động
- OAuth refresh hoạt động
- YouTube private upload thành công
- lưu `youtube_video_id`
- retry + logs đầy đủ
- không leak secrets

---

## 41. Project structure

```text
ai-news-shorts/
├── src/
│   ├── modules/
│   │   ├── news/
│   │   ├── script/
│   │   ├── assets/
│   │   ├── video/
│   │   ├── youtube/
│   │   ├── telegram/
│   │   └── pipeline/
│   ├── jobs/
│   ├── queues/
│   └── common/
├── prompts/
├── assets/
├── config/
├── storage/
├── test/
├── .env.example
└── README.md
```

README phải hướng dẫn:
- setup OpenAI
- setup PostgreSQL/Redis
- cài FFmpeg
- setup Telegram bot
- Google OAuth lần đầu
- lấy refresh token
- chạy local
- chạy worker
- trigger manual
- publish manual
- troubleshooting

---

## 42. Daily production flow

```text
07:30 News Search
07:33 Validate + Rank
07:35 Script + Verify
07:40 Storyboard
07:42 Voice + Images
07:50 Render
07:53 QC
07:55 Telegram Preview
08:00 Publish nếu approve
```

Sau 2–4 tuần ổn định:

```text
AUTO_PUBLISH=true
```

nhưng vẫn giữ QC gate.

---

## 43. Success criteria sau 30 ngày

Engineering:
```text
pipeline success rate >95%
average pipeline time <20 min
manual intervention <20%
cost/run được track
```

Content:
```text
30 video
view/watch metrics được lưu
không có factual error nghiêm trọng
```

---

## 44. Nguyên tắc quan trọng

1. Source-grounded trước, sáng tạo sau.
2. Không auto publish nếu verification/QC fail.
3. Không để upload failure làm render lại video.
4. Không để AI tự invent source.
5. Không hard-code credentials.
6. Không phụ thuộc text-to-video provider ở V1.
7. FFmpeg renderer phải luôn là fallback.
8. Tất cả thời gian DB lưu UTC; scheduler dùng timezone config.
9. Có mock mode để Codex/test không đốt API.
10. Mỗi step phải reproducible và idempotent.

---

## 45. Mục tiêu cuối cùng

Build được một hệ thống:

```text
AI & Tech News
→ Search
→ Verify
→ Script
→ Voice
→ Visual
→ Video 9:16
→ QC
→ Review/Auto Publish
→ YouTube Shorts
```

chạy hằng ngày với chi phí thấp, có source rõ ràng, có retry/audit, và sẵn kiến trúc để sau này thêm Seedance/Kling, TikTok, Facebook Reels và analytics feedback loop.
