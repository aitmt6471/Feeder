# MES 필요투입품목 (자재팀) — 시범 VC·RC

기존 **수동 출고요청(MySQL `ait_docs`)** 을 대체하여, **MES 작업지시 기준 부족분**을 자동 산출해
피더가 자재창고(00025)→생산창고로 미리 갖다주게 하는 화면. 기존 `shipping.html`과 **데이터 소스가 다름**(완전 분리).

## 구성
| 파일 | 설명 |
|---|---|
| `required_input.sql` | 라이브 부족분 + 타임슬롯(A/B/C/D) 쿼리(검증/참고용). 입력 @line(NM_OPLINE), @dt(YYYYMMDD) |
| `create_required_input.py` | **분리된 새 n8n 워크플로우** 생성 스크립트 (메가번들 미수정, POST 생성). `required-input` + `oplines`(라인목록) 두 라우트 포함 |
| `index.html` | 프론트(부품 통합 리스트 + 스캔→이동). 라인 `<select>`는 `oplines` 웹훅으로 **MMIT_OPLINE 전체 라인 동적 로드**, 리스트는 `required-input` 직접 호출, 이동/라벨/적재위치는 기존 AIT_API 재사용 |

## 데이터 흐름
```
자재투입(MMWM_MATINPUT_D, CD_OPLINE + DT_MAKESRT=생산작업예상일)
  ※ NO_MMWM=자재투입번호(POP 자재투입 시 라인별 '일자-순번' 자동채번). 완제품·수량은 MMMO_ORDER_D와 동일(검증).
  × BOM(MMIT_MBOM, QT_UNIT×(1+RT_LOSS))            → 자재투입번호별 부품 필요량
  타임슬롯: 자재투입번호 오름차순 → 1=A,2=B,3=C, 4번째+ 전부 D
  − 생산창고 재고(STIT_STOCK_NOW): 빠른 타임(A)부터 소진(워터폴) → 타임별 부족분(total_qty>0)
  → GET ait/mes/required-input (slot/slot_no/slot_n 포함) → index.html 상단 A/B/C/D 탭으로 표시
  → 피더가 해당 타임 탭에서 박스라벨 스캔 → AIT_API.stockMove(00025→생산창고)
  → STIT_STOCK_NOW 갱신 → 다음 새로고침에 부족분 자동 감소/제거 (완료상태 테이블 불필요)
```
> 자재투입번호 1개뿐인 라인/날짜(예 VC/RC)는 탭이 숨겨지고 기존과 동일하게 단일 리스트로 동작.

## 라인 매핑 (MMIT_OPLINE 권위)
| 라인 | CD_OPLINE | 생산창고 |
|---|---|---|
| VC | 00007 | 00007 |
| RC | 00029 | 00035 |
> 라인 `<select>`는 페이지 로드 시 `ait/mes/oplines` 웹훅이 MMIT_OPLINE 전체(CD_CORP='01')를 반환해 **자동 생성**됨. 라인 추가/변경 시 코드 수정 불필요(웹훅 로드 실패 시 VC·RC로 폴백).

## 배포 (운영 n8n)
READ-ONLY SELECT만 사용 → 운영 DB(`SEIERP_AIT`) 직접 안전. 새 워크플로우라 기존 라우트 무영향.
```bash
# Claude 세션에서 직접 실행하려면 프롬프트에 ! 접두사로:
! python 필요투입_MES/create_required_input.py <N8N_API_KEY>
```
배포 후 테스트:
```bash
curl "https://aitechn8n.ngrok.app/webhook/ait/mes/required-input?line=VC&date=20260626"
```
프론트는 기존 웹앱과 **같은 docroot**에서 서빙해야 함(`../js/api.js`, `../js/mes-auth.js` 참조).

## 검증 완료 (2026-06-26)
- 쿼리: VC 부족 4종(F-CONTACT/BODY YPK/BODY/48W), RC 0종(오늘 재고 충분) — 라이브 정확
- 3-part 네이밍(`SEIERP_AIT.dbo.`) readonly 계정 정상
- 창고이동이 STIT_STOCK_NOW 양쪽 갱신 → 자가정리 설계 성립

## 타임슬롯(A/B/C/D) — 2026-06-29 추가
- 소스를 **MMMO_ORDER_D → MMWM_MATINPUT_D**로 전환(자재투입번호 NO_MMWM 보유, 완제품·수량·부족분 동일 검증).
- 자재투입번호 오름차순 = 투입 순서 → **1=A,2=B,3=C, 4번째 이후 전부 D**(라인당 하루 최대 14건까지 존재 → D에 합침).
- 같은 부품이 여러 타임에 걸치면 **빠른 타임부터 재고 소진(워터폴)** → 타임별 부족분이 중복 없이 분배.
- 프론트: 상단 A/B/C/D 탭(부품수 배지 + 대표 자재투입번호 표시). 스캔/이동은 선택된 타임 기준.
- 검증: VC 20260629=A단일(기존과 일치), RA 20260626=A1·B2·C2·D8종(자재투입 8건→D에 5건 통합).
- **부족 0인 타임도 탭 유지**(2026-06-29): 부족분이 없어 사라지던 슬롯도 `is_empty=1` 메타행으로 반환 → 자재투입번호 순서(A=제일 빠른 번호…)대로 탭이 항상 보이고, 빈 타임은 "부족 없음 ✅"으로 표시. 예) VC 20260630 = A(0032)부족없음·B(0034)·C(0035)·D(0036).

## 웹푸시 알림 (2026-06-29 추가, 출고요청과 완전 분리)
새 **부족 품목이 생기면** 자재팀 기기로 푸시. 구독·발송·상태를 출고요청(`push_subscriptions`)과 분리해 `create_required_input.py` 워크플로에 포함.
- **프론트**: 헤더 ⚙ 설정 → "🔔 알림 켜기"(권한 요청+구독) / "테스트 알림". 서비스워커 `sw-req.js`(스코프 `필요투입_MES/`, 루트 `sw.js`와 분리).
- **구독 저장**: `POST ait/mes/push-subscribe` → MySQL `push_sub_reqinput`(공정문서db). VAPID 키는 shipping과 동일.
- **트리거**: 5분 주기 크론(`CR_Sched`) → 전 라인 오늘~내일 부족분(BOM−생산창고재고) 계산 → 직전 스냅샷(`reqinput_kv` k=`snap`)과 비교 → **새로 생긴 부족품목**이 있으면 최신문구(k=`latest`) 저장 후 payload-less 푸시. SW가 `ait/mes/req-push-latest`로 문구 조회해 알림 표시.
- **중복방지**: 스냅샷 diff로 "새로 생긴" 키만 알림. 첫 실행(스냅샷 없음)은 초기화만(무발송). `new URL()` 미사용(정규식 origin) — n8n Code노드 ReferenceError 무발송 버그 회피.
- **배포 후 최초 1회**: `curl -X POST .../ait/mes/push-init`(테이블 생성). 테스트: `curl -X POST .../ait/mes/push-test`.
- 한계: 단일레벨 BOM·오늘~내일만 감시·구독 삭제 라우트 없음(만료 endpoint는 발송 시 continueOnFail로 무시). iOS는 Safari "홈 화면에 추가" 후에만 알림 가능(16.4+).

## 실적차감 (2026-07-02 추가) — 생산실적 시 필요분 자동 감소
POP에서 **생산실적을 찍으면** 백플러시로 부품이 생산창고에서 소비돼 재고가 떨어진다. 기존식(`BOM×지시 − 생산창고재고`)은 이 재고 하락 때문에 **이미 생산된 부품을 다시 "부족"으로 재출현**시켜 피더가 무한 이동하는 문제가 있었다.
- **수정식**: `부족 = 필요(BOM×지시) − 실적소비 − 생산창고재고` (0 클램프, 슬롯 워터폴 유지). 실적소비와 재고감소가 상쇄돼 루프 제거.
- **실적소비 소스**: `MMWA_WORKACHIEVE_*`(POP 생산실적 테이블). `_H.NO_PRCS/NO_PRCSSUB/NO_PRCSSUB2`(제조지시 공정) = `MMWM_MATINPUT_D`의 동일 컬럼으로 1:1 연결, `_D2.QT_INPUT`(부품별) = 백플러시 자재소비량. `SUM(QT_INPUT)`을 슬롯(라이브)·라인/일자(크론)별로 차감.
- **적용 위치**: `create_required_input.py`의 `BUILD`(required-input 라우트)·`SHORT_SQL`(푸시 크론) 둘 다. 검증 VC 20260702: 실적 전량생산된 48Y(212)/48W(79)가 사라지고 미생산 48YA(40)만 유지. `id=w5JrqxHujUkrzFSE` 재배포 완료.
- **⚠️ 죽은 테이블 주의**: `MMWM_MATINPUT_D_REQ`(QT_REQ)/`_D2`(QT_MATINPUT)는 사문화(2026-06 이후 미갱신), EC판(`MMWM_ECMATINPUT_*`)은 특정라인 전용(VC 미사용). 필요/실투입을 이 계열에서 얻지 말 것 — 실적은 반드시 `MMWA_WORKACHIEVE_*`.

## 알려진 한계 / 추후
- **단일레벨 BOM**(완제품 직속 자품)만 전개. 다단 BOM(서브어셈) 필요 시 재귀 CTE로 확장.
- 4타임 초과분은 D에 합침(타임은 항상 A~D 4칸). E,F… 확장 필요 시 슬롯 CASE 수정.
- 웹훅 인증 none(형제 피더 엔드포인트와 동일). 보호 필요 시 JWT 게이트 추가.
