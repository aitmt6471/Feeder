# -*- coding: utf-8 -*-
"""MES 필요투입품목리스트 — '완전히 분리된' 새 n8n 워크플로우를 생성한다.
- 기존 메가번들(ait_gongjeong_live, WID=jG3HL1hIxfRwBSHq)에 넣지 않고 POST로 새 워크플로우 생성.
- 엔드포인트:  GET ait/mes/required-input?line=VC&date=20260629  (date=생산작업예상일)
- 동작: 라인명(NM_OPLINE)→CD_OPLINE/생산창고 조회 → MMMO_ORDER_D(제조지시) 완제품을
        DT_MAKESRT(=생산작업예상일)로 필터 → BOM 전개 − 생산창고 재고 = 부족분(>0).
- READ-ONLY SELECT만 사용하므로 운영 DB(SEIERP_AIT) 직접 조회 안전.
- 노드 패턴/크리덴셜은 add_stock_move.py 와 동일.
사용법:  python create_required_input.py <N8N_API_KEY>
재실행 시 동일 이름 워크플로우가 있으면 건너뜀(중복 생성 방지).
"""
import json, sys, os, urllib.request, urllib.error
sys.stdout.reconfigure(encoding='utf-8')

N8N='aitechn8n.ngrok.app'
MSSQL_CRED={'id':'RaXPO7ow6AUqr10U','name':'Microsoft SQL account'}
MYSQL_CRED={'id':'5hPRz7ri5WQQxI8V','name':'공정문서db'}   # 푸시 구독/상태 저장(쓰기 가능 DB). add_push.py와 동일 크리덴셜
KEY=sys.argv[1].strip()

# ── 웹푸시 VAPID 키 (shipping과 동일 키 재사용) ──
_VPATH=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','n8n-workflows','vapid_keys.json')
_V=json.load(open(_VPATH,encoding='utf-8'))
VAPID_JWK={'kty':'EC','crv':'P-256','x':_V['jwk']['x'],'y':_V['jwk']['y'],'d':_V['jwk']['d']}
VAPID_PUB=_V['vapidPublic']; VAPID_SUB=_V['sub']
WF_NAME='AIT MES 필요투입품목 (required-input)'
DB='SEIERP_AIT'   # READ-ONLY 라 운영 직접 안전. 테스트만 하려면 'SEIERP_AIT_TEST'

def api(method,path,body=None):
    url=f'https://{N8N}/api/v1{path}'
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(url,data=data,method=method)
    req.add_header('X-N8N-API-KEY',KEY); req.add_header('Content-Type','application/json')
    try:
        with urllib.request.urlopen(req,timeout=60) as r: return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e: return e.code,e.read().decode('utf-8','replace')

# ── 같은 이름 워크플로우가 있으면 갱신(PUT), 없으면 생성(POST) — 재실행 안전 ──
EXISTING_ID=None
st,lst=api('GET','/workflows?limit=250')
if st==200:
    for w in ((lst.get('data') if isinstance(lst,dict) else lst) or []):
        if isinstance(w,dict) and w.get('name')==WF_NAME:
            EXISTING_ID=w.get('id'); break

# ───────────────────── BuildSQL ─────────────────────
# query: line(라인명), date(YYYY-MM-DD or YYYYMMDD)
# 소스 = MMWM_MATINPUT_D(자재투입). NO_MMWM=자재투입번호(라인별 일자-순번).
# 자재투입번호 오름차순 → 타임슬롯 1=A,2=B,3=C,4번째이후=D(D에 합침).
# 같은 부품이 여러 타임에 걸치면 빠른 타임(A)부터 재고 소진(워터폴) → 슬롯별 부족분.
BUILD=(
"const q=$json.query||{};\n"
"const esc=v=>String(v==null?'':v).replace(/'/g,\"''\");\n"
"const line=esc(q.line||'');\n"
"const dt=esc(String(q.date||'').replace(/-/g,''));\n"
"if(!line||dt.length!==8){ return [{json:{sql:\"SELECT TOP 0 '' AS sub_part_no\"}}]; }\n"
"const sql=`DECLARE @line NVARCHAR(50)='${line}';DECLARE @dt NVARCHAR(8)='${dt}';`+\n"
"`DECLARE @opline NVARCHAR(20),@wh NVARCHAR(20);`+\n"
"`SELECT @opline=CD_OPLINE,@wh=CD_WAREHOUSE FROM __DB__.dbo.MMIT_OPLINE WHERE CD_CORP='01' AND NM_OPLINE=@line;`+\n"
"`WITH wo AS(SELECT d.NO_MMWM,d.NO_PRCS,d.NO_PRCSSUB,d.NO_PRCSSUB2,d.CD_SYSITEM prod,d.QT_ORDER FROM __DB__.dbo.MMWM_MATINPUT_D d WHERE d.CD_OPLINE=@opline AND LEFT(d.DT_MAKESRT,8)=@dt),`+\n"
"`slot AS(SELECT NO_MMWM,CASE WHEN DENSE_RANK() OVER(ORDER BY NO_MMWM)>=4 THEN 4 ELSE DENSE_RANK() OVER(ORDER BY NO_MMWM) END sr FROM(SELECT DISTINCT NO_MMWM FROM wo) x),`+\n"
"`sm AS(SELECT sr,MIN(NO_MMWM) first_no,COUNT(*) n_batch FROM slot GROUP BY sr),`+\n"
"`need AS(SELECT s.sr,b.CD_SYSITEMCHILD child,SUM(b.QT_UNIT*(1+b.RT_LOSS)*wo.QT_ORDER) need_qty FROM wo JOIN slot s ON s.NO_MMWM=wo.NO_MMWM JOIN __DB__.dbo.MMIT_MBOM b ON b.CD_SYSITEM=wo.prod GROUP BY s.sr,b.CD_SYSITEMCHILD),`+\n"
"`prcs AS(SELECT DISTINCT s.sr,wo.NO_PRCS,wo.NO_PRCSSUB,wo.NO_PRCSSUB2 FROM wo JOIN slot s ON s.NO_MMWM=wo.NO_MMWM),`+\n"
"`cons AS(SELECT p.sr,d2.CD_SYSITEM child,SUM(d2.QT_INPUT) used FROM __DB__.dbo.MMWA_WORKACHIEVE_H h JOIN __DB__.dbo.MMWA_WORKACHIEVE_D2 d2 ON d2.NO_MMWA=h.NO_MMWA JOIN prcs p ON p.NO_PRCS=h.NO_PRCS AND p.NO_PRCSSUB=h.NO_PRCSSUB AND p.NO_PRCSSUB2=h.NO_PRCSSUB2 GROUP BY p.sr,d2.CD_SYSITEM),`+\n"
"`net AS(SELECT n.sr,n.child,n.need_qty,n.need_qty-ISNULL(c.used,0) net_qty FROM need n LEFT JOIN cons c ON c.sr=n.sr AND c.child=n.child),`+\n"
"`stk AS(SELECT CD_SYSITEM,SUM(QT_STOCK) stock FROM __DB__.dbo.STIT_STOCK_NOW WHERE CD_WAREHOUSE=@wh GROUP BY CD_SYSITEM),`+\n"
"`calc AS(SELECT nt.sr,nt.child,nt.need_qty,nt.net_qty,SUM(nt.net_qty) OVER(PARTITION BY nt.child ORDER BY nt.sr ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) cum,ISNULL(s.stock,0) stock FROM net nt LEFT JOIN stk s ON s.CD_SYSITEM=nt.child),`+\n"
"`fin AS(SELECT c.sr,c.child,c.need_qty,c.stock,(CASE WHEN c.cum-c.stock>0 THEN c.cum-c.stock ELSE 0 END)-(CASE WHEN (c.cum-c.net_qty)-c.stock>0 THEN (c.cum-c.net_qty)-c.stock ELSE 0 END) AS total_qty FROM calc c)`+\n"
"`SELECT i.CD_ITEM AS sub_part_no,i.NM_ITEM AS part_name,i.TX_SPEC AS spec,f.child AS sysitem,f.sr AS slot_rank,sm.first_no AS slot_no,sm.n_batch AS slot_n,f.need_qty AS need_qty,f.stock AS prod_stock,f.total_qty AS total_qty,@line AS line_name,@wh AS in_wh,0 AS is_empty `+\n"
"`FROM fin f JOIN __DB__.dbo.BSIT_ITEM i ON i.CD_SYSITEM=f.child JOIN sm ON sm.sr=f.sr WHERE f.total_qty>0 `+\n"
"`UNION ALL `+\n"
"`SELECT '' AS sub_part_no,'' AS part_name,'' AS spec,'' AS sysitem,sm.sr AS slot_rank,sm.first_no AS slot_no,sm.n_batch AS slot_n,0 AS need_qty,0 AS prod_stock,0 AS total_qty,@line AS line_name,@wh AS in_wh,1 AS is_empty `+\n"
"`FROM sm WHERE sm.sr NOT IN(SELECT sr FROM fin WHERE total_qty>0) `+\n"
"`ORDER BY slot_rank,total_qty DESC;`;\n"
"return [{json:{sql}}];")

FMT=(
"const L=['','A','B','C','D'];\n"
"const rows=$input.all().map(i=>i.json).filter(r=>r&&(r.sub_part_no||Number(r.is_empty)));\n"
"const out=rows.map(r=>({sub_part_no:String(r.sub_part_no||''),part_name:String(r.part_name||''),"
"spec:String(r.spec||''),sysitem:String(r.sysitem||''),need_qty:Number(r.need_qty)||0,"
"prod_stock:Number(r.prod_stock)||0,total_qty:Number(r.total_qty)||0,"
"slot:L[Number(r.slot_rank)||0]||'A',slot_no:String(r.slot_no||''),slot_n:Number(r.slot_n)||1,"
"is_empty:Number(r.is_empty)||0,"
"line_name:String(r.line_name||''),in_wh:String(r.in_wh||'')}));\n"
"return [{json:{rows:out}}];")

BUILD=BUILD.replace('__DB__',DB)

# ───────────────────── 라인목록(oplines) ─────────────────────
# 입력 없음. MMIT_OPLINE 전체 라인명(NM_OPLINE) 반환 → 프론트 <select> 동적 생성.
OPL_SQL=("SELECT NM_OPLINE, MIN(CD_OPLINE) AS CD_OPLINE FROM __DB__.dbo.MMIT_OPLINE "
         "WHERE CD_CORP='01' AND ISNULL(NM_OPLINE,'')<>'' GROUP BY NM_OPLINE ORDER BY NM_OPLINE").replace('__DB__',DB)
OPL_FMT=("const rows=$input.all().map(i=>i.json).filter(r=>r&&r.NM_OPLINE);\n"
         "const out=rows.map(r=>({line:String(r.NM_OPLINE),code:String(r.CD_OPLINE||'')}));\n"
         "return [{json:{lines:out}}];")

# ═════════════════════ 웹푸시(필요투입 전용, 출고요청과 분리) ═════════════════════
# 구독저장: push_sub_reqinput / 상태·최신알림: reqinput_kv (둘 다 MySQL 공정문서db)
# 트리거: 5분 주기 크론이 전 라인 오늘~내일 부족분 계산 → 직전 스냅샷과 비교 → '새로 생긴' 부족품목 있으면 payload-less 푸시

# 구독 UPSERT
PS_SQL=(
"const b=$input.first().json.body||{};\n"
"const ep=b.endpoint||''; const k=b.keys||{}; const p=k.p256dh||''; const a=k.auth||''; const ua=String(b.ua||'').slice(0,255);\n"
"const esc=v=>String(v).replace(/'/g,\"''\");\n"
"if(!ep||!p||!a){ return [{json:{sql:'SELECT 1'}}]; }\n"
"const sql=`INSERT INTO push_sub_reqinput(endpoint,p256dh,auth,ua) VALUES('${esc(ep)}','${esc(p)}','${esc(a)}','${esc(ua)}') ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh),auth=VALUES(auth),ua=VALUES(ua)`;\n"
"return [{json:{sql}}];")

# 최신알림 포맷(SW가 GET 해서 알림 문구로 사용)
RL_FMT=("const r=($input.first()&&$input.first().json)||{};\n"
"let o={}; try{ o=JSON.parse(r.v||'{}'); }catch(e){}\n"
"return [{json:{line:o.line||'', body:o.body||''}}];")

# payload-less VAPID 발송 빌드 (메모리 노트: new URL()이 n8n Code노드에서 ReferenceError로 무발송 → 정규식으로 origin 추출)
SEND_BUILD=(
"const crypto=require('crypto');\n"
f"const JWK={json.dumps(VAPID_JWK)};\n"
f"const PUB={json.dumps(VAPID_PUB)}; const SUB={json.dumps(VAPID_SUB)};\n"
"const b64url=b=>Buffer.from(b).toString('base64').replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');\n"
"const priv=crypto.createPrivateKey({key:JWK,format:'jwk'});\n"
"const subs=$input.all().map(i=>i.json).filter(r=>r&&r.endpoint);\n"
"const out=[];\n"
"for(const s of subs){\n"
"  const m=String(s.endpoint).match(/^https?:\\/\\/[^/]+/); const origin=m?m[0]:''; if(!origin) continue;\n"
"  const header=b64url(JSON.stringify({typ:'JWT',alg:'ES256'}));\n"
"  const payload=b64url(JSON.stringify({aud:origin,exp:Math.floor(Date.now()/1000)+43200,sub:SUB}));\n"
"  const sig=crypto.sign('SHA256',Buffer.from(header+'.'+payload),{key:priv,dsaEncoding:'ieee-p1363'});\n"
"  const jwt=header+'.'+payload+'.'+b64url(sig);\n"
"  out.push({json:{endpoint:s.endpoint, authHeader:`vapid t=${jwt}, k=${PUB}`}});\n"
"}\n"
"return out.length?out:[{json:{endpoint:'',authHeader:'',__none:true}}];")

# 크론: 전 라인 오늘~내일 부족분(슬롯 무관, 단순 BOM−재고). 고정 쿼리.
SHORT_SQL=(
"DECLARE @d0 NVARCHAR(8)=CONVERT(char(8),GETDATE(),112);"
"DECLARE @d1 NVARCHAR(8)=CONVERT(char(8),DATEADD(day,1,GETDATE()),112);"
"WITH wo AS(SELECT d.CD_OPLINE,LEFT(d.DT_MAKESRT,8) dt,d.CD_SYSITEM prod,d.QT_ORDER,d.NO_PRCS,d.NO_PRCSSUB,d.NO_PRCSSUB2 "
 "FROM __DB__.dbo.MMWM_MATINPUT_D d WHERE LEFT(d.DT_MAKESRT,8) IN(@d0,@d1)),"
"op AS(SELECT CD_OPLINE,NM_OPLINE,CD_WAREHOUSE FROM __DB__.dbo.MMIT_OPLINE WHERE CD_CORP='01'),"
"need AS(SELECT w.CD_OPLINE,w.dt,b.CD_SYSITEMCHILD child,SUM(b.QT_UNIT*(1+b.RT_LOSS)*w.QT_ORDER) need_qty "
 "FROM wo w JOIN __DB__.dbo.MMIT_MBOM b ON b.CD_SYSITEM=w.prod GROUP BY w.CD_OPLINE,w.dt,b.CD_SYSITEMCHILD),"
"prcs AS(SELECT DISTINCT CD_OPLINE,dt,NO_PRCS,NO_PRCSSUB,NO_PRCSSUB2 FROM wo),"
"cons AS(SELECT p.CD_OPLINE,p.dt,d2.CD_SYSITEM child,SUM(d2.QT_INPUT) used "
 "FROM __DB__.dbo.MMWA_WORKACHIEVE_H h JOIN __DB__.dbo.MMWA_WORKACHIEVE_D2 d2 ON d2.NO_MMWA=h.NO_MMWA "
 "JOIN prcs p ON p.NO_PRCS=h.NO_PRCS AND p.NO_PRCSSUB=h.NO_PRCSSUB AND p.NO_PRCSSUB2=h.NO_PRCSSUB2 GROUP BY p.CD_OPLINE,p.dt,d2.CD_SYSITEM),"
"stk AS(SELECT CD_WAREHOUSE,CD_SYSITEM,SUM(QT_STOCK) stock FROM __DB__.dbo.STIT_STOCK_NOW GROUP BY CD_WAREHOUSE,CD_SYSITEM) "
"SELECT o.NM_OPLINE AS line,n.dt AS dt,i.CD_ITEM AS sub_part_no,i.NM_ITEM AS part_name "
"FROM need n JOIN op o ON o.CD_OPLINE=n.CD_OPLINE JOIN __DB__.dbo.BSIT_ITEM i ON i.CD_SYSITEM=n.child "
"LEFT JOIN cons c ON c.CD_OPLINE=n.CD_OPLINE AND c.dt=n.dt AND c.child=n.child "
"LEFT JOIN stk s ON s.CD_WAREHOUSE=o.CD_WAREHOUSE AND s.CD_SYSITEM=n.child "
"WHERE n.need_qty-ISNULL(c.used,0)-ISNULL(s.stock,0)>0 ORDER BY o.NM_OPLINE,n.dt,sub_part_no;").replace('__DB__',DB)

# 크론 diff: 직전 스냅샷(reqinput_kv k=snap)과 비교해 '새로 생긴' 부족품목 판정 → snap/latest UPSERT SQL 생성
SHORT_DIFF=(
"const esc=v=>String(v==null?'':v).replace(/'/g,\"''\");\n"
"const cur=$('CR_Short').all().map(i=>i.json).filter(r=>r&&r.sub_part_no);\n"
"const keyOf=r=>`${r.line}|${r.dt}|${r.sub_part_no}`;\n"
"const curKeys=cur.map(keyOf); const curSet=new Set(curKeys);\n"
"let prev=null;\n"
"try{ const pv=$('CR_Prev').first(); const raw=pv&&pv.json&&pv.json.v; if(raw){ prev=new Set(JSON.parse(raw)); } }catch(e){}\n"
"const grp={};\n"
"if(prev){ for(const r of cur){ if(!prev.has(keyOf(r))){ const g=r.line+'|'+r.dt; (grp[g]=grp[g]||[]).push(r); } } }\n"
"const gnames=Object.keys(grp).sort((a,b)=>grp[b].length-grp[a].length);\n"
"let hasNew=0, body='', line='', dt='';\n"
"if(gnames.length){ hasNew=1; const g=gnames[0]; const gp=g.split('|'); line=gp[0]; dt=gp[1];\n"
"  const ex=gnames.length>1?` (+${gnames.length-1}개 라인)`:'';\n"
"  body=`${line}라인에 출고요청이 있습니다.${ex}`; }\n"
"const snap=JSON.stringify([...curSet]);\n"
"const latest=JSON.stringify({line,dt,body,ts:Date.now()});\n"
"const snapSql=`INSERT INTO reqinput_kv(k,v) VALUES('snap','${esc(snap)}') ON DUPLICATE KEY UPDATE v=VALUES(v)`;\n"
"const latestSql=`INSERT INTO reqinput_kv(k,v) VALUES('latest','${esc(latest)}') ON DUPLICATE KEY UPDATE v=VALUES(v)`;\n"
"return [{json:{hasNew,body,line,dt,snapSql,latestSql}}];")

GATE=("const d=$('CR_Diff').first().json;\nreturn d.hasNew? [{json:d}] : [];")

DDL1=("CREATE TABLE IF NOT EXISTS push_sub_reqinput("
 "id INT AUTO_INCREMENT PRIMARY KEY, endpoint VARCHAR(500) NOT NULL,"
 "p256dh VARCHAR(255), auth VARCHAR(255), ua VARCHAR(255),"
 "updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,"
 "UNIQUE KEY uq_ep(endpoint(191)))")
DDL2=("CREATE TABLE IF NOT EXISTS reqinput_kv("
 "k VARCHAR(40) PRIMARY KEY, v MEDIUMTEXT,"
 "updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)")

def _code(nid,name,x,y,js,always=False):
    n={'id':nid,'name':name,'type':'n8n-nodes-base.code','typeVersion':2,'position':[x,y],
       'parameters':{'mode':'runOnceForAllItems','jsCode':js}}
    if always: n['alwaysOutputData']=True
    return n
def _mysql(nid,name,x,y,query,always=False):
    n={'id':nid,'name':name,'type':'n8n-nodes-base.mySql','typeVersion':2.4,'position':[x,y],
       'credentials':{'mySql':MYSQL_CRED},'parameters':{'operation':'executeQuery','query':query,'options':{}}}
    if always: n['alwaysOutputData']=True
    return n
def _wh(nid,name,x,y,path,wid,method='POST'):
    return {'id':nid,'name':name,'type':'n8n-nodes-base.webhook','typeVersion':2,'position':[x,y],'webhookId':wid,
            'parameters':{'path':path,'httpMethod':method,'responseMode':'responseNode','authentication':'none','options':{}}}
def _resp(nid,name,x,y,body):
    return {'id':nid,'name':name,'type':'n8n-nodes-base.respondToWebhook','typeVersion':1.1,'position':[x,y],
            'parameters':{'respondWith':'json','responseBody':body,'options':{}}}
def _http(nid,name,x,y):
    return {'id':nid,'name':name,'type':'n8n-nodes-base.httpRequest','typeVersion':4.2,'position':[x,y],
            'continueOnFail':True,'parameters':{'method':'POST','url':'={{ $json.endpoint }}','sendHeaders':True,
            'headerParameters':{'parameters':[{'name':'Authorization','value':'={{ $json.authHeader }}'},{'name':'TTL','value':'86400'},{'name':'Urgency','value':'high'}]},'options':{}}}

PY=900   # 푸시 노드 Y 시작(기존 라우트 300/600 아래)
push_nodes=[
 # ① 구독 저장
 _wh('ps-wh','PS_Webhook',0,PY,'ait/mes/push-subscribe','mes-push-subscribe'),
 _code('ps-bs','PS_BuildSQL',300,PY,PS_SQL),
 _mysql('ps-my','PS_MySQL',600,PY,'={{ $json.sql }}'),
 _resp('ps-rs','PS_Respond',900,PY,'={{ JSON.stringify({ok:true}) }}'),
 # ② 최신 알림 조회(SW용)
 _wh('rl-wh','RL_Webhook',0,PY+300,'ait/mes/req-push-latest','mes-req-push-latest','GET'),
 _mysql('rl-my','RL_MySQL',300,PY+300,"SELECT v FROM reqinput_kv WHERE k='latest'",always=True),
 _code('rl-fmt','RL_Format',600,PY+300,RL_FMT,always=True),
 _resp('rl-rs','RL_Respond',900,PY+300,'={{ JSON.stringify($json) }}'),
 # ③ 테이블 생성(최초 1회 호출)
 _wh('pi-wh','PI_Webhook',0,PY+600,'ait/mes/push-init','mes-push-init'),
 _mysql('pi-t1','PI_T1',300,PY+600,DDL1,always=True),
 _mysql('pi-t2','PI_T2',600,PY+600,DDL2,always=True),
 _resp('pi-rs','PI_Respond',900,PY+600,'={{ JSON.stringify({ok:true}) }}'),
 # ④ 테스트 발송
 _wh('tp-wh','TP_Webhook',0,PY+900,'ait/mes/push-test','mes-push-test'),
 _mysql('tp-sel','TP_Subs',300,PY+900,'SELECT endpoint,p256dh,auth FROM push_sub_reqinput',always=True),
 _code('tp-bd','TP_Build',600,PY+900,SEND_BUILD,always=True),
 _http('tp-snd','TP_Send',900,PY+900),
 _resp('tp-rs','TP_Respond',1200,PY+900,'={{ JSON.stringify({ok:true}) }}'),
 # ⑤ 크론: 부족 신규발생 감지 → 발송
 {'id':'cr-sch','name':'CR_Sched','type':'n8n-nodes-base.scheduleTrigger','typeVersion':1.2,'position':[0,PY+1200],
  'parameters':{'rule':{'interval':[{'field':'minutes','minutesInterval':5}]}}},
 _mysql('cr-prev','CR_Prev',300,PY+1200,"SELECT v FROM reqinput_kv WHERE k='snap'",always=True),
 {'id':'cr-short','name':'CR_Short','type':'n8n-nodes-base.microsoftSql','typeVersion':1,'position':[600,PY+1200],
  'credentials':{'microsoftSql':MSSQL_CRED},'alwaysOutputData':True,
  'parameters':{'operation':'executeQuery','query':SHORT_SQL,'options':{}}},
 _code('cr-diff','CR_Diff',900,PY+1200,SHORT_DIFF,always=True),
 _mysql('cr-snap','CR_SaveSnap',1200,PY+1200,'={{ $json.snapSql }}',always=True),
 _code('cr-gate','CR_Gate',1500,PY+1200,GATE),   # ★always 금지: []반환 시 빈아이템 강제출력 막아 발송 게이트로 작동
 _mysql('cr-lat','CR_SaveLatest',1800,PY+1200,'={{ $json.latestSql }}',always=True),
 _mysql('cr-subs','CR_Subs',2100,PY+1200,'SELECT endpoint,p256dh,auth FROM push_sub_reqinput',always=True),
 _code('cr-bd','CR_Build',2400,PY+1200,SEND_BUILD,always=True),
 _http('cr-snd','CR_Send',2700,PY+1200),
]
push_conn={
 'PS_Webhook':{'main':[[{'node':'PS_BuildSQL','type':'main','index':0}]]},
 'PS_BuildSQL':{'main':[[{'node':'PS_MySQL','type':'main','index':0}]]},
 'PS_MySQL':{'main':[[{'node':'PS_Respond','type':'main','index':0}]]},
 'RL_Webhook':{'main':[[{'node':'RL_MySQL','type':'main','index':0}]]},
 'RL_MySQL':{'main':[[{'node':'RL_Format','type':'main','index':0}]]},
 'RL_Format':{'main':[[{'node':'RL_Respond','type':'main','index':0}]]},
 'PI_Webhook':{'main':[[{'node':'PI_T1','type':'main','index':0}]]},
 'PI_T1':{'main':[[{'node':'PI_T2','type':'main','index':0}]]},
 'PI_T2':{'main':[[{'node':'PI_Respond','type':'main','index':0}]]},
 'TP_Webhook':{'main':[[{'node':'TP_Subs','type':'main','index':0}]]},
 'TP_Subs':{'main':[[{'node':'TP_Build','type':'main','index':0}]]},
 'TP_Build':{'main':[[{'node':'TP_Send','type':'main','index':0}]]},
 'TP_Send':{'main':[[{'node':'TP_Respond','type':'main','index':0}]]},
 'CR_Sched':{'main':[[{'node':'CR_Prev','type':'main','index':0}]]},
 'CR_Prev':{'main':[[{'node':'CR_Short','type':'main','index':0}]]},
 'CR_Short':{'main':[[{'node':'CR_Diff','type':'main','index':0}]]},
 'CR_Diff':{'main':[[{'node':'CR_SaveSnap','type':'main','index':0}]]},
 'CR_SaveSnap':{'main':[[{'node':'CR_Gate','type':'main','index':0}]]},
 'CR_Gate':{'main':[[{'node':'CR_SaveLatest','type':'main','index':0}]]},
 'CR_SaveLatest':{'main':[[{'node':'CR_Subs','type':'main','index':0}]]},
 'CR_Subs':{'main':[[{'node':'CR_Build','type':'main','index':0}]]},
 'CR_Build':{'main':[[{'node':'CR_Send','type':'main','index':0}]]},
}

Y=300
nodes=[
 {'id':'rqi-wh','name':'RQI_Webhook','type':'n8n-nodes-base.webhook','typeVersion':2,'position':[0,Y],
  'webhookId':'rqi-required-input','parameters':{'path':'ait/mes/required-input','httpMethod':'GET',
  'responseMode':'responseNode','authentication':'none','options':{}}},
 {'id':'rqi-bs','name':'RQI_BuildSQL','type':'n8n-nodes-base.code','typeVersion':2,'position':[300,Y],
  'parameters':{'mode':'runOnceForAllItems','jsCode':BUILD}},
 {'id':'rqi-ms','name':'RQI_Mssql','type':'n8n-nodes-base.microsoftSql','typeVersion':1,'position':[600,Y],
  'credentials':{'microsoftSql':MSSQL_CRED},'alwaysOutputData':True,
  'parameters':{'operation':'executeQuery','query':'={{ $json.sql }}','options':{}}},
 {'id':'rqi-fmt','name':'RQI_Format','type':'n8n-nodes-base.code','typeVersion':2,'position':[900,Y],
  'alwaysOutputData':True,'parameters':{'mode':'runOnceForAllItems','jsCode':FMT}},
 {'id':'rqi-rs','name':'RQI_Respond','type':'n8n-nodes-base.respondToWebhook','typeVersion':1.1,'position':[1200,Y],
  'parameters':{'respondWith':'json','responseBody':'={{ JSON.stringify($json.rows) }}','options':{}}},
 # ── 라인목록 라우트 ──
 {'id':'opl-wh','name':'OPL_Webhook','type':'n8n-nodes-base.webhook','typeVersion':2,'position':[0,Y+300],
  'webhookId':'rqi-oplines','parameters':{'path':'ait/mes/oplines','httpMethod':'GET',
  'responseMode':'responseNode','authentication':'none','options':{}}},
 {'id':'opl-ms','name':'OPL_Mssql','type':'n8n-nodes-base.microsoftSql','typeVersion':1,'position':[600,Y+300],
  'credentials':{'microsoftSql':MSSQL_CRED},'alwaysOutputData':True,
  'parameters':{'operation':'executeQuery','query':OPL_SQL,'options':{}}},
 {'id':'opl-fmt','name':'OPL_Format','type':'n8n-nodes-base.code','typeVersion':2,'position':[900,Y+300],
  'alwaysOutputData':True,'parameters':{'mode':'runOnceForAllItems','jsCode':OPL_FMT}},
 {'id':'opl-rs','name':'OPL_Respond','type':'n8n-nodes-base.respondToWebhook','typeVersion':1.1,'position':[1200,Y+300],
  'parameters':{'respondWith':'json','responseBody':'={{ JSON.stringify($json.lines) }}','options':{}}},
]
connections={
 'RQI_Webhook':{'main':[[{'node':'RQI_BuildSQL','type':'main','index':0}]]},
 'RQI_BuildSQL':{'main':[[{'node':'RQI_Mssql','type':'main','index':0}]]},
 'RQI_Mssql':{'main':[[{'node':'RQI_Format','type':'main','index':0}]]},
 'RQI_Format':{'main':[[{'node':'RQI_Respond','type':'main','index':0}]]},
 'OPL_Webhook':{'main':[[{'node':'OPL_Mssql','type':'main','index':0}]]},
 'OPL_Mssql':{'main':[[{'node':'OPL_Format','type':'main','index':0}]]},
 'OPL_Format':{'main':[[{'node':'OPL_Respond','type':'main','index':0}]]},
}
# ── 웹푸시 노드/연결 병합 ──
nodes.extend(push_nodes)
connections.update(push_conn)
wf={'name':WF_NAME,'nodes':nodes,'connections':connections,'settings':{'executionOrder':'v1'}}

if EXISTING_ID:
    st,res=api('PUT',f'/workflows/{EXISTING_ID}',wf)
    print('PUT',st,'OK' if st==200 else str(res)[:300])
    wid=EXISTING_ID if st==200 else None
else:
    st,res=api('POST','/workflows',wf)
    print('POST',st,'OK' if st in (200,201) else str(res)[:300])
    wid=res.get('id') if st in (200,201) else None
if wid:
    a,_=api('POST',f'/workflows/{wid}/activate'); print('activate',a)
    print(f'완료. id={wid}  DB={DB}')
    print(f'테스트1: curl "https://{N8N}/webhook/ait/mes/required-input?line=VC&date=20260629"')
    print(f'테스트2: curl "https://{N8N}/webhook/ait/mes/oplines"   (전체 라인 목록)')
    print(f'★최초1회: curl -X POST "https://{N8N}/webhook/ait/mes/push-init"   (구독/상태 테이블 생성)')
    print(f'테스트푸시: curl -X POST "https://{N8N}/webhook/ait/mes/push-test"  (구독기기에 발송)')
    sys.exit(0)
sys.exit(1)
