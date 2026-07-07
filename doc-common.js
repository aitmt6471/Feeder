/* ══════════════════════════════════════════════════════════════
   DOC — 가입고(pmti)/입고처리(pmwi) 공용 스캔·누적·저장 로직
   APK PMTI_TEMPENTER / PMWI_ENTER 이식. 스캔이 라벨→전 필드 해석(RPU_ST_SV, 읽기전용),
   누적 후 저장(SEQNO_S + _I). box 객체를 그대로 저장 payload로 전송.
   ══════════════════════════════════════════════════════════════ */
'use strict';
const MES_DOC = {
  N8N: 'https://aitechn8n.ngrok.app/webhook',
  async pmtiReq(no){
    const r = await fetch(`${this.N8N}/ait/mes/pmti-req?no=${encodeURIComponent(no)}`, {cache:'no-store'});
    if(!r.ok) throw new Error('pmti-req '+r.status);
    const t = await r.text(); return t ? JSON.parse(t) : [];
  },
  async scan(kind, barcode){
    const r = await fetch(`${this.N8N}/ait/mes/${kind}-scan?barcode=${encodeURIComponent(barcode)}`, {cache:'no-store'});
    if(!r.ok) throw new Error(kind+'-scan '+r.status);
    const t = await r.text(); return t ? JSON.parse(t) : {ok:false};
  },
  async save(kind, boxes, emp){
    const r = await fetch(`${this.N8N}/ait/mes/${kind}-save`, {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({boxes, emp})});
    if(!r.ok) throw new Error(kind+'-save '+r.status);
    const t = await r.text(); return t ? JSON.parse(t) : {ok:false};
  }
};

const REASON = { LABEL:'라벨 정보를 찾을 수 없습니다', QTY:'라벨 수량이 0입니다',
  FINISH:'이미 가입고 완료된 라벨입니다', WAREHOUSE:'입고창고를 찾을 수 없습니다' };

const DOC = (function(){
  let CFG=null, _busy=false, _pending={}, _cfmResolve=null;
  const $=id=>document.getElementById(id);
  function fmtQty(n){ n=Math.round(Number(n)*1000)/1000; return n.toLocaleString('en-US',{maximumFractionDigits:3}); }
  function esc1(s){ return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
  function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }
  function beepErr(){ try{ const a=new (window.AudioContext||window.webkitAudioContext)(); const o=a.createOscillator(); o.frequency.value=220; o.connect(a.destination); o.start(); setTimeout(()=>{o.stop();a.close();},180);}catch(_){ } }
  function focusScan(){ const si=$('scan'); if(si) si.focus({preventScroll:true}); }

  function askConfirm(msg){
    return new Promise(res=>{ _cfmResolve=res; $('cfm-msg').textContent=msg; $('cfmModal').classList.add('open'); });
  }
  window._cfmClose=function(v){ $('cfmModal').classList.remove('open'); const r=_cfmResolve; _cfmResolve=null; if(r) r(v); };

  function pending(){ return Object.values(_pending); }
  function totals(){ const pns=new Set(pending().map(b=>b.sub_part_no)); return {boxes:Object.keys(_pending).length, pns:pns.size}; }
  function groups(){
    const g={};
    for(const b of pending()){
      const pn=b.sub_part_no||b.sysitem;
      const o=(g[pn]=g[pn]||{pn, name:b.part_name||'', qty:0, boxes:0, labels:[], sample:b});
      o.qty+=Number(b.qty)||0; o.boxes++; o.labels.push(b.label);
    }
    return Object.values(g).sort((a,b)=>String(a.pn).localeCompare(String(b.pn),undefined,{numeric:true}));
  }
  window._docCancel=function(label){ if(!_pending[label]) return; delete _pending[label]; toast('저장대기 취소'); render(); focusScan(); };

  async function onScan(){
    const inp=$('scan'); if(!inp) return;
    const bc=inp.value.trim(); inp.value='';
    if(!bc){ inp.focus(); return; }
    if(_pending[bc]){ toast('이미 스캔된 라벨입니다'); beepErr(); inp.focus(); return; }
    let r; try{ r=await MES_DOC.scan(CFG.kind, bc); }catch(e){ toast('조회 오류: '+(e.message||e)); inp.focus(); return; }
    if(!r||!r.ok){ toast(REASON[r&&r.reason]||'처리할 수 없는 라벨입니다'); beepErr(); inp.focus(); return; }
    r.label=r.label||bc;
    _pending[r.label]=r;
    toast(`${r.sub_part_no||r.sysitem} +1박스 (${fmtQty(r.qty)})`);
    render(); focusScan();
  }

  async function onSave(){
    if(_busy) return;
    const t=totals(); if(!t.boxes){ toast('스캔된 박스가 없습니다'); return; }
    const ok=await askConfirm(`${t.pns}품목 · ${t.boxes}박스\n\n해당 정보를 ${CFG.title} 하시겠습니까?`);
    if(!ok) return;
    const boxes=pending();
    _busy=true; toast(`${CFG.title} 중... (${t.boxes}박스)`);
    try{
      const res=await MES_DOC.save(CFG.kind, boxes, MES_AUTH.emp);
      if(res&&res.ok){ toast(`${CFG.title} 완료 (${res.no})`); _pending={}; render(); }
      else { toast(`${CFG.title} 실패: `+((res&&res.error)||'오류')); beepErr(); }
    }catch(e){ toast('오류: '+(e.message||e)); beepErr(); }
    finally{ _busy=false; focusScan(); }
  }
  window._docSave=onSave;

  function render(){
    const wrap=$('content');
    const t=totals();
    const gs=groups();
    $('sum').textContent=t.boxes?`${t.pns}품목·${t.boxes}박스`:'대기 0';
    const toolbar=`<div class="sticktop">
      <input id="scan" placeholder="${CFG.scanPlaceholder}" autocomplete="off" inputmode="none" virtualkeyboardpolicy="manual"
        style="width:100%;font-size:15px;padding:9px 12px;border:2px solid #1e3264;border-radius:10px;min-height:42px;font-family:ui-monospace,monospace"
        onkeydown="if(event.key==='Enter'){event.preventDefault();_docScan()}">
      <button onclick="_docSave()" ${t.boxes?'':'disabled'} style="width:100%;min-height:42px;border-radius:9px;font-size:15px;font-weight:800;cursor:pointer;border:none;color:#fff;background:${t.boxes?'#16a34a':'#cbd5e1'}">${CFG.saveLabel}${t.boxes?` (${t.boxes}박스·${t.pns}품목)`:''}</button>
    </div>`;
    if(!gs.length){ wrap.innerHTML=toolbar+`<div class="empty">라벨을 스캔하세요</div>`; focusScan(); return; }
    let body=`<table class="ptbl2"><thead><tr><th style="text-align:left">부품</th><th style="min-width:80px">수량</th><th style="min-width:70px">박스</th></tr></thead><tbody>`;
    gs.forEach(g=>{
      const xBtns=g.labels.map(l=>`<button onclick="_docCancel('${esc1(l)}')" title="이 박스 취소" style="margin:2px;border:none;background:#fee2e2;color:#b91c1c;border-radius:6px;padding:2px 6px;font-size:11px;cursor:pointer">✕${String(l).slice(-4)}</button>`).join('');
      const tag=CFG.extraTag?CFG.extraTag(g.sample):'';
      body+=`<tr>
        <td class="pcol2"><span class="pno2">${g.pn}</span><div class="pnm">${g.name||''}</div>${tag}</td>
        <td><div class="qty" style="color:#16a34a">${fmtQty(g.qty)}</div></td>
        <td><div style="font-size:15px;font-weight:800;color:#16a34a">${g.boxes}박스</div>${xBtns}</td>
      </tr>`;
    });
    body+='</tbody></table>';
    wrap.innerHTML=toolbar+body;
    focusScan();
  }
  window._docScan=onScan;

  return {
    init(cfg){
      CFG=cfg;
      MES_AUTH.ready(()=>{
        const w=$('mes-who'); if(w) w.innerHTML=MES_AUTH.chipHtml();
        render();
      });
    }
  };
})();
