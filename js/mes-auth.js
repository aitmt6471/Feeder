/* ══════════════════════════════════════════════════════════════
   MES_AUTH — shipping.html / material-move.html 공유 MES 로그인 게이트
   PDA_LOGIN(사번/비번 SHA2_256) 인증. 로그인 전 화면 전체 차단.
   사용:  <script src="js/api.js"></script><script src="js/mes-auth.js"></script>
          MES_AUTH.ready(user => { ...인증 후 초기화... });
          MES_AUTH.emp / MES_AUTH.user / MES_AUTH.logout()
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const KEY = 'mes_user';
  let user = null;
  try { user = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
  const readyCbs = []; let fired = false;
  function fireReady() { if (fired) return; fired = true; readyCbs.forEach(cb => { try { cb(user); } catch (_) {} }); }

  const css = `
  #mesauth{position:fixed;inset:0;z-index:9000;background:linear-gradient(180deg,#274680,#1e3264);
    display:none;align-items:center;justify-content:center;padding:20px;
    font-family:'Malgun Gothic','맑은 고딕',-apple-system,system-ui,sans-serif}
  #mesauth.open{display:flex}
  #mesauth .lg{background:#fff;border-radius:16px;width:100%;max-width:340px;padding:26px 22px;box-shadow:0 24px 64px rgba(0,0,0,.4)}
  #mesauth h2{margin:0 0 4px;font-size:21px;color:#1e3264;text-align:center}
  #mesauth p{margin:0 0 18px;font-size:13px;color:#94a3b8;text-align:center}
  #mesauth input{width:100%;font-size:17px;padding:13px;border:1.5px solid #cbd5e1;border-radius:10px;margin-bottom:10px;min-height:50px;box-sizing:border-box}
  #mesauth button{width:100%;min-height:52px;background:#1e3264;color:#fff;border:none;border-radius:10px;font-size:17px;font-weight:800;cursor:pointer;margin-top:6px}
  #mesauth .err{color:#b91c1c;font-size:13px;text-align:center;min-height:18px;margin-top:8px}
  .mes-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.18);color:#fff;
    padding:5px 10px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap;cursor:pointer}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const ov = document.createElement('div');
  ov.id = 'mesauth';
  ov.innerHTML = `<div class="lg">
    <h2>MES 로그인</h2><p>사번·비밀번호로 로그인하세요</p>
    <input id="mes-emp" placeholder="사번" autocomplete="username" inputmode="text">
    <input id="mes-pwd" type="password" placeholder="비밀번호" autocomplete="current-password">
    <button id="mes-go">로그인</button>
    <div class="err" id="mes-err"></div>
  </div>`;

  function show() { ov.classList.add('open'); const e = document.getElementById('mes-emp'); if (e) setTimeout(() => e.focus(), 50); }
  function hide() { ov.classList.remove('open'); }

  async function doLogin() {
    const emp = document.getElementById('mes-emp').value.trim();
    const pwd = document.getElementById('mes-pwd').value;
    const err = document.getElementById('mes-err');
    if (!emp || !pwd) { err.textContent = '사번/비밀번호를 입력하세요'; return; }
    err.textContent = '확인 중...';
    try {
      const r = await AIT_API.pdaLogin(emp, pwd);
      if (r && r.ok) {
        user = { emp: r.emp, name: r.name || r.emp };
        localStorage.setItem(KEY, JSON.stringify(user));
        document.getElementById('mes-pwd').value = '';
        err.textContent = ''; hide(); fireReady();
      } else { err.textContent = '사번 또는 비밀번호가 올바르지 않습니다'; }
    } catch (e) { err.textContent = '로그인 오류: ' + (e.message || e); }
  }

  function logout() {
    user = null; localStorage.removeItem(KEY);
    location.reload();
  }

  function init() {
    document.body.appendChild(ov);
    document.getElementById('mes-go').addEventListener('click', doLogin);
    document.getElementById('mes-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    if (user && user.emp) { hide(); fireReady(); } else { show(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.MES_AUTH = {
    get user() { return user; },
    get emp() { return user && user.emp; },
    get name() { return user && user.name; },
    ready(cb) { if (fired) cb(user); else readyCbs.push(cb); },
    logout,
    // 헤더에 넣을 사용자 칩 HTML (onclick=로그아웃 확인)
    chipHtml() { return user ? `<span class="mes-chip" onclick="if(confirm('로그아웃하시겠습니까?'))MES_AUTH.logout()">👤 ${user.name || user.emp}</span>` : ''; }
  };
})();
