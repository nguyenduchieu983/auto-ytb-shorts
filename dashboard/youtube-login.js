(() => {
  const el = (id) => document.getElementById(id);
  let busy = false,
    active = false,
    polling = false;
  function draw(data) {
    active = ['starting', 'waiting', 'verifying', 'confirm', 'applying'].includes(data.status);
    el('youtube-login-status').textContent =
      data.message || 'Bấm kết nối lại để lấy quyền upload, hoặc kiểm tra token hiện tại.';
    el('youtube-login-channel').textContent = data.channel
      ? `Kênh: ${data.channel.title} · ${data.channel.id}`
      : '';
    el('youtube-login-apply').hidden = data.status !== 'confirm';
    el('youtube-login-cancel').hidden = !active;
    el('youtube-login-start').disabled = busy || data.status === 'applying';
    el('youtube-login-check').disabled = busy || active;
    el('youtube-login-apply').disabled = busy;
    el('youtube-login-cancel').disabled = busy || data.status === 'applying';
    const link = el('youtube-login-link');
    link.removeAttribute('href');
    link.hidden = !data.auth_url;
    if (data.auth_url) {
      const url = new URL(data.auth_url);
      if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
        throw new Error('Link Google không hợp lệ');
      link.href = url.href;
    }
  }
  async function request(action) {
    const r = await fetch('/dashboard/api/youtube/login' + (action ? '/' + action : ''), {
      method: action ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(action ? { body: '{}' } : {}),
      cache: 'no-store',
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Không kết nối được OAuth YouTube');
    draw(data);
    return data;
  }
  el('youtube-login-start').addEventListener('click', async () => {
    if (busy) return;
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    busy = true;
    el('youtube-login-start').disabled = true;
    el('youtube-login-status').textContent = 'Đang tạo link cấp quyền Google…';
    try {
      const data = await request('start');
      if (data.auth_url && tab) tab.location.replace(el('youtube-login-link').href);
      else {
        tab?.close();
        if (data.auth_url)
          el('youtube-login-status').textContent = 'Popup bị chặn. Bấm Mở lại trang Google.';
      }
    } catch (e) {
      tab?.close();
      el('youtube-login-status').textContent = e.message;
    } finally {
      busy = false;
      el('youtube-login-start').disabled = false;
    }
  });
  for (const action of ['check', 'cancel', 'apply'])
    el('youtube-login-' + action).addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      el('youtube-login-' + action).disabled = true;
      try {
        await request(action);
      } catch (e) {
        el('youtube-login-status').textContent = e.message;
      } finally {
        busy = false;
        el('youtube-login-' + action).disabled = false;
      }
    });
  async function poll() {
    if (busy || polling || document.hidden || el('app').hidden) return;
    polling = true;
    try {
      await request();
    } catch {
    } finally {
      polling = false;
    }
  }
  setInterval(poll, 2000);
})();
