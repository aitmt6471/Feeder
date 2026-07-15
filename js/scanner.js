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
      #aitscan-ov .as-stage{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
      #aitscan-ov video{width:100%;height:100%;object-fit:cover;background:#000}
      #aitscan-ov .as-frame{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
        width:78%;max-width:420px;aspect-ratio:5/2;border:3px solid #22c55e;border-radius:14px;
        box-shadow:0 0 0 9999px rgba(0,0,0,.42);pointer-events:none}
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
        <div class="as-stage"><video playsinline muted autoplay></video><div class="as-frame"></div></div>
        <div class="as-hint" id="as-hint">카메라 준비 중…</div>`;
      document.body.appendChild(ov);

      const video = ov.querySelector('video');
      const hintEl = ov.querySelector('#as-hint');
      const reader = new window.ZXing.BrowserMultiFormatReader(buildHints());
      let done = false;

      function cleanup() {
        try { reader.reset(); } catch (_) {}
        try { const st = video.srcObject; if (st) st.getTracks().forEach(t => t.stop()); } catch (_) {}
        if (ov.parentNode) ov.parentNode.removeChild(ov);
      }
      function finish(val) { if (done) return; done = true; cleanup(); resolve(val); }
      function fail(e) { if (done) return; done = true; cleanup(); reject(e); }

      ov.querySelector('.as-x').addEventListener('click', () => finish(null));

      const constraints = { video: { facingMode: { ideal: 'environment' } } };
      reader.decodeFromConstraints(constraints, video, (result, err) => {
        if (done) return;
        if (hintEl.textContent === '카메라 준비 중…') hintEl.textContent = '바코드를 비추면 자동 인식됩니다';
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
