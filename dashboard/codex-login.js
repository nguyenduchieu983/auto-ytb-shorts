(() => {
  const el = (id) => document.getElementById(id);
  let busy = false,
    waiting = false,
    polling = false;
  function draw(data) {
    waiting = data.status === 'waiting' || data.status === 'starting';
    el('codex-login-status').textContent =
      data.message || 'Bấm đăng nhập lại để mở link mới, hoặc kiểm tra phiên hiện tại.';
    el('codex-login-cancel').hidden = !waiting;
    el('codex-login-check').disabled = busy || waiting;
    el('codex-login-start').disabled = busy;
    const link = el('codex-login-link');
    link.hidden = !data.auth_url;
    link.removeAttribute('href');
    if (data.auth_url) {
      const url = new URL(data.auth_url);
      if (
        url.protocol !== 'https:' ||
        !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('Link đăng nhập không hợp lệ');
      link.href = url.href;
    }
  }
  async function request(action) {
    const response = await fetch('/dashboard/api/codex/login' + (action ? '/' + action : ''), {
      method: action ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(action ? { body: '{}' } : {}),
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không kết nối được chức năng đăng nhập');
    draw(data);
    return data;
  }
  el('codex-login-start').addEventListener('click', async () => {
    if (busy) return;
    // Open synchronously in the click handler so browsers allow the new tab.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    busy = true;
    el('codex-login-start').disabled = true;
    el('codex-login-status').textContent = 'Đang tạo link đăng nhập Codex…';
    try {
      const data = await request('start');
      if (data.auth_url && tab) tab.location.replace(el('codex-login-link').href);
      else {
        tab?.close();
        if (data.auth_url)
          el('codex-login-status').textContent =
            'Trình duyệt chặn tab mới. Bấm “Mở lại trang đăng nhập” bên cạnh.';
      }
    } catch (e) {
      tab?.close();
      el('codex-login-status').textContent = e.message;
    } finally {
      busy = false;
      el('codex-login-start').disabled = false;
      el('codex-login-check').disabled = waiting;
    }
  });
  for (const action of ['check', 'cancel'])
    el('codex-login-' + action).addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      el('codex-login-check').disabled = true;
      el('codex-login-status').textContent =
        action === 'check' ? 'Đang kiểm tra đăng nhập…' : 'Đang hủy phiên…';
      try {
        await request(action);
      } catch (e) {
        el('codex-login-status').textContent = e.message;
      } finally {
        busy = false;
        el('codex-login-check').disabled = waiting;
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
