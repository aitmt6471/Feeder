-- ============================================================
-- MES 필요투입품목리스트 — 라이브 부족분 + 타임슬롯(A/B/C/D)
-- 입력: @line(라인명 NM_OPLINE 예 'VC','RC'), @dt(생산작업예상일 YYYYMMDD)
-- 출력: 자재투입번호(NO_MMWM)별 완제품 BOM 전개 − 생산창고 재고 = 부족분(>0), 타임슬롯 부여
-- 원천: SEIERP_AIT (MSSQL, READ-ONLY SELECT만 사용)
-- ★ 소스 = MMWM_MATINPUT_D(자재투입). NO_MMWM = 자재투입번호(라인별 '일자-순번', POP 자재투입 시 자동채번).
--    DT_MAKESRT = 생산작업예상일. 완제품·수량은 제조지시 MMMO_ORDER_D와 동일(검증 2026-06-29).
-- ★ 타임슬롯: 라인+생산일의 자재투입번호 오름차순 → 1=A,2=B,3=C, 4번째 이후 전부 D(합침).
-- ★ 같은 부품이 여러 타임에 걸치면 빠른 타임(A)부터 재고 소진(워터폴) → 타임별 부족분.
--    단일 타임(자재투입번호 1개)이면 기존 단순계산과 동일.
-- ★ 실적차감(2026-07-02): 부족 = 필요(BOM×지시) − 실적소비 − 생산창고재고.
--    실적소비 = SUM(MMWA_WORKACHIEVE_D2.QT_INPUT), NO_PRCS/SUB/SUB2로 자재투입에 연결.
--    (POP 생산실적 백플러시가 재고를 깎아 부족이 재출현하던 루프 제거)
-- 단일레벨 BOM 전개(완제품 직속 자품). 다단 BOM은 추후 확장.
-- ============================================================
DECLARE @line NVARCHAR(50)='VC';
DECLARE @dt   NVARCHAR(8) ='20260629';

DECLARE @opline NVARCHAR(20), @wh NVARCHAR(20);
SELECT @opline=CD_OPLINE, @wh=CD_WAREHOUSE
FROM MMIT_OPLINE WHERE CD_CORP='01' AND NM_OPLINE=@line;

;WITH wo AS (   -- 해당 라인의 생산예상일 자재투입 완제품 + 자재투입번호 + 제조지시 공정키
  SELECT d.NO_MMWM, d.NO_PRCS, d.NO_PRCSSUB, d.NO_PRCSSUB2, d.CD_SYSITEM AS prod, d.QT_ORDER
  FROM MMWM_MATINPUT_D d
  WHERE d.CD_OPLINE=@opline AND LEFT(d.DT_MAKESRT,8)=@dt
),
slot AS (       -- 자재투입번호 → 타임슬롯(1=A,2=B,3=C,4+=D)
  SELECT NO_MMWM,
         CASE WHEN DENSE_RANK() OVER (ORDER BY NO_MMWM) >= 4 THEN 4
              ELSE DENSE_RANK() OVER (ORDER BY NO_MMWM) END AS sr
  FROM (SELECT DISTINCT NO_MMWM FROM wo) x
),
sm AS (         -- 슬롯 메타: 대표 자재투입번호 + 통합건수
  SELECT sr, MIN(NO_MMWM) AS first_no, COUNT(*) AS n_batch FROM slot GROUP BY sr
),
need AS (       -- 타임슬롯 × 자품별 필요량 = Σ(소요량×(1+로스)×지시수량)
  SELECT s.sr, b.CD_SYSITEMCHILD AS child,
         SUM(b.QT_UNIT*(1+b.RT_LOSS)*wo.QT_ORDER) AS need_qty
  FROM wo JOIN slot s ON s.NO_MMWM=wo.NO_MMWM
          JOIN MMIT_MBOM b ON b.CD_SYSITEM=wo.prod
  GROUP BY s.sr, b.CD_SYSITEMCHILD
),
prcs AS (       -- 슬롯별 제조지시 공정키(실적 연결용, 중복제거)
  SELECT DISTINCT s.sr, wo.NO_PRCS, wo.NO_PRCSSUB, wo.NO_PRCSSUB2
  FROM wo JOIN slot s ON s.NO_MMWM=wo.NO_MMWM
),
cons AS (       -- 슬롯 × 자품별 실적소비 = Σ(생산실적 백플러시 자재투입 QT_INPUT)
  SELECT p.sr, d2.CD_SYSITEM AS child, SUM(d2.QT_INPUT) AS used
  FROM MMWA_WORKACHIEVE_H h
  JOIN MMWA_WORKACHIEVE_D2 d2 ON d2.NO_MMWA=h.NO_MMWA
  JOIN prcs p ON p.NO_PRCS=h.NO_PRCS AND p.NO_PRCSSUB=h.NO_PRCSSUB AND p.NO_PRCSSUB2=h.NO_PRCSSUB2
  GROUP BY p.sr, d2.CD_SYSITEM
),
net AS (        -- 실적차감 후 잔여 필요량 = 필요 − 실적소비
  SELECT n.sr, n.child, n.need_qty, n.need_qty-ISNULL(c.used,0) AS net_qty
  FROM need n LEFT JOIN cons c ON c.sr=n.sr AND c.child=n.child
),
stk AS (        -- 생산창고 현재고 (자품별 합)
  SELECT CD_SYSITEM, SUM(QT_STOCK) AS stock
  FROM STIT_STOCK_NOW WHERE CD_WAREHOUSE=@wh GROUP BY CD_SYSITEM
),
calc AS (       -- 슬롯 순서대로 누적필요(net) → 워터폴 재고차감 준비
  SELECT nt.sr, nt.child, nt.need_qty, nt.net_qty,
         SUM(nt.net_qty) OVER (PARTITION BY nt.child ORDER BY nt.sr
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum,
         ISNULL(s.stock,0) AS stock
  FROM net nt LEFT JOIN stk s ON s.CD_SYSITEM=nt.child
),
fin AS (        -- 워터폴 부족분 = 누적부족 − 직전까지 누적부족
  SELECT c.sr, c.child, c.need_qty, c.stock,
         (CASE WHEN c.cum-c.stock>0 THEN c.cum-c.stock ELSE 0 END)
       - (CASE WHEN (c.cum-c.net_qty)-c.stock>0 THEN (c.cum-c.net_qty)-c.stock ELSE 0 END) AS total_qty
  FROM calc c
)
-- ① 부족 부품(total_qty>0)
SELECT
  i.CD_ITEM                              AS sub_part_no,   -- 부품코드(사용자 품번)
  i.NM_ITEM                              AS part_name,     -- 품명
  i.TX_SPEC                              AS spec,          -- 규격
  f.child                                AS sysitem,       -- 내부 품목ID(이동/라벨매칭용)
  f.sr                                   AS slot_rank,     -- 1=A,2=B,3=C,4=D
  sm.first_no                            AS slot_no,       -- 대표 자재투입번호
  sm.n_batch                             AS slot_n,        -- 이 슬롯에 통합된 자재투입번호 수
  f.need_qty                             AS need_qty,      -- 이 타임 필요수량
  f.stock                                AS prod_stock,    -- 생산창고 재고
  f.total_qty                            AS total_qty,     -- 부족분
  @line                                  AS line_name,
  @wh                                    AS in_wh,         -- 생산창고(이동 목적지)
  0                                      AS is_empty
FROM fin f
JOIN BSIT_ITEM i ON i.CD_SYSITEM=f.child
JOIN sm ON sm.sr=f.sr
WHERE f.total_qty > 0
UNION ALL
-- ② 부족 0인 타임슬롯도 탭이 사라지지 않게 메타만 반환(is_empty=1)
SELECT '', '', '', '', sm.sr, sm.first_no, sm.n_batch, 0, 0, 0, @line, @wh, 1
FROM sm
WHERE sm.sr NOT IN (SELECT sr FROM fin WHERE total_qty > 0)
ORDER BY slot_rank, total_qty DESC;
