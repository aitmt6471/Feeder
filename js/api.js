/* ══════════════════════════════════════════════════════════════
   AIT_API — 공정문서 DB 연동 추상화 레이어
   MOCK = true  → localStorage 사용
   MOCK = false → n8n 웹훅 호출 (https://aitechn8n.ngrok.app)
   ══════════════════════════════════════════════════════════════ */
const AIT_API = (() => {

  const N8N = 'https://aitechn8n.ngrok.app/webhook';
  const MOCK = false; // n8n 워크플로우 연동

  /* ────────────────────────────────────────────────
     공통 fetch 헬퍼
  ──────────────────────────────────────────────── */
  function _authHeaders() {
    const t = localStorage.getItem('ait_token');
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }
  let _authRedirecting = false;
  function _onAuthFail() {
    if (_authRedirecting) return;
    _authRedirecting = true;
    localStorage.removeItem('ait_token');
    localStorage.removeItem('ait_token_exp');
    localStorage.removeItem('ait_user');
    alert('세션이 만료되었습니다. 다시 로그인해주세요.');
    window.location.replace('login.html');
  }
  function _fetchT(url, options = {}, ms = 10000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms);
    const opts = { ...options, headers: { ...(options.headers || {}), ..._authHeaders() }, signal: ctrl.signal };
    return fetch(url, opts).then(r => {
      if (r.status === 401 || r.status === 403) { _onAuthFail(); throw new Error('세션 만료 (' + r.status + ')'); }
      return r;
    }).finally(() => clearTimeout(id));
  }
  async function _get(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const r  = await _fetchT(`${N8N}/${path}${qs ? '?' + qs : ''}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : [];
  }
  async function _jsonOrOk(r, method, path) {
    if (!r.ok) throw new Error(`${method} ${path} ${r.status}`);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : { ok: true };
  }
  async function _post(path, body, ms = 10000) {
    const r = await _fetchT(`${N8N}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, ms);
    return _jsonOrOk(r, 'POST', path);
  }
  async function _put(path, body, ms = 10000) {
    const r = await _fetchT(`${N8N}/${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, ms);
    return _jsonOrOk(r, 'PUT', path);
  }
  async function _del(path, body) {
    const r = await _fetchT(`${N8N}/${path}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return _jsonOrOk(r, 'DELETE', path);
  }

  /* ────────────────────────────────────────────────
     n8n 웹훅 구현
     ※ 각 path 마다 n8n 워크플로우 1개 필요
        Webhook 트리거 경로 = ait/{domain}/{action}
  ──────────────────────────────────────────────── */
  const _real = {

    /* ── 차종 ─────────────────────────────────── */
    getCars:          ()        => _get('ait/cars'),
    createCar:        (data)    => _post('ait/cars', data),
    updateCar:        (id, data)=> _put('ait/cars',  { id, ...data }),

    /* ── 개정이력 ──────────────────────────────── */
    getRevisions:     (carId, docType) => _get('ait/revisions', { carId, docType }),
    addRevision:      (carId, docType, data) => _post('ait/revisions', { carId, docType, ...data }),
    signRevision:     (carId, docType, rev, role, name, base64, filename) => _post('ait/revisions/sign', { carId, docType, rev, role, name, base64, filename }, 30000).then(r => Array.isArray(r) ? r[0] : r),
    getRevisionSigns: (carId, docType) => _get('ait/revisions/signs', { carId, docType }),
    deleteSign:       (carId, docType, rev, role) => _post('ait/sign/del', { carId, docType, rev, role }),
    deleteRevision:   (id) => _post('ait/revisions/del', { id }),
    uploadSignSimple: (docType, base64, filename) => _post('ait/sign/upload', { docType, base64, filename }, 30000).then(r => Array.isArray(r) ? r[0] : r),
    deleteSignFile:   (fileId) => _post('ait/sign/delete-file', { fileId }),

    /* ── CP ────────────────────────────────────── */
    getCpRows:        (carId)   => _get('ait/cp/rows', { carId }),
    createCpRow:      (carId, data) => _post('ait/cp/rows', { carId, ...data }),
    updateCpRow:      (id, data)=> _put('ait/cp/rows',  { id, ...data }, 30000),
    deleteCpRow:      (id)      => _del('ait/cp/rows',  { id }),
    updateCpOrder:    (carId, items) => _put('ait/cp/order', { carId, items }),

    /* ── 설비일상 ──────────────────────────────── */
    getDailyEquipments: (carId) => _get('ait/daily/equipments', { carId }),
    createDailyEquip:   (carId, data) => _post('ait/daily/equipments', { carId, ...data }),
    updateDailyEquip:   (id, data) => _put('ait/daily/equipments', { id, ...data }),
    syncDailyEquip:     (carId, equipments) => _post('ait/daily/sync', { carId, equipments }),
    getDailyResults:    (equipId, date) => _get('ait/daily/results', { equipId, date }),
    getDailyMonthStatus:(equipId, yearMonth) => _get('ait/daily/month-status', { equipId, yearMonth }),
    getDailyMonthResults:(equipId, yearMonth) => _get('ait/daily/month-results', { equipId, yearMonth }),
    getMsMonthStatus:   (sampleId, yearMonth) => _get('ait/ms/month-status', { sampleId, yearMonth }),
    saveDailyResults:   (payload) => _post('ait/daily/results', payload),
    // payload = { equip_id, check_date, worker, results:[{item_id,result,remark}] }
    validateDailyResults: (equip_id, check_date, results) => _post('ait/daily/validate', { equip_id, check_date, results }),

    /* ── 초중종물 ──────────────────────────────── */
    getImfSheets:     (carId)   => _get('ait/imf/sheets', { carId }),
    createImfSheet:   (carId, data) => _post('ait/imf/sheets', { carId, ...data }),
    updateImfSheet:   (id, data)=> _put('ait/imf/sheets',  { id, ...data }),
    deleteImfSheet:   (id)      => _del('ait/imf/sheets',  { id }),
    getImfResults:    (sheetId, date) => _get('ait/imf/results', { sheetId, date }),
    saveImfResults:   (payload) => _post('ait/imf/results', payload),
    // payload = { sheet_id, check_date, worker, results:[{item_id,phase,check_time,result,remark}] }

    /* ── 마스터샘플 ────────────────────────────── */
    getMsSamples:     (carId)   => _get('ait/ms/samples', { carId }),
    getMsItems:       (carId)   => _get('ait/ms/items', { carId }),
    createMsSample:   (carId, data) => _post('ait/ms/samples', { carId, ...data }),
    updateMsSample:   (id, data)=> _put('ait/ms/samples',  { id, ...data }),
    deleteMsSample:   (id)      => _del('ait/ms/samples',  { id }),
    getMsResults:     (sampleId, date) => _get('ait/ms/results', { sampleId, date }),
    saveMsResults:    (payload) => _post('ait/ms/results', payload),
    // payload = { sample_id, check_date, worker, results:[{item_id,result,remark}] }

    /* ── 사양표 ──────────────────────────────────── */
    getSpecCatalog:   ()                         => _get('ait/spec/catalog'),
    getSpecMes:       (date, carModel, lineName) => _get('ait/spec/mes', { date, carModel, lineName }),
    getSpecMaster:    (carModel)       => _get('ait/spec/master', carModel ? { carModel } : {}),
    createSpecMaster: (data)           => _post('ait/spec/master', data),
    updateSpecMaster: (id, data)       => _put('ait/spec/master', { id, ...data }),
    deleteSpecMaster: (id)             => _del('ait/spec/master', { id }),
    getSpecBom:            (partNo)              => _get('ait/spec/bom', { partNo }),
    deleteSpecBomRow:      (partNo, subPartNo)   => _post('ait/spec/bom/delete', { partNo, subPartNo }),
    getSpecBomParents:     (subPartNo)           => _get('ait/spec/bom/lookup', { subPartNo }),
    getSpecBomSuggest:     (q)                   => _get('ait/spec/bom/suggest', { q }),
    getSpecLineProducts:   (lineName, fromDate) => _get('ait/spec/line-products', { lineName, fromDate }),
    getSpecItemNames:      ()                   => _get('ait/spec/item-names'),
    getSpecDriveIndex:     ()                   => _get('ait/spec/drive-index'),
    getSpecPhotos:    (cdItem)         => _get('ait/spec/photos', { cdItem }),
    uploadSpecPhoto:  (data)           => _post('ait/spec/photos', data, 30000).then(r => Array.isArray(r) ? r[0] : r),
    deleteSpecPhoto:  (data)           => _del('ait/spec/photos', data),

    /* ── 출고요청 ──────────────────────────────── */
    createShipRequest:     (payload)                => _post('ait/spec/ship-request', payload, 30000),
    createShipRequestPart: (payload)                => _post('ait/spec/ship-request/part', payload, 30000),
    getShipRequests:       (lineName, date, status) => _get('ait/spec/ship-requests', status ? { lineName, date, status } : { lineName, date }),
    updateShipRequestItem: (item_id, status)        => _post('ait/spec/ship-request/item-status', { item_id, status }),
    shipItemCheck:         (item_id, emp, on)        => _post('ait/spec/ship-request/item-check', { item_id, emp, on }),
    shipItemDone:          (item_id, emp)            => _post('ait/spec/ship-request/item-done', { item_id, emp }),
    cancelShipRequest:     (request_id)             => _del('ait/spec/ship-request/cancel', { request_id }),
    deleteShipRequestItem: (item_id, request_id)    => _del('ait/spec/ship-request/item', { item_id, request_id }),
    getShipLines:          ()                       => _get('ait/spec/ship-lines'),
    getPartLocations:      (parts)                  => _get('ait/spec/part-locations', { parts: (parts || []).join(',') }),
    savePushSubscription:  (data)                   => _post('ait/spec/push-subscribe', data),

    /* ── 창고이동(자재→생산) PDA ─────────────── */
    pdaLogin:              (emp, pwd)               => _post('ait/spec/pda-login', { emp, pwd }),
    lineWarehouse:         (line)                  => _get('ait/spec/line-warehouse', { line }),
    labelInfo:             (label, wh)             => _get('ait/spec/label-info', wh ? { label, wh } : { label }),
    // payload = { out_wh:'00025', in_wh, emp, boxes:[{sysitem,label,lot,qty}] }
    stockMove:             (payload)               => _post('ait/spec/stock-move', payload, 30000),

    /* ── 작업표준서 ────────────────────────────── */
    getWsProcesses:   (carId)   => _get('ait/ws/processes', { carId }),
    getWsSteps:       (carId)   => _get('ait/ws/steps', { carId }),
    syncWsSteps:      (carId, steps) => _post('ait/ws/steps/sync', { carId, steps }),
    getWsMeta:        (carId)   => _get('ait/ws/meta', { carId }),
    saveWsMeta:       (carId, safetyHtml) => _post('ait/ws/meta', { carId, safetyHtml }),
    createWsProcess:  (carId, data) => _post('ait/ws/processes', { carId, ...data }),
    updateWsProcess:  (id, data)=> _put('ait/ws/processes',  { id, ...data }),
    deleteWsProcess:  (id)      => _del('ait/ws/processes',  { id }),
    swapWsProcNos:    (carId, swaps) => _post('ait/ws/proc-no-swap', { carId, swaps }),

    /* ── CP 메타 ──────────────────────────────── */
    getCpMeta:    (carId)       => _get('ait/cp/meta', { carId }),
    saveCpMeta:   (carId, data) => _post('ait/cp/meta', { carId, ...data }),

    /* ── WS 관리항목 ───────────────────────────── */
    getWsMgmt:    (carId)       => _get('ait/ws/mgmt', { carId }),
    syncWsMgmt:   (carId, items)=> _post('ait/ws/mgmt/sync', { carId, items }),

    /* ── 사진 (Google Drive) ──────────────────── */
    // body: { car, proc, step, filename, base64 }  → { fileId, url }
    uploadWsPhoto:    (data)    => _post('ait/ws/photos',    data, 30000).then(r => Array.isArray(r) ? r[0] : r),
    deleteWsPhoto:    (fileId)  => _del('ait/ws/photos',     { fileId }),
    getWsPhotos:      ()        => _get('ait/ws/photos'),
    // body: { car, equip, filename, base64 }       → { fileId, url }
    uploadDailyPhoto: (data)    => _post('ait/daily/photos', data, 30000).then(r => Array.isArray(r) ? r[0] : r),
    deleteDailyPhoto: (fileId)  => _del('ait/daily/photos',  { fileId }),
    getDailyPhotos:   ()        => _get('ait/daily/photos'),
    uploadMsPhoto:    (data)    => _post('ait/ms/photos', data, 30000).then(r => Array.isArray(r) ? r[0] : r),
    deleteMsPhoto:    (data)    => _del('ait/ms/photos', data),
    getMsPhotos:      (sampleId)=> _get('ait/ms/photos', { sampleId }),
    getDailyEquipPhotos:  (carId, equipId) => _get('ait/daily/equip/photos', { carId, equipId }),
    syncDailyEquipPhotos: (carId, equipId, photos) => _post('ait/daily/equip/photos/sync', { carId, equipId, photos }),
    driveUrl:         (fileId)  => `https://lh3.googleusercontent.com/d/${fileId}=w1200`,
    normalizePhotoUrl:(url)     => { if(!url) return url; const m=url.match(/(?:lh3\.googleusercontent\.com\/d\/|drive\.google\.com\/(?:uc\?.*[?&]id=|thumbnail\?.*[?&]id=))([^?&\s=]+)/); return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w1200` : url; },

    /* ── 커스텀 항목 메타 ─────────────────────── */
    getDailyItems:    (carId)        => _get('ait/daily/items', { carId }),
    syncDailyItems:   (carId, items) => _post('ait/daily/items/sync', { carId, items }),
    getImfItems:      (carId)        => _get('ait/imf/items', { carId }),
    syncImfItems:     (carId, items) => _post('ait/imf/items/sync', { carId, items }),
    getImfPoints:     (carId)        => _get('ait/imf/points', { carId }),
    syncImfPoints:    (carId, sheetId, points) => _post('ait/imf/points/sync', { carId, sheetId, points }),
    getMsItems:       (carId)        => _get('ait/ms/items', { carId }),
    syncMsItems:      (carId, items) => _post('ait/ms/items/sync', { carId, items }),

    /* ── 공정검사기준서 (JSON blob) ───────────── */
    getInspDoc:       (carId)        => _get('ait/insp/doc', { carId }),
    saveInspDoc:      (carId, doc)   => _post('ait/insp/doc', { carId, doc }),

    /* ── Q-Point (JSON blob) ──────────────────── */
    getQpointList:    (carId)        => _get('ait/qpoint/list', { carId }),
    saveQpointList:   (carId, list)  => _post('ait/qpoint/save', { carId, list }),

    /* ── 하위 호환: 기존 api.js 메서드명 유지 ──── */
    async getImfMeta(car) {
      const sheets = await this.getImfSheets(car);
      return { sheets };
    },
    async getMsMeta(car) {
      const samples = await this.getMsSamples(car);
      return { samples };
    },
    async getDailyEquipment(car) {
      return this.getDailyEquipments(car);
    },
    getImfResult()  { return ''; },
    setImfResult()  {},
    getMsResult()   { return ''; },
    setMsResult()   {}
  };

  /* ────────────────────────────────────────────────
     localStorage MOCK 구현 (현재 사용 중)
  ──────────────────────────────────────────────── */
  const _mock = {
    getCars() {
      return JSON.parse(localStorage.getItem('ait_cars') || '[]');
    },
    async getImfMeta(car) {
      return JSON.parse(localStorage.getItem(`ait_imf_data_${car}`) || '{"sheets":[]}');
    },
    async getMsMeta(car) {
      return JSON.parse(localStorage.getItem(`ait_ms_data_${car}`) || '{"samples":[]}');
    },
    async saveImfMeta(car, data) {
      localStorage.setItem(`ait_imf_data_${car}`, JSON.stringify(data));
    },
    async saveMsMeta(car, data) {
      localStorage.setItem(`ait_ms_data_${car}`, JSON.stringify(data));
    },
    getImfResult(car, year, month, day, no, phase) {
      return localStorage.getItem(`ait_imf_res_${car}_${year}_${month}_${day}_${no}_${phase}`) || '';
    },
    setImfResult(car, year, month, day, no, phase, val) {
      const k = `ait_imf_res_${car}_${year}_${month}_${day}_${no}_${phase}`;
      val ? localStorage.setItem(k, val) : localStorage.removeItem(k);
    },
    getMsResult(car, year, month, day, no, sub) {
      return localStorage.getItem(`ait_ms_res_${car}_${year}_${month}_${day}_${no}_${sub||0}`) || '';
    },
    setMsResult(car, year, month, day, no, sub, val) {
      const k = `ait_ms_res_${car}_${year}_${month}_${day}_${no}_${sub||0}`;
      val ? localStorage.setItem(k, val) : localStorage.removeItem(k);
    },
    async getDailyEquipment(car) {
      return [];
    },
    async saveDailyEquipment(car, list) {}
  };

  const impl = MOCK ? _mock : _real;

  /* ── 유틸 ── */
  const CIRCLES = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  function numCircle(n) { return CIRCLES[(n||1)-1] || String(n); }

  /* ── 공개 API ── */
  return {
    MOCK,
    N8N,
    authHeaders: _authHeaders,
    /* 차종 */
    getCars:            ()           => _real.getCars(),
    createCar:          (data)       => _real.createCar(data),
    updateCar:          (id, data)   => _real.updateCar(id, data),
    /* 개정 */
    getRevisions:       (cId, dt)    => _real.getRevisions(cId, dt),
    addRevision:        (cId, dt, d) => _real.addRevision(cId, dt, d),
    signRevision:       (cId, dt, rv, role, name, b64, fn) => _real.signRevision(cId, dt, rv, role, name, b64, fn),
    getRevisionSigns:   (cId, dt) => _real.getRevisionSigns(cId, dt),
    deleteSign:         (cId, dt, rv, role) => _real.deleteSign(cId, dt, rv, role),
    deleteRevision:     (id) => _real.deleteRevision(id),
    /* CP */
    getCpRows:          (carId)      => _real.getCpRows(carId),
    createCpRow:        (cId, d)     => _real.createCpRow(cId, d),
    updateCpRow:        (id, d)      => _real.updateCpRow(id, d),
    deleteCpRow:        (id)         => _real.deleteCpRow(id),
    updateCpOrder:      (cId, items) => _real.updateCpOrder(cId, items),
    /* 설비일상 */
    getDailyEquipments: (carId)      => impl.getDailyEquipment ? impl.getDailyEquipment(carId) : _real.getDailyEquipments(carId),
    createDailyEquip:   (carId, d)   => _real.createDailyEquip(carId, d),
    updateDailyEquip:   (id, d)      => _real.updateDailyEquip(id, d),
    syncDailyEquip:     (carId, equipments) => _real.syncDailyEquip(carId, equipments),
    getDailyResults:    (eId, date)  => _real.getDailyResults(eId, date),
    getDailyMonthStatus:(eId, ym)    => _real.getDailyMonthStatus(eId, ym),
    getDailyMonthResults:(eId, ym)   => _real.getDailyMonthResults(eId, ym),
    getMsMonthStatus:   (sId, ym)    => _real.getMsMonthStatus(sId, ym),
    saveDailyResults:   (payload)    => _real.saveDailyResults(payload),
    validateDailyResults: (equip_id, check_date, results) => _real.validateDailyResults(equip_id, check_date, results),
    resetDailyOnCpChange: (carId, fromDate) => _post('ait/cp/reset-daily', { carId, fromDate }),
    /* IMF */
    getImfSheets:       (carId)      => _real.getImfSheets(carId),
    createImfSheet:     (cId, d)     => _real.createImfSheet(cId, d),
    updateImfSheet:     (id, d)      => _real.updateImfSheet(id, d),
    deleteImfSheet:     (id)         => _real.deleteImfSheet(id),
    getImfResults:      (sId, date)  => _real.getImfResults(sId, date),
    saveImfResults:     (payload)    => _real.saveImfResults(payload),
    /* MS */
    getMsSamples:       (carId)      => _real.getMsSamples(carId),
    getMsItems:         (carId)      => _real.getMsItems(carId),
    createMsSample:     (cId, d)     => _real.createMsSample(cId, d),
    updateMsSample:     (id, d)      => _real.updateMsSample(id, d),
    deleteMsSample:     (id)         => _real.deleteMsSample(id),
    getMsResults:       (sId, date)  => _real.getMsResults(sId, date),
    saveMsResults:      (payload)    => _real.saveMsResults(payload),
    /* WS */
    getWsProcesses:     (carId)      => _real.getWsProcesses(carId),
    getWsSteps:         (carId)      => _real.getWsSteps(carId),
    syncWsSteps:        (carId, steps) => _real.syncWsSteps(carId, steps),
    getWsMeta:          (carId)      => _real.getWsMeta(carId),
    saveWsMeta:         (carId, s)   => _real.saveWsMeta(carId, s),
    swapWsProcNos:      (carId, swaps) => _real.swapWsProcNos(carId, swaps),
    /* 하위 호환 */
    getImfMeta:         (car)        => impl.getImfMeta(car),
    getMsMeta:          (car)        => impl.getMsMeta(car),
    saveImfMeta:        (car, d)     => impl.saveImfMeta ? impl.saveImfMeta(car, d) : Promise.resolve(),
    saveMsMeta:         (car, d)     => impl.saveMsMeta ? impl.saveMsMeta(car, d) : Promise.resolve(),
    getImfResult:       (...a)       => impl.getImfResult(...a),
    setImfResult:       (...a)       => impl.setImfResult(...a),
    getMsResult:        (...a)       => impl.getMsResult(...a),
    setMsResult:        (...a)       => impl.setMsResult(...a),
    getDailyEquipment:  (car)        => impl.getDailyEquipment ? impl.getDailyEquipment(car) : _real.getDailyEquipments(car),
    saveDailyEquipment: (car, l)     => impl.saveDailyEquipment ? impl.saveDailyEquipment(car, l) : Promise.resolve(),
    /* 사진 (Google Drive) */
    uploadWsPhoto:      (data)       => _real.uploadWsPhoto(data),
    deleteWsPhoto:      (fileId)     => _real.deleteWsPhoto(fileId),
    getWsPhotos:        ()           => _real.getWsPhotos(),
    uploadDailyPhoto:   (data)       => _real.uploadDailyPhoto(data),
    deleteDailyPhoto:   (fileId)     => _real.deleteDailyPhoto(fileId),
    getDailyPhotos:     ()           => _real.getDailyPhotos(),
    uploadMsPhoto:      (data)       => _real.uploadMsPhoto(data),
    deleteMsPhoto:      (data)       => _real.deleteMsPhoto(data),
    getMsPhotos:        (sampleId)   => _real.getMsPhotos(sampleId),
    getDailyEquipPhotos:  (cId, eId)         => _real.getDailyEquipPhotos(cId, eId),
    syncDailyEquipPhotos: (cId, eId, photos) => _real.syncDailyEquipPhotos(cId, eId, photos),
    driveUrl:           (fileId)     => `https://lh3.googleusercontent.com/d/${fileId}=w1200`,
    normalizePhotoUrl:  (url)        => { if(!url) return url; const m=url.match(/(?:lh3\.googleusercontent\.com\/d\/|drive\.google\.com\/(?:uc\?.*[?&]id=|thumbnail\?.*[?&]id=))([^?&\s=]+)/); return m ? `https://lh3.googleusercontent.com/d/${m[1]}=w1200` : url; },
    getCpMeta:          (carId)        => _real.getCpMeta(carId),
    saveCpMeta:         (carId, data)  => _real.saveCpMeta(carId, data),
    getWsMgmt:          (carId)        => _real.getWsMgmt(carId),
    syncWsMgmt:         (carId, items) => _real.syncWsMgmt(carId, items),
    /* 커스텀 항목 메타 */
    getDailyItems:      (carId)         => _real.getDailyItems(carId),
    syncDailyItems:     (carId, items)  => _real.syncDailyItems(carId, items),
    getImfItems:        (carId)         => _real.getImfItems(carId),
    syncImfItems:       (carId, items)  => _real.syncImfItems(carId, items),
    getImfPoints:       (carId)         => _real.getImfPoints(carId),
    syncImfPoints:      (carId, sheetId, points) => _real.syncImfPoints(carId, sheetId, points),
    getMsItems:         (carId)         => _real.getMsItems(carId),
    syncMsItems:        (carId, items)  => _real.syncMsItems(carId, items),
    /* 공정검사기준서 / Q-Point */
    getInspDoc:         (carId)         => _real.getInspDoc(carId),
    saveInspDoc:        (carId, doc)    => _real.saveInspDoc(carId, doc),
    getQpointList:      (carId)         => _real.getQpointList(carId),
    saveQpointList:     (carId, list)   => _real.saveQpointList(carId, list),
    /* 사양표 */
    getSpecCatalog:     ()                         => _real.getSpecCatalog(),
    getSpecMes:         (date, carModel, lineName) => _real.getSpecMes(date, carModel, lineName),
    getSpecMaster:      (carModel)       => _real.getSpecMaster(carModel),
    createSpecMaster:   (data)           => _real.createSpecMaster(data),
    updateSpecMaster:   (id, data)       => _real.updateSpecMaster(id, data),
    deleteSpecMaster:   (id)             => _real.deleteSpecMaster(id),
    getSpecBom:            (partNo)              => _real.getSpecBom(partNo),
    deleteSpecBomRow:      (partNo, subPartNo)   => _real.deleteSpecBomRow(partNo, subPartNo),
    getSpecBomParents:     (subPartNo)           => _real.getSpecBomParents(subPartNo),
    getSpecBomSuggest:     (q)                   => _real.getSpecBomSuggest(q),
    getSpecLineProducts:   (lineName, fromDate) => _real.getSpecLineProducts(lineName, fromDate),
    getSpecItemNames:      ()                   => _real.getSpecItemNames(),
    getSpecDriveIndex:     ()                   => _real.getSpecDriveIndex(),
    getSpecPhotos:      (cdItem)         => _real.getSpecPhotos(cdItem),
    uploadSpecPhoto:    (data)           => _real.uploadSpecPhoto(data),
    deleteSpecPhoto:    (data)           => _real.deleteSpecPhoto(data),
    /* 출고요청 */
    createShipRequest:     (payload)                => _real.createShipRequest(payload),
    createShipRequestPart: (payload)                => _real.createShipRequestPart(payload),
    getShipRequests:       (lineName, date, status) => _real.getShipRequests(lineName, date, status),
    updateShipRequestItem: (item_id, status)        => _real.updateShipRequestItem(item_id, status),
    shipItemCheck:         (item_id, emp, on)        => _real.shipItemCheck(item_id, emp, on),
    shipItemDone:          (item_id, emp)            => _real.shipItemDone(item_id, emp),
    cancelShipRequest:     (request_id)             => _real.cancelShipRequest(request_id),
    deleteShipRequestItem: (item_id, request_id)    => _real.deleteShipRequestItem(item_id, request_id),
    getShipLines:          ()                       => _real.getShipLines(),
    getPartLocations:      (parts)                  => _real.getPartLocations(parts),
    savePushSubscription:  (data)                   => _real.savePushSubscription(data),
    pdaLogin:              (emp, pwd)               => _real.pdaLogin(emp, pwd),
    lineWarehouse:         (line)                  => _real.lineWarehouse(line),
    labelInfo:             (label, wh)             => _real.labelInfo(label, wh),
    stockMove:             (payload)               => _real.stockMove(payload),
    numCircle
  };
})();

/* ══════════════════════════════════════════════════════════════
   전역 UI 유틸리티 — safeApi, Toast, Saving indicator
   ══════════════════════════════════════════════════════════════ */

window.showToast = function(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  c.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast-show'));
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 300);
  }, type === 'error' ? 4000 : 2500);
};

window.showSaving = function() {
  const el = document.getElementById('saving-indicator');
  if (el) el.style.display = 'flex';
};

window.hideSaving = function() {
  const el = document.getElementById('saving-indicator');
  if (el) el.style.display = 'none';
};

window.safeApi = async function(fn, { optimisticFn, revertFn, msg = '저장' } = {}) {
  if (optimisticFn) optimisticFn();
  window.showSaving();
  try {
    const r = await fn();
    window.showToast(msg + ' 완료', 'success');
    return r;
  } catch (e) {
    if (revertFn) revertFn();
    window.showToast(msg + ' 실패: ' + (e.message || String(e)), 'error');
    throw e;
  } finally {
    window.hideSaving();
  }
};
