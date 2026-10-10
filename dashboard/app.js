'use strict';
const $ = (id) => document.getElementById(id);
const names = {
  discover: 'Tìm nguồn tin',
  rank: 'Chọn tin & chống trùng',
  script: 'Viết kịch bản',
  verify: 'Kiểm chứng nội dung',
  storyboard: 'Thiết kế storyboard',
  voice: 'Tạo giọng đọc',
  visuals: 'Tạo hình minh họa',
  metadata: 'Tiêu đề & mô tả',
  subtitles: 'Căn phụ đề',
  render: 'Render video',
  qc: 'Kiểm tra chất lượng',
  approval: 'Gửi preview & chờ duyệt',
  upload: 'Upload YouTube',
};
const descriptions = {
  discover: 'Tìm web, đọc bài nguồn và RSS dự phòng',
  rank: 'Xếp hạng, so sự kiện và chọn 1 chủ đề cho video',
  script: 'Viết lời đọc tiếng Việt theo ngân sách thời lượng',
  verify: 'Đối chiếu các claims với bằng chứng nguồn',
  storyboard: 'Chia lời thành cảnh, thiết kế hình cho từng nhịp',
  voice: 'TTS liền mạch và căn word timestamps',
  visuals: 'Minh họa AI, card và lớp typography',
  metadata: 'Chuẩn bị title, description và nguồn',
  subtitles: 'Tạo phụ đề theo thời điểm lời đọc',
  render: 'Ghép cảnh, audio và subtitle bằng FFmpeg',
  qc: 'Đo kỹ thuật, kiểm tra nguồn và checksum',
  approval: 'Gửi preview; cần duyệt đúng revision',
  upload: 'Truyền file qua resumable session',
};
const labels = {
  PENDING: 'Đang chờ',
  RUNNING: 'Đang chạy',
  WAITING_APPROVAL: 'Chờ duyệt',
  NEEDS_REVISION: 'Cần chỉnh sửa',
  UPLOADING: 'Đang upload',
  UPLOADED_PRIVATE: 'Đã upload riêng tư',
  PUBLISHED: 'Đã xuất bản',
  UPLOAD_UNCERTAIN: 'Cần đối soát',
  FAILED: 'Lỗi',
  SKIPPED: 'Đã bỏ qua',
  SUCCEEDED: 'Hoàn tất',
  QUEUED: 'Đã xếp hàng',
};
const state = {
  page: 1,
  pages: 0,
  id: null,
  revision: null,
  tab: 'pipeline',
  detail: null,
  runtime: null,
  busy: false,
  polling: false,
  system: false,
  signature: '',
  logStep: '',
  logLevel: '',
  createKey: null,
  scheduleLoaded: false,
  scheduleDirty: false,
};
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const badge = (v) => `<span class="badge ${esc(v)}">${esc(labels[v] || v)}</span>`;
const fmtDate = (v) =>
  v
    ? new Date(v).toLocaleString('vi-VN', {
        timeZone: state.runtime?.timezone || 'Asia/Ho_Chi_Minh',
        hour12: false,
      })
    : '—';
const money = (v) => '$' + Number(v || 0).toFixed(2);
const output = (step) => state.detail?.steps.find((s) => s.step === step)?.output;
function asset(step, kind, scene) {
  return `/dashboard/api/runs/${encodeURIComponent(state.id)}/assets/${state.detail.viewed_revision}/${step}?kind=${kind}${scene === undefined ? '' : '&scene=' + scene}`;
}
function notice(message, error = false) {
  $('notice').hidden = false;
  $('notice').className = 'notice' + (error ? '' : ' success');
  $('notice').textContent = message;
}
function loginView() {
  $('app').hidden = true;
  $('login').hidden = false;
  state.id = null;
  state.detail = null;
  state.scheduleLoaded = false;
  state.scheduleDirty = false;
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    cache: 'no-store',
  });
  if (response.status === 401 && path !== '/dashboard/login') loginView();
  const data = await response.json().catch(() => ({ error: 'Phản hồi không hợp lệ' }));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function stat(label, value, note, icon) {
  return `<div class="stat"><div class="stat-label">${esc(label)}<span class="stat-icon">${icon}</span></div><div class="stat-value">${esc(value)}</div><small>${esc(note)}</small></div>`;
}
function runtimeView(r) {
  state.runtime = r;
  $('runtime-strip').innerHTML =
    ['API', 'PostgreSQL', 'Redis', 'Worker']
      .map(
        (n, i) =>
          `<span class="service"><i class="dot ${[r.api, r.database, r.redis, r.worker][i] ? 'ok' : 'bad'}"></i>${n} · ${[r.api, r.database, r.redis, r.worker][i] ? 'Online' : 'Offline'}</span>`,
      )
      .join('') +
    `<span class="strip-settings">${r.auto_publish ? 'Auto-publish' : r.schedule && r.scheduled_auto_publish ? 'Lịch: tự upload' : 'Duyệt thủ công'} · ${esc(r.privacy)} · Lịch ${r.schedule ? 'bật' : 'tắt'}</span>`;
  $('side-mode').innerHTML =
    `<span class="badge ${Object.values(r.modes).every((v) => v === 'live') ? 'SUCCEEDED' : 'PENDING'}">${Object.values(r.modes).every((v) => v === 'live') ? '● LIVE PROVIDERS' : '● MOCK / MIXED'}</span>`;
  const workers = r.workers.filter((w) => Date.now() - new Date(w.updated_at).getTime() < 45000);
  $('system-info').innerHTML =
    stat(
      'Worker đang sống',
      workers.length,
      'Heartbeat gần nhất ' + (r.workers[0] ? fmtDate(r.workers[0].updated_at) : 'chưa có'),
      '◎',
    ) +
    stat(
      'Telegram inbox chờ',
      r.inbox.find((i) => i.status === 'PENDING')?.count || 0,
      'Receiver: ' + r.telegram_mode,
      '↳',
    ) +
    stat(
      'Ngân sách / video',
      r.max_cost === 0 ? 'Không giới hạn' : money(r.max_cost),
      'Reservation cấu hình, không phải hóa đơn',
      '$',
    ) +
    stat(
      'YouTube privacy',
      r.privacy,
      'OpenAI ' + r.modes.openai + ' · Telegram ' + r.modes.telegram,
      '↗',
    );
}
function listView(data) {
  state.pages = data.pages;
  const sum = Object.fromEntries(data.summary.map((s) => [s.status, Number(s.count)]));
  const total = data.summary.reduce((n, s) => n + Number(s.count), 0);
  $('stats').innerHTML =
    stat('Tổng video', total, 'Tất cả yêu cầu sản xuất', '◫') +
    stat(
      'Đang sản xuất',
      (sum.RUNNING || 0) + (sum.PENDING || 0) + (sum.UPLOADING || 0),
      'Đang chờ, chạy hoặc upload',
      '↻',
    ) +
    stat('Chờ duyệt', sum.WAITING_APPROVAL || 0, 'Sẵn sàng xem preview & quyết định', '◷') +
    stat(
      'Cần xử lý',
      (sum.FAILED || 0) + (sum.NEEDS_REVISION || 0) + (sum.UPLOAD_UNCERTAIN || 0),
      'Lỗi, chỉnh sửa hoặc đối soát',
      '!',
    );
  $('run-count').textContent = data.total;
  $('run-list').innerHTML = data.items.length
    ? data.items
        .map(
          (r) =>
            `<button class="run-card ${state.id === r.id ? 'selected' : ''}" data-run="${esc(r.id)}"><div class="run-meta"><span>${esc(r.run_date)} · R${r.revision}</span><span>${r.mock ? 'MOCK' : 'LIVE'}</span></div><div class="run-title">${esc(r.title)}</div>${badge(r.status)}<div class="run-bottom"><span>${esc(r.current_steps.map((s) => names[s]).join(' + ') || (r.status === 'WAITING_APPROVAL' ? 'Sẵn sàng duyệt' : 'ID ' + r.id.slice(0, 8)))}</span><span>${r.completed}/13</span></div><div class="progress"><i style="width:${Math.round((r.completed / 13) * 100)}%"></i></div></button>`,
        )
        .join('')
    : '<div class="empty"><h2>Chưa có video</h2><p>Tạo yêu cầu mới hoặc đổi bộ lọc.</p></div>';
  $('page-info').textContent = `Trang ${data.page} / ${Math.max(1, data.pages)}`;
  $('prev').disabled = data.page <= 1;
  $('next').disabled = data.page >= data.pages;
  if (!state.id && data.items.length) {
    state.id = data.items[0].id;
    state.revision = null;
    state.signature = '';
  }
}
function safeLink(url, text) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return esc(text);
    return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
  } catch {
    return esc(text);
  }
}
function pipelineView(d) {
  const done = d.steps.filter((s) => s.status === 'SUCCEEDED').length;
  return `<div class="pipeline-summary"><span>${done}/13 bước hoàn tất · gồm các nhánh chạy song song</span><span>Revision ${d.viewed_revision}</span></div><div class="steps">${d.step_order
    .map((key, i) => {
      const s = d.steps.find((s) => s.step === key);
      const duration = s?.started_at
        ? Math.max(
            0,
            Math.round(
              ((s.finished_at ? new Date(s.finished_at) : new Date()).getTime() -
                new Date(s.started_at).getTime()) /
                1000,
            ),
          )
        : null;
      return `<div class="step ${esc(s?.status)}"><span class="step-number">${s?.status === 'SUCCEEDED' ? '✓' : String(i + 1).padStart(2, '0')}</span><div><h3>${esc(names[key])}</h3><p class="step-note">${esc(s?.error_message || descriptions[key])}</p></div><div class="step-right">${badge(s?.status || 'PENDING')}<small>${s?.attempts ? 'Lần ' + s.attempts : ''}${duration === null ? '' : ' · ' + duration + 's'}</small></div></div>`;
    })
    .join('')}</div>`;
}
function contentView() {
  const news = output('rank')?.selected || [];
  const script = output('verify')?.script || output('script');
  const metadata = output('metadata');
  return `<p class="section-caption">${news.length} TIN ĐƯỢC CHỌN</p>${news.length ? news.map((n) => `<article class="news-item"><h3>${esc(n.title)}</h3><p>${esc(n.summary)}</p>${safeLink(n.url, n.source + ' ↗')}<p>Ngày nguồn: ${esc(n.published_at ? fmtDate(n.published_at) : 'Chưa xác định')} · Confidence: ${esc(n.confidence)}</p></article>`).join('') : '<p class="muted">Chưa chọn được tin.</p>'}<p class="section-caption" style="margin-top:24px">KỊCH BẢN LỜI ĐỌC</p><div class="content-block"><p>${esc(script?.full_script || 'Chưa có kịch bản.')}</p></div>${metadata ? `<p class="section-caption">METADATA YOUTUBE</p><div class="content-block"><h3>${esc(metadata.title)}</h3><p>${esc(metadata.description)}</p></div>` : ''}`;
}
function previewView() {
  const render = output('render'),
    voice = output('voice'),
    visuals = output('visuals');
  return `<div class="preview">${render ? `<video controls preload="metadata" src="${asset('render', 'video')}" poster="${asset('render', 'thumbnail')}"></video><div class="asset-links"><a href="${asset('render', 'video')}" target="_blank">Mở MP4 ↗</a><a href="${asset('render', 'thumbnail')}" target="_blank">Thumbnail ↗</a>${output('subtitles') ? `<a href="${asset('subtitles', 'subtitle')}" target="_blank">Phụ đề ASS ↗</a>` : ''}</div>` : '<div class="empty"><h2>Chưa có bản dựng</h2><p>Preview sẽ xuất hiện sau bước render.</p></div>'}${voice ? `<p class="section-caption">GIỌNG ĐỌC · ${Number(voice.duration).toFixed(1)} GIÂY ${voice.mock ? '· MOCK' : ''}</p><audio controls preload="none" src="${asset('voice', 'audio')}"></audio>` : ''}${visuals ? `<p class="section-caption">HÌNH MINH HỌA</p><div class="gallery">${visuals.images.map((i) => `<a href="${asset('visuals', 'image', i.scene_id)}" target="_blank"><img loading="lazy" src="${asset('visuals', 'image', i.scene_id)}" alt="Minh họa cảnh ${i.scene_id}">Cảnh ${i.scene_id}${i.fallback ? ' · Fallback' : ''}</a>`).join('')}</div>` : ''}</div>`;
}
function qcView() {
  const qc = output('qc'),
    verify = output('verify');
  return `<div class="content-block"><h3>Kiểm chứng facts: ${verify?.verified ? 'Đạt' : 'Chưa đạt / chưa chạy'}</h3><p>${esc(JSON.stringify(verify?.verification || {}, null, 2))}</p></div>${
    qc
      ? `<div class="stats">${stat('QC score', qc.score + '/100', 'Chỉ phản ánh gates kỹ thuật', '✓')}${stat('Thời lượng', Number(qc.duration).toFixed(1) + 's', 'Mục tiêu 45–60 giây', '◷')}</div><div class="qc-grid">${Object.entries(
          qc.checks,
        )
          .map(
            ([k, v]) => `<div class="qc-check ${v ? '' : 'fail'}">${v ? '✓' : '✕'} ${esc(k)}</div>`,
          )
          .join(
            '',
          )}</div><p class="hint">Auto-eligible: ${qc.auto_eligible ? 'Có' : 'Không'}. QC kỹ thuật không thay thế xem/nghe preview và duyệt nội dung.</p>`
      : '<p class="muted">Chưa có kết quả QC.</p>'
  }`;
}
function costsView(d) {
  return `<div class="content-block"><p>Tổng reservation qua mọi revision: <b>${money(d.costs.reduce((n, c) => n + Number(c.reserved_usd), 0))}</b></p><p class="hint">Đây là reservation theo cấu hình; không phải hóa đơn hay chi phí thực tế từ nhà cung cấp.</p></div><table><thead><tr><th>Bước</th><th>Model</th><th>Reserve</th><th>Tokens in / out</th></tr></thead><tbody>${d.costs.map((c) => `<tr><td>${esc(names[c.operation] || c.operation)}</td><td>${esc(c.model)}</td><td>${money(c.reserved_usd)}</td><td>${c.input_tokens ?? '—'} / ${c.output_tokens ?? '—'}</td></tr>`).join('')}</tbody></table>${d.uploads.map((u) => `<div class="content-block">Upload R${u.revision}: ${esc(u.status)}<p>${u.youtube_video_id && !u.youtube_video_id.startsWith('mock-') ? safeLink('https://www.youtube.com/watch?v=' + encodeURIComponent(u.youtube_video_id), u.youtube_video_id + ' ↗') : esc(u.youtube_video_id || 'Chưa có video ID')}</p></div>`).join('')}`;
}
function logsView(d) {
  const logs = d.logs.filter(
    (l) =>
      (!state.logStep || l.step === state.logStep) &&
      (!state.logLevel || l.level === state.logLevel),
  );
  return `<div class="log-toolbar"><select id="log-step" aria-label="Lọc logs theo bước"><option value="">Tất cả bước</option>${d.step_order.map((s) => `<option value="${s}" ${state.logStep === s ? 'selected' : ''}>${esc(names[s])}</option>`).join('')}</select><select id="log-level" aria-label="Lọc mức log"><option value="">Tất cả mức</option><option value="info" ${state.logLevel === 'info' ? 'selected' : ''}>Info</option><option value="error" ${state.logLevel === 'error' ? 'selected' : ''}>Error</option></select></div><p class="hint">200 sự kiện gần nhất của revision ${d.viewed_revision}, mới nhất ở trên. Logs process ở mục Hệ thống.</p><div class="logs">${logs.length ? logs.map((l) => `<article class="log-row ${esc(l.level)}"><div class="log-meta"><span>${esc(fmtDate(l.created_at))}</span><b>${esc(l.step)}</b><span>${esc(l.level)}</span></div><p>${esc(l.message)}</p></article>`).join('') : '<p class="muted">Chưa có logs phù hợp.</p>'}</div>`;
}
function detailView(d, force = false) {
  state.detail = d;
  const signature = JSON.stringify({
    d,
    tab: state.tab,
    logStep: state.logStep,
    logLevel: state.logLevel,
  });
  if (!force && signature === state.signature) return;
  state.signature = signature;
  const oldMedia = [...$('detail').querySelectorAll('video,audio')];
  const oldScroll = $('detail').querySelector('.logs')?.scrollTop || 0;
  const current = d.viewed_revision === d.revision;
  const startedUpload =
    d.uploads.some((u) => u.status !== 'REJECTED') ||
    ['UPLOADING', 'UPLOAD_UNCERTAIN', 'UPLOADED_PRIVATE', 'PUBLISHED'].includes(d.status);
  const canEdit = current && !startedUpload;
  const failed = d.steps.find((s) => s.status === 'FAILED');
  const total = d.costs.reduce((n, c) => n + Number(c.reserved_usd), 0);
  const tabs = {
    pipeline: 'Quy trình',
    content: 'Nội dung',
    preview: 'Preview',
    qc: 'QC',
    logs: 'Logs',
    costs: 'Chi phí & upload',
  };
  const body = {
    pipeline: () => pipelineView(d),
    content: contentView,
    preview: previewView,
    qc: qcView,
    logs: () => logsView(d),
    costs: () => costsView(d),
  }[state.tab]();
  $('detail').innerHTML =
    `<div class="detail-head"><div class="detail-top"><div>${badge(d.status)} <span class="badge">${d.mock ? 'MOCK' : 'LIVE'}</span><h2>${esc(output('metadata')?.title || 'Bản tin AI & Tech')}</h2><p class="detail-id">${esc(d.id)} · ${esc(fmtDate(d.created_at))}</p><p class="hint">Reservation ${money(total)} · ${current ? 'Revision hiện tại' : 'Đang xem revision cũ; thao tác đã khóa'}</p></div><label class="revision-control">Bản sản xuất<select id="revision">${d.revisions.map((r) => `<option value="${r}" ${r === d.viewed_revision ? 'selected' : ''}>Revision ${r}${r === d.revision ? ' · mới nhất' : ''}</option>`).join('')}</select></label></div>${d.error_message ? `<div class="error-box">${esc(d.error_message)}</div>` : ''}<div class="detail-actions">${current && d.status === 'WAITING_APPROVAL' ? '<button class="primary" data-action="publish">✓ Duyệt & upload</button>' : ''}${current && d.status === 'FAILED' && failed ? `<button class="secondary" data-action="retry" data-step="${failed.step}">↻ Retry ${esc(names[failed.step])}</button>` : ''}${canEdit ? '<select id="regen-target" aria-label="Bước tạo lại"><option value="script">Tạo lại từ kịch bản</option><option value="voice">Tạo lại giọng đọc</option><option value="visuals">Tạo lại hình ảnh</option><option value="render">Render lại</option></select><button class="secondary" data-action="regenerate">Tạo lại</button><button class="quiet danger" data-action="skip">Bỏ qua video</button>' : ''}${current && ['UPLOAD_UNCERTAIN', 'FAILED'].includes(d.status) && failed?.step === 'upload' && startedUpload ? '<button class="secondary" data-action="reconcile-upload">Đối soát upload</button>' : ''}</div></div><nav class="tabs" aria-label="Chi tiết video">${Object.entries(
      tabs,
    )
      .map(
        ([k, v]) =>
          `<button class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${v}</button>`,
      )
      .join(
        '',
      )}</nav><div class="tab-body">${body}<details><summary>Dữ liệu bước & kết quả JSON</summary><pre>${esc(JSON.stringify(d.steps, null, 2))}</pre></details></div>`;
  for (const previous of oldMedia) {
    const next = $('detail').querySelector(previous.tagName.toLowerCase());
    if (next && next.getAttribute('src') === previous.getAttribute('src'))
      next.replaceWith(previous);
  }
  if ($('detail').querySelector('.logs')) $('detail').querySelector('.logs').scrollTop = oldScroll;
  for (const b of $('detail').querySelectorAll('[data-action]')) b.disabled = state.busy;
}
async function refresh() {
  if (state.polling) {
    state.refreshAgain = true;
    return;
  }
  if ($('app').hidden || state.busy || $('confirm').open) return;
  state.polling = true;
  try {
    const query = new URLSearchParams({ page: state.page, search: $('search').value });
    if ($('filter').value) query.set('status', $('filter').value);
    const [runs, runtime, schedule] = await Promise.all([
      api('/dashboard/api/runs?' + query),
      api('/dashboard/api/runtime'),
      api('/dashboard/api/schedule'),
    ]);
    scheduleView(schedule);
    runtimeView(runtime);
    listView(runs);
    if (state.id) {
      const selectedId = state.id,
        selectedRevision = state.revision;
      const detail = await api(
        '/dashboard/api/runs/' +
          encodeURIComponent(selectedId) +
          (selectedRevision ? '?revision=' + selectedRevision : ''),
      );
      if (
        state.id === selectedId &&
        state.revision === selectedRevision &&
        !$('app').hidden &&
        !state.busy &&
        !$('confirm').open
      )
        detailView(detail);
      else state.refreshAgain = true;
    }
    if (state.system) {
      const logs = await api('/dashboard/api/runtime/logs');
      $('process-logs').innerHTML = Object.entries(logs)
        .map(
          ([k, v]) =>
            `<article class="process-log"><h3>${esc(k)}</h3><pre>${esc(v)}</pre></article>`,
        )
        .join('');
    }
    $('sync').textContent = '● Đồng bộ ' + new Date().toLocaleTimeString('vi-VN');
    $('sync').className = 'sync ok';
  } catch (error) {
    $('sync').textContent = '● Mất đồng bộ';
    $('sync').className = 'sync danger';
    notice(error.message, true);
  } finally {
    state.polling = false;
    if (state.refreshAgain) {
      state.refreshAgain = false;
      queueMicrotask(refresh);
    }
  }
}
function scheduleView(data) {
  const s = data.settings;
  if (!state.scheduleDirty) {
    $('schedule-enabled').checked = s.enabled;
    $('schedule-time').value = s.time;
    $('schedule-count').value = s.videos_per_day;
    $('schedule-auto').checked = s.auto_publish;
  }
  state.scheduleLoaded = true;
  $('schedule-info').textContent =
    `Timezone: Việt Nam (UTC+7). YouTube: ${data.privacy}. ${data.next_at ? 'Lịch bắt đầu tiếp theo: ' + new Date(data.next_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'Lịch dashboard đang tắt.'} ${data.live_ready ? '' : 'Providers mock/mixed: chưa thể bật tự upload.'} ${data.legacy_enabled ? 'Lịch cron .env cũ đang bật; lưu form này sẽ thay thế lịch cũ.' : ''}`;
  $('schedule-history').innerHTML = data.recent
    .map(
      (b) =>
        `<div class="schedule-history-row"><b>${esc(b.date)} · ${esc(b.settings.time)} UTC+7</b> · Đã tạo ${b.runs.length}/${b.settings.videos_per_day} video ${b.runs.map((r) => `<button type="button" class="quiet" data-scheduled-run="${esc(r.id)}">#${r.sequence} ${esc(labels[r.status] || r.status)} ↗</button>`).join('')}</div>`,
    )
    .join('');
}
$('schedule-form').addEventListener('input', () => {
  state.scheduleDirty = true;
});
$('schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.scheduleLoaded || state.busy) return;
  $('schedule-save').disabled = true;
  try {
    const data = await api('/dashboard/api/schedule', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('schedule-enabled').checked,
        timezone: 'Asia/Ho_Chi_Minh',
        time: $('schedule-time').value,
        videos_per_day: Number($('schedule-count').value),
        auto_publish: $('schedule-auto').checked,
      }),
    });
    state.scheduleDirty = false;
    scheduleView(data);
    notice('Đã lưu lịch UTC+7. Worker áp dụng ngay, không cần restart.');
    await refresh();
  } catch (error) {
    notice(error.message, true);
  } finally {
    $('schedule-save').disabled = false;
  }
});
$('schedule-history').addEventListener('click', (event) => {
  const button = event.target.closest('[data-scheduled-run]');
  if (!button || state.busy) return;
  state.id = button.dataset.scheduledRun;
  state.revision = null;
  state.detail = null;
  state.signature = '';
  refresh();
});
function confirmAction(title, text, video = false) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('video-id-label').hidden = !video;
  $('video-id').value = '';
  $('video-id').required = video;
  $('confirm').returnValue = '';
  $('confirm').showModal();
  return new Promise((resolve) =>
    $('confirm').addEventListener('close', () => resolve($('confirm').returnValue === 'ok'), {
      once: true,
    }),
  );
}
async function act(action, step) {
  if (
    state.busy ||
    !state.detail ||
    state.detail.id !== state.id ||
    state.detail.viewed_revision !== state.detail.revision ||
    (state.revision && state.revision !== state.detail.revision)
  )
    return;
  const id = state.detail.id,
    revision = state.detail.revision,
    target = $('regen-target')?.value;
  const text = {
    publish: `Upload revision ${revision} lên YouTube với privacy ${state.runtime?.privacy}. Hãy xem/nghe preview trước khi duyệt.`,
    skip: 'Dừng và bỏ qua video này. Có thể tạo lại trước khi upload bắt đầu.',
    retry: 'Chạy lại bước lỗi và phục hồi các nhánh đang dở. API live có thể phát sinh thêm phí.',
    regenerate:
      'Tạo revision mới và hủy approval cũ. Các bước phụ thuộc sẽ chạy lại; API live có thể phát sinh thêm phí.',
    'reconcile-upload':
      'Chỉ nhập ID video đúng với revision này sau khi kiểm tra trong YouTube Studio. Backend sẽ kiểm tra quyền sở hữu kênh.',
  };
  if (
    !(await confirmAction(
      {
        publish: 'Duyệt & upload video',
        skip: 'Bỏ qua video',
        retry: 'Chạy lại bước lỗi',
        regenerate: 'Tạo lại video',
        'reconcile-upload': 'Đối soát upload',
      }[action],
      text[action],
      action === 'reconcile-upload',
    ))
  )
    return;
  state.busy = true;
  detailView(state.detail, true);
  try {
    const body = { revision };
    if (action === 'retry') body.step = step;
    if (action === 'regenerate') body.target = target;
    if (action === 'reconcile-upload') body.video_id = $('video-id').value.trim();
    await api(`/pipeline/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.revision = null;
    state.signature = '';
    notice('Đã nhận thao tác. Dashboard sẽ cập nhật tiến độ.');
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.busy = false;
    state.signature = '';
    await refresh();
  }
}
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/dashboard/login', {
      method: 'POST',
      body: JSON.stringify({ token: $('token').value }),
    });
    $('token').value = '';
    $('login').hidden = true;
    $('app').hidden = false;
    await refresh();
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  try {
    await api('/dashboard/logout', { method: 'POST', body: '{}' });
    loginView();
  } catch (error) {
    notice(error.message, true);
  }
});
$('run-list').addEventListener('click', (event) => {
  const card = event.target.closest('[data-run]');
  if (!card || state.busy) return;
  state.id = card.dataset.run;
  state.detail = null;
  $('detail').innerHTML = '<div class="empty"><h2>Đang tải video…</h2></div>';
  state.revision = null;
  state.signature = '';
  refresh();
});
$('detail').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    if (!state.detail) return;
    state.tab = tab.dataset.tab;
    detailView(state.detail, true);
  }
  const action = event.target.closest('[data-action]');
  if (action) act(action.dataset.action, action.dataset.step);
});
$('detail').addEventListener('change', (event) => {
  if (event.target.id === 'revision') {
    state.revision = Number(event.target.value);
    state.signature = '';
    state.detail = null;
    for (const button of $('detail').querySelectorAll('[data-action]')) button.disabled = true;
    refresh();
  }
  if (event.target.id === 'log-step' || event.target.id === 'log-level') {
    state[event.target.id === 'log-step' ? 'logStep' : 'logLevel'] = event.target.value;
    detailView(state.detail, true);
  }
});
$('create').addEventListener('click', async () => {
  if (state.busy) return;
  if (
    !(await confirmAction(
      'Tạo video mới',
      `Tạo một run độc lập, kể cả cùng ngày. OpenAI đang ở chế độ ${state.runtime?.modes.openai}; run live có thể phát sinh phí. Video sẽ chờ duyệt trước khi upload.`,
    ))
  )
    return;
  state.busy = true;
  $('create').disabled = true;
  state.createKey ||= crypto.randomUUID();
  try {
    const run = await api('/dashboard/api/runs', {
      method: 'POST',
      body: JSON.stringify({ request_key: state.createKey }),
    });
    state.createKey = null;
    state.id = run.id;
    state.revision = null;
    state.page = 1;
    $('filter').value = '';
    $('search').value = '';
    notice('Đã tạo yêu cầu video mới.');
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.busy = false;
    $('create').disabled = false;
    await refresh();
  }
});
$('refresh').addEventListener('click', refresh);
$('filter').addEventListener('change', () => {
  state.page = 1;
  refresh();
});
let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.page = 1;
    refresh();
  }, 350);
});
$('prev').addEventListener('click', () => {
  state.page--;
  refresh();
});
$('next').addEventListener('click', () => {
  state.page++;
  refresh();
});
for (const id of ['production-nav', 'system-nav'])
  $(id).addEventListener('click', () => {
    state.system = id === 'system-nav';
    $('production').hidden = state.system;
    $('system').hidden = !state.system;
    $('create').hidden = state.system;
    $(id).classList.add('active');
    $(state.system ? 'production-nav' : 'system-nav').classList.remove('active');
    $('breadcrumb').textContent =
      'Workspace / ' + (state.system ? 'Hệ thống & logs' : 'Sản xuất video');
    refresh();
  });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
(async () => {
  try {
    const session = await api('/dashboard/session');
    if (session.authenticated) {
      $('app').hidden = false;
      await refresh();
    } else loginView();
  } catch (error) {
    loginView();
    $('login-error').textContent = error.message;
  }
})();
setInterval(() => {
  if (!document.hidden) refresh();
}, 3000);
