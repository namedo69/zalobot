const $ = id => document.getElementById(id);
let token = '';
let imageUrl = null;
let refreshing = false;
let testEvents = new Map();
const states = {
  logged_out: 'Chưa đăng nhập', creating_qr: 'Đang tạo QR', awaiting_scan: 'Chờ quét QR',
  awaiting_confirmation: 'Chờ xác nhận trên điện thoại', qr_expired_or_declined: 'QR hết hạn hoặc bị từ chối. Hãy tạo QR mới.',
  restoring: 'Đang khôi phục phiên', connecting: 'Đang kết nối', connected: 'Đã kết nối — sẵn sàng gửi tin',
  disconnected: 'Mất kết nối — bấm kết nối lại', connection_error: 'Lỗi kết nối — bấm kết nối lại',
  login_failed: 'Đăng nhập thất bại. Kiểm tra kết nối hoặc xóa phiên và quét lại QR.',
  storage_error: 'Lỗi lưu dữ liệu — kiểm tra disk trên Render', stopped: 'Đã dừng',
  storage_or_identity_error: 'Lỗi lưu phiên hoặc tài khoản khác bot gốc. Chỉ đăng nhập đúng tài khoản bot đã dùng với disk này.',
};
const errors = {
  unauthorized: 'Khóa không hợp lệ hoặc đã bị thu hồi.', device_not_paired: 'Người nhận chưa liên kết Zalo.',
  bot_not_connected: 'Bot chưa kết nối Zalo.', send_busy: 'Bot đang gửi tin khác, vui lòng chờ.',
  delivery_rate_limited: 'Đã đạt giới hạn gửi tin. Vui lòng chờ.',
  send_result_unknown_do_not_retry_with_new_id: 'Chưa xác định tin đã gửi hay chưa. Kiểm tra Zalo, không gửi lại.',
  bot_busy_or_already_logged_in: 'Bot đang đăng nhập hoặc đã có phiên. Xóa phiên trước nếu cần đổi tài khoản.',
  login_in_progress: 'Đang đăng nhập. Hãy chờ QR hết hạn hoặc hoàn tất.',
  invalid_request: 'Dữ liệu chưa hợp lệ. Tên chỉ gồm chữ, số, khoảng trắng, . _ ( ) -',
};
async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/admin-api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit',
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(errors[result.error] || `Yêu cầu thất bại (${response.status}).`);
  }
  return response;
}
function clearQR() {
  $('qr').hidden = true;
  $('qr').removeAttribute('src');
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const result = await (await request('/status')).json();
    $('panel').hidden = false;
    $('login').hidden = true;
    $('state').textContent = states[result.bot.state];
    if (result.bot.state === 'awaiting_scan') {
      const response = await request('/qr');
      clearQR();
      imageUrl = URL.createObjectURL(await response.blob());
      $('qr').src = imageUrl;
      $('qr').hidden = false;
    } else clearQR();
    $('devices').replaceChildren();
    for (const device of result.devices) {
      const row = document.createElement('div');
      row.className = 'device';
      const label = document.createElement('p');
      label.textContent = `${device.name} — ${device.revoked ? 'Đã thu hồi' : device.linked ? 'Đã liên kết' : device.code_expires <= Date.now() ? 'Mã đã hết hạn' : 'Chờ người nhận nhắn mã cho bot'}`;
      row.append(label);
      if (!device.revoked) {
        const send = document.createElement('button');
        send.textContent = 'Gửi tin thử';
        send.disabled = !device.linked || !result.bot.ready;
        send.onclick = () => action(async () => {
          // Reuse the same event after an ambiguous response; never create automatic duplicate sends.
          if (!testEvents.has(device.id)) testEvents.set(device.id, crypto.randomUUID());
          const result = await (await request(`/devices/${device.id}/test`, { method: 'POST', body: { eventId: testEvents.get(device.id) } })).json();
          $('message').textContent = result.duplicate ? 'Tin thử này đã được gửi trước đó.' : 'Zalo đã nhận yêu cầu gửi. Hãy kiểm tra điện thoại người nhận.';
        });
        const revoke = document.createElement('button');
        revoke.textContent = 'Thu hồi quyền';
        revoke.onclick = () => {
          if (confirm(`Thu hồi quyền gửi của ${device.name}?`)) action(async () => {
            await request(`/devices/${device.id}`, { method: 'DELETE' });
            $('message').textContent = 'Đã thu hồi quyền.';
            await refresh();
          });
        };
        row.append(send, revoke);
      }
      $('devices').append(row);
    }
  } finally { refreshing = false; }
}
async function action(run) {
  try { await run(); }
  catch (error) { $('message').textContent = error.message; }
}
$('login').onsubmit = event => {
  event.preventDefault();
  token = $('token').value.trim();
  $('token').value = '';
  $('message').textContent = '';
  action(refresh);
};
$('refresh').onclick = () => action(refresh);
for (const [id, path] of [['qr-start', '/bot/qr'], ['reconnect', '/bot/reconnect'], ['logout', '/bot/logout']]) {
  $(id).onclick = () => {
    if (id === 'logout' && !confirm('Xóa phiên bot trên server? Cần quét QR để đăng nhập lại.')) return;
    action(async () => { await request(path, { method: 'POST', body: {} }); await refresh(); });
  };
}
$('invite').onsubmit = event => {
  event.preventDefault();
  action(async () => {
    const invite = await (await request('/devices', { method: 'POST', body: { name: $('name').value } })).json();
    $('invite-result').textContent = `Gửi riêng cho ${invite.name}:\n\nNhắn trực tiếp cho tài khoản bot: OBEE ${invite.code}\n\nURL dịch vụ: ${location.origin}\nKhóa thiết bị (chỉ hiện một lần): ${invite.token}\n\nGiữ khóa thiết bị để cấu hình EXE sau. Không chia sẻ khóa quản trị hoặc phiên Zalo.`;
    $('invite-result').hidden = false;
    await refresh();
  });
};
$('lock').onclick = () => {
  token = '';
  testEvents.clear();
  clearQR();
  $('panel').hidden = true;
  $('login').hidden = false;
  $('devices').replaceChildren();
  $('invite-result').textContent = '';
  $('invite-result').hidden = true;
  $('message').textContent = 'Đã khóa trang.';
  // Tear down in-flight requests/closures too; no keys are kept across navigation.
  location.reload();
};
setInterval(() => { if (token && !document.hidden) action(refresh); }, 5000);
