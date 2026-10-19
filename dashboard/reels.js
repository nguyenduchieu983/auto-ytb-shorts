(() => {
  let page = 1,
    selected = null,
    dirty = false,
    loaded = false,
    busy = false,
    polling = false,
    signature = '',
    detail = null,
    requestKey = null;
  const el = (id) => document.getElementById(id);
  const html = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const status = {
    PENDING: 'Đang chờ',
    RUNNING: 'Đang tạo',
    READY: 'Sẵn sàng đăng',
    FAILED: 'Lỗi',
  };
  const steps = {
    content: 'Viết nội dung',
    voice: 'Giọng & hình',
    render: 'Dựng video',
    complete: 'Hoàn tất',
  };
  const asset = (id, kind, download = false) =>
    `/dashboard/api/reels/${encodeURIComponent(id)}/assets/${kind}${download ? '?download=1' : ''}`;
  async function call(path, body) {
    const response = await fetch('/dashboard/api/reels' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function note(message, error = false) {
    el('notice').hidden = false;
    el('notice').textContent = message;
    el('notice').className = 'notice' + (error ? '' : ' success');
  }
  async function refresh() {
    if (polling || busy || document.hidden || el('app').hidden || el('reels').hidden) return;
    polling = true;
    try {
      const data = await call('?page=' + page);
      loaded = true;
      if (!dirty) {
        el('reels-enabled').checked = data.settings.enabled;
        el('reels-time').value = data.settings.time;
        el('reels-count').value = data.settings.videos_per_day;
      }
      el('reels-info').textContent =
        `${data.settings.enabled ? 'Lịch đang bật' : 'Lịch đang tắt'} · ${data.settings.videos_per_day} video/ngày · ${data.settings.time} UTC+7${data.next_at ? ' · Lần tới: ' + new Date(data.next_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : ''}${data.ready ? '' : ' · Chưa sẵn sàng: cần Codex live và Edge TTS'}`;
      el('reels-now').disabled = !data.ready;
      el('reels-list').innerHTML =
        data.items
          .map(
            (j) =>
              `<button class="run-card ${selected === j.id ? 'selected' : ''}" data-reel="${html(j.id)}"><strong>${html(j.content?.title.join(' ') || 'Video triết lý #' + j.sequence)}</strong><p>${html(j.run_date)} · ${j.origin === 'scheduled' ? 'Theo lịch' : 'Thủ công'} · #${j.sequence}</p><span class="badge ${j.status === 'READY' ? 'SUCCEEDED' : j.status}">${html(status[j.status])}</span> <small>${html(steps[j.step] || j.step)}</small></button>`,
          )
          .join('') || '<p class="muted">Chưa có video. Lưu lịch hoặc tạo batch ngay.</p>';
      el('reels-page').textContent = `${page} / ${Math.max(1, data.pages)} · ${data.total} video`;
      el('reels-prev').disabled = page <= 1;
      el('reels-next').disabled = page >= data.pages;
      if (!selected && data.items.length) selected = data.items[0].id;
      if (selected) {
        detail = await call('/' + selected);
        const key = JSON.stringify(detail);
        if (key !== signature) {
          signature = key;
          draw(detail);
        }
      }
    } catch (e) {
      note(e.message, true);
    } finally {
      polling = false;
    }
  }
  function draw(j) {
    const c = j.content;
    el('reels-detail').innerHTML =
      `<div class="panel-title"><h2>${html(c?.title.join(' ') || 'Đang chuẩn bị nội dung')}</h2><span>${html(status[j.status])}</span></div>
      <p class="hint">Bước: ${html(steps[j.step] || j.step)} · Lượt chạy ${j.attempts} · ${j.id}</p>
      <div class="reels-steps">${['content', 'voice', 'render', 'complete'].map((s) => `<span class="badge ${j.step === s ? 'RUNNING' : ''}">${html(steps[s])}</span>`).join(' → ')}</div>
      ${j.error_message ? `<p class="notice">${html(j.error_message)}</p><button class="primary" data-reel-retry>Thử lại</button>` : ''}
      ${j.status === 'READY' ? `<video class="reels-video" controls preload="metadata" poster="${asset(j.id, 'thumbnail')}" src="${asset(j.id, 'video')}"></video><div class="actions"><a class="primary" href="${asset(j.id, 'video', true)}">Tải MP4</a> <a href="${asset(j.id, 'post', true)}">Tải nội dung .txt</a> · <a href="${asset(j.id, 'json', true)}">JSON</a></div><p class="hint">${Number(j.output.duration).toFixed(1)} giây · QC đạt · Chưa đăng Facebook/YouTube</p>` : ''}
      ${c ? `<h3>Nội dung đăng Facebook</h3><label>Caption</label><p>${html(c.caption)}</p><label>Mô tả</label><p>${html(c.description)}</p><label>Hashtag</label><p>${html(c.hashtags.join(' '))}</p><button class="quiet" data-reel-copy>Copy toàn bộ nội dung đăng</button><textarea id="reels-post-text" rows="8" readonly>${html(j.posting_text)}</textarea><details><summary>Lời đọc & nguồn</summary><p>${html(c.scenes.map((s) => s.narration).join(' '))}</p><p>${html(c.source_note)}</p><a href="${html(c.source)}" target="_blank" rel="noreferrer">Nguồn tham khảo ↗</a></details>` : ''}
      <h3>Logs</h3><pre class="reels-log">${html(j.logs.map((l) => new Date(l.created_at).toLocaleTimeString('vi-VN') + ' ' + l.message).join('\n') || 'Đang chờ worker...')}</pre>`;
  }
  el('reels-form').addEventListener('input', () => {
    dirty = true;
  });
  el('reels-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !loaded) return;
    busy = true;
    el('reels-save').disabled = true;
    try {
      await call('/settings', {
        enabled: el('reels-enabled').checked,
        timezone: 'Asia/Ho_Chi_Minh',
        time: el('reels-time').value,
        videos_per_day: Number(el('reels-count').value),
      });
      dirty = false;
      note('Đã lưu lịch Reels. Giờ/số lượng áp dụng cho batch chưa tạo.');
    } catch (e) {
      note(e.message, true);
    } finally {
      busy = false;
      el('reels-save').disabled = false;
      refresh();
    }
  });
  el('reels-now').addEventListener('click', async () => {
    if (busy || !loaded) return;
    if (dirty) {
      note('Lưu cấu hình trước để tạo đúng số lượng mày chọn.', true);
      return;
    }
    busy = true;
    el('reels-now').disabled = true;
    requestKey ||= crypto.randomUUID();
    try {
      const jobs = await call('/batch', { request_key: requestKey });
      requestKey = null;
      page = 1;
      selected = jobs[0]?.id;
      signature = '';
      note('Đã xếp hàng batch Reels thủ công. Không đăng lên mạng xã hội.');
    } catch (e) {
      note(e.message, true);
    } finally {
      busy = false;
      refresh();
    }
  });
  el('reels-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-reel]');
    if (b) {
      selected = b.dataset.reel;
      signature = '';
      refresh();
    }
  });
  el('reels-detail').addEventListener('click', async (e) => {
    if (e.target.closest('[data-reel-copy]')) {
      try {
        await navigator.clipboard.writeText(detail.posting_text);
        note('Đã copy caption + mô tả + hashtag.');
      } catch {
        el('reels-post-text').select();
        note('Đã chọn nội dung. Nhấn Ctrl+C để copy.');
      }
    }
    if (e.target.closest('[data-reel-retry]') && !busy) {
      busy = true;
      try {
        await call('/' + selected + '/retry', {});
        signature = '';
        note('Đã yêu cầu retry. Nếu lịch đang tắt, bật lại để chạy video theo lịch còn chờ.');
      } catch (e) {
        note(e.message, true);
      } finally {
        busy = false;
        refresh();
      }
    }
  });
  el('reels-prev').addEventListener('click', () => {
    page--;
    refresh();
  });
  el('reels-next').addEventListener('click', () => {
    page++;
    refresh();
  });
  window.refreshReels = refresh;
  setInterval(refresh, 3000);
})();
