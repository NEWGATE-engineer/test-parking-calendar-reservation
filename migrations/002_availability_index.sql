/* ============================================================
   002_availability_index  availability 用の被覆インデックス
   --------------------------------------------------------------
   GET /spots/availability は全区画の予約を1クエリで取得する（spot_id 等値述語が無い）。
   既存 IX_Reservation_spot_time は先頭キーが spot_id のためこのクエリには効かない。
   start_time の範囲シーク＋ spot_id/status の被覆で、予約件数増加時のフルスキャンを避ける。
   （end_time 側は DATEADD のため非 sargable な残余述語評価になる）
   設計リファレンス: docs/database/SQLServerDDL.sql の同名インデックスと整合。
   ============================================================ */
CREATE INDEX IX_Reservation_availability
    ON Reservation (start_time, end_time) INCLUDE (spot_id, status);
GO
