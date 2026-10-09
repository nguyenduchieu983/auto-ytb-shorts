import { randomUUID } from 'node:crypto';
import { News, Script, Storyboard } from './domain';

export function mockNews(now: Date): News[] {
  const examples = [
    [
      'Công cụ lập trình AI mẫu',
      'coding',
      'OpenAI',
      'Công cụ mẫu hỗ trợ giải thích mã nguồn và đề xuất cách sửa lỗi. Đây là dữ liệu giả để kiểm tra pipeline, không phải thông báo sản phẩm thật.',
    ],
    [
      'Mô hình nghiên cứu mẫu',
      'model',
      'Google',
      'Mô hình mẫu được dùng để thử luồng tổng hợp tin và kiểm chứng nội dung. Không có benchmark hay giá bán thật trong bản demo này.',
    ],
    [
      'Hạ tầng AI thử nghiệm',
      'infrastructure',
      'NVIDIA',
      'Hệ thống hạ tầng mẫu giúp minh họa việc vận hành ứng dụng AI. Thông tin được tạo riêng cho kiểm thử và không mô tả sản phẩm đã phát hành.',
    ],
    [
      'Bảo mật công cụ mẫu',
      'security',
      'Cloudflare',
      'Công cụ bảo mật mẫu minh họa cách kiểm tra nguồn, loại bỏ tin trùng và xếp hạng nội dung trong hệ thống.',
    ],
    [
      'Kho mã nguồn mẫu',
      'developer-tools',
      'GitHub',
      'Kho mã nguồn mẫu được dùng để kiểm thử thẻ giới thiệu công cụ và liên kết nguồn trong phần mô tả video.',
    ],
  ];
  return examples.map(([title, category, company, summary], i) => ({
    id: randomUUID(),
    title,
    category,
    company,
    summary,
    evidence: summary,
    why_it_matters: 'Kiểm thử video mẫu',
    source: 'Demo fixture',
    url: `https://example.com/demo-${i}`,
    canonical_url: `https://example.com/demo-${i}`,
    published_at: new Date(now.getTime() - 3600000).toISOString(),
    event_date: null,
    kind: 'news',
    confidence: 1,
    older_than_24h: false,
    score: 95 - i * 5,
  }));
}
export function mockScript(news: News[]): Script {
  const hook =
    news.length === 1
      ? 'Đây là video demo giải thích một chủ đề công nghệ bằng dữ liệu mẫu.'
      : 'Đây là bản demo bản tin AI và công nghệ, với dữ liệu mẫu để kiểm tra hệ thống.';
  const segments = news.map((n) => ({
    news_id: n.id,
    narration:
      n.summary +
      ' Điểm cần nhớ là luôn đối chiếu nguồn trước khi áp dụng thông tin vào công việc.',
    headline: n.title,
    key_takeaway: 'Đối chiếu nguồn trước khi sử dụng.',
  }));
  const takeaway =
    'Hệ thống sẽ tạo lời đọc, hình minh họa và phụ đề, sau đó kiểm tra video trước khi gửi người quản trị duyệt.';
  const cta =
    'Video này dùng âm thanh thử nghiệm, chưa phải nội dung để đăng lên kênh. Bạn có thể thử duyệt hoặc tạo lại từng bước.';
  return {
    hook,
    segments,
    takeaway,
    cta,
    full_script: [hook, ...segments.map((s) => s.narration), takeaway, cta].join(' '),
    estimated_duration_sec: 55,
  };
}
export function mockStoryboard(script: Script): Storyboard {
  const narrations = [
    script.hook,
    ...script.segments.map((s) => s.narration),
    script.takeaway,
    script.cta,
  ];
  const headlines = [
    'Bản tin AI & Tech mẫu',
    ...script.segments.map((s) => s.headline),
    'Kiểm tra và duyệt video',
    'Demo pipeline hoàn chỉnh',
  ];
  return {
    scenes: narrations.map((n, i) => ({
      scene_id: i + 1,
      narration: n,
      visual_type: 'headline-card',
      visual_prompt: 'Editorial technology visual, dark navy, cyan accents, no embedded text',
      overlay_text: headlines[i],
      source_label: 'DEMO / example.com',
    })),
  };
}
