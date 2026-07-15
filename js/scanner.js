// AIT 카메라 바코드 스캔 (모바일 기본 카메라로 라벨 인식) — 재고조회·생산출고요청 공용
// PDA 하드웨어 스캐너와 별개. getUserMedia + ZXing(js/zxing.min.js)으로 안드로이드/아이폰 모두 지원.
// 사용: const code = await AITScan.scan();  // 성공=문자열, 취소=null, 오류=throw
'use strict';
(function () {
  if (window.AITScan) return;

  // 라벨은 1D 숫자 바코드(일자8+품번5+순번4). 1D 위주 + QR 예비, TRY_HARDER로 인식률↑
  function buildHints() {
    try {
      const Z = window.ZXing, F = Z.BarcodeFormat, H = Z.DecodeHintType;
      const hints = new Map();
      hints.set(H.POSSIBLE_FORMATS, [
        F.CODE_128, F.CODE_39, F.ITF, F.CODABAR, F.EAN_13, F.EAN_8, F.QR_CODE
      ]);
      hints.set(H.TRY_HARDER, true);
      return hints;
    } catch (_) { return null; }
  }

  function injectStyle() {
    if (document.getElementById('aitscan-style')) return;
    const s = document.createElement('style');
    s.id = 'aitscan-style';
    s.textContent = `
      #aitscan-ov{position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column;
        padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
      #aitscan-ov .as-top{display:flex;align-items:center;justify-content:space-between;gap:10px;
        padding:12px 14px;color:#fff;font-weight:800;font-size:16px}
      #aitscan-ov .as-x{min-height:42px;min-width:56px;padding:0 14px;border:1px solid rgba(255,255,255,.5);
        border-radius:9px;background:rgba(255,255,255,.14);color:#fff;font-size:16px;font-weight:800;cursor:pointer}
      #aitscan-ov .as-stage{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;touch-action:none}
      #aitscan-ov video{width:100%;height:100%;object-fit:cover;background:#000}
      #aitscan-ov .as-frame{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
        width:min(82vw,360px);aspect-ratio:1/1;border:3px solid #22c55e;border-radius:16px;
        box-shadow:0 0 0 9999px rgba(0,0,0,.42);pointer-events:none}
      #aitscan-ov .as-focus{position:absolute;width:74px;height:74px;border:2px solid #fde047;border-radius:10px;
        transform:translate(-50%,-50%) scale(1.25);opacity:0;pointer-events:none;transition:transform .18s,opacity .18s}
      #aitscan-ov .as-focus.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
      #aitscan-ov .as-zoom{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);
        display:none;align-items:center;gap:10px;width:min(84vw,420px);
        background:rgba(0,0,0,.42);border-radius:999px;padding:8px 16px}
      #aitscan-ov .as-zoom.show{display:flex}
      #aitscan-ov .as-zoom span{color:#fff;font-size:15px;font-weight:800;min-width:20px;text-align:center}
      #aitscan-ov .as-zoom input{flex:1;accent-color:#22c55e;height:26px}
      #aitscan-ov .as-hint{padding:12px 16px calc(14px + env(safe-area-inset-bottom,0px));color:#e2e8f0;
        text-align:center;font-size:14px;line-height:1.5}
      #aitscan-ov .as-err{color:#fecaca;font-weight:700}
    `;
    document.head.appendChild(s);
  }

  function scan() {
    return new Promise((resolve, reject) => {
      if (!window.isSecureContext) { reject(new Error('HTTPS(보안연결)에서만 카메라를 쓸 수 있습니다')); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { reject(new Error('이 브라우저는 카메라를 지원하지 않습니다')); return; }
      if (!window.ZXing || !window.ZXing.BrowserMultiFormatReader) { reject(new Error('스캐너 로딩 실패(zxing.min.js)')); return; }

      injectStyle();
      const ov = document.createElement('div');
      ov.id = 'aitscan-ov';
      ov.innerHTML = `
        <div class="as-top"><span>📷 라벨을 초록 틀 안에 맞춰주세요</span><button class="as-x" type="button">닫기</button></div>
        <div class="as-stage">
          <video playsinline muted autoplay></video>
          <div class="as-frame"></div>
          <div class="as-focus" id="as-focus"></div>
          <div class="as-zoom" id="as-zoom"><span>➖</span><input type="range" id="as-zoomr"><span>➕</span></div>
        </div>
        <div class="as-hint" id="as-hint">카메라 준비 중… (틀을 탭하면 초점, 두 손가락으로 확대)</div>`;
      document.body.appendChild(ov);

      const stage = ov.querySelector('.as-stage');
      const video = ov.querySelector('video');
      const hintEl = ov.querySelector('#as-hint');
      const focusEl = ov.querySelector('#as-focus');
      const zoomBox = ov.querySelector('#as-zoom');
      const zoomR = ov.querySelector('#as-zoomr');
      const reader = new window.ZXing.BrowserMultiFormatReader(buildHints());
      let done = false, track = null;

      function cleanup() {
        try { reader.reset(); } catch (_) {}
        try { const st = video.srcObject; if (st) st.getTracks().forEach(t => t.stop()); } catch (_) {}
        if (ov.parentNode) ov.parentNode.removeChild(ov);
      }
      function finish(val) { if (done) return; done = true; cleanup(); resolve(val); }
      function fail(e) { if (done) return; done = true; cleanup(); reject(e); }

      ov.querySelector('.as-x').addEventListener('click', () => finish(null));

      // ── 카메라 트랙 확보 후 줌/초점 컨트롤 연결 ──
      function setupControls() {
        try {
          const st = video.srcObject; if (!st) return false;
          track = st.getVideoTracks()[0]; if (!track) return false;
          const caps = track.getCapabilities ? track.getCapabilities() : {};
          // 줌: 지원 시 슬라이더 표시 + 핀치 제스처
          if (caps && caps.zoom && caps.zoom.max > caps.zoom.min) {
            const zmin = caps.zoom.min, zmax = caps.zoom.max, zstep = caps.zoom.step || (zmax - zmin) / 100;
            let zcur = (track.getSettings && track.getSettings().zoom) || zmin;
            zoomR.min = zmin; zoomR.max = zmax; zoomR.step = zstep; zoomR.value = zcur;
            zoomBox.classList.add('show');
            const applyZoom = v => { zcur = Math.min(zmax, Math.max(zmin, v)); zoomR.value = zcur;
              track.applyConstraints({ advanced: [{ zoom: zcur }] }).catch(() => {}); };
            zoomR.addEventListener('input', () => applyZoom(Number(zoomR.value)));
            // 두 손가락 핀치 → 줌
            let pinch0 = 0, zoom0 = zcur;
            stage.addEventListener('touchmove', e => {
              if (e.touches.length !== 2) return;
              e.preventDefault();
              const dx = e.touches[0].clientX - e.touches[1].clientX;
              const dy = e.touches[0].clientY - e.touches[1].clientY;
              const dist = Math.hypot(dx, dy);
              if (!pinch0) { pinch0 = dist; zoom0 = zcur; return; }
              applyZoom(zoom0 + (dist - pinch0) / 120 * (zmax - zmin) / 4);
            }, { passive: false });
            stage.addEventListener('touchend', e => { if (e.touches.length < 2) pinch0 = 0; });
          }
          return true;
        } catch (_) { return false; }
      }
      const ctlTimer = setInterval(() => { if (done || setupControls()) clearInterval(ctlTimer); }, 300);
      setTimeout(() => clearInterval(ctlTimer), 6000);

      // ── 탭 초점: 지원 시 해당 지점으로, 아니면 오토포커스 재시도 ──
      stage.addEventListener('click', ev => {
        const rect = stage.getBoundingClientRect();
        const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        focusEl.style.left = px + 'px'; focusEl.style.top = py + 'px';
        focusEl.classList.remove('on'); void focusEl.offsetWidth; focusEl.classList.add('on');
        setTimeout(() => focusEl.classList.remove('on'), 900);
        if (!track || !track.getCapabilities) return;
        const caps = track.getCapabilities();
        const adv = {};
        if (caps.focusMode) {
          if (caps.focusMode.includes('single-shot')) adv.focusMode = 'single-shot';
          else if (caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
        }
        if (caps.pointsOfInterest) adv.pointsOfInterest = [{ x: px / rect.width, y: py / rect.height }];
        if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(() => {});
      });

      const constraints = { video: { facingMode: { ideal: 'environment' } } };
      reader.decodeFromConstraints(constraints, video, (result, err) => {
        if (done) return;
        if (hintEl.textContent.indexOf('카메라 준비 중') === 0) hintEl.textContent = '바코드를 비추면 자동 인식 · 틀 탭=초점, 핀치=확대';
        if (result) {
          const text = (result.getText() || '').trim();
          if (text) { try { navigator.vibrate && navigator.vibrate(60); } catch (_) {} finish(text); }
        }
        // NotFoundException(프레임에 바코드 없음)은 연속 스캔 정상 상태 → 무시
      }).catch(e => {
        const name = e && e.name || '';
        let msg = '카메라를 열 수 없습니다';
        if (name === 'NotAllowedError' || name === 'SecurityError') msg = '카메라 권한이 거부되었습니다. 설정에서 허용해 주세요';
        else if (name === 'NotFoundError' || name === 'OverconstrainedError') msg = '사용 가능한 카메라가 없습니다';
        else if (e && e.message) msg = e.message;
        hintEl.classList.add('as-err'); hintEl.textContent = msg;
        setTimeout(() => fail(new Error(msg)), 1600);
      });
    });
  }

  window.AITScan = { scan };
})();
