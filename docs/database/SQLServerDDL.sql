/* ============================================================
   駐車場予約システム  SQL Server / Azure SQL Database  DDL
   対応: ER図（論理名つき） / 要件定義 v5
   --------------------------------------------------------------
   【注意】実行用の正本は /migrations/001_init.sql（apply.sh で適用）。
   本ファイルは設計意図・詳細メモ付きの「設計リファレンス」。
   スキーマ変更時は migrations/ に連番ファイルを追加し、本ファイルの
   該当箇所と ER図.md も更新して整合を保つこと。
   --------------------------------------------------------------
   方針メモ:
   - 主キーは UNIQUEIDENTIFIER + NEWSEQUENTIALID() 既定値（順序性により
     クラスタ化インデックスの断片化を緩和）。アプリ側採番にする場合は別途検討。
   - 日時は UTC 保存（DATETIME2 + SYSUTCDATETIME()）。表示時に JST 変換。
   - enum 相当は CHECK 制約で表現（値の追加が多ければ参照テーブル方式へ切替可）。
   - 退会・削除は論理削除前提（status='withdrawn' 等）。物理削除/保持期間(§12)は別途。
   - 金額は DECIMAL(10,2)。JPY は実質整数のため DECIMAL(10,0) でも可。
   - 'USER' は予約語のため [User] と表記。
   - 重複/近接予約の排他は SQL Server に範囲排他制約が無いため DB では表現せず、
     アプリ側（serializable トランザクション＋競合チェック）で担保する(§4.3.2)。
   - 実行は親→子の順（外部キー依存順）。
   ============================================================ */

------------------------------------------------------------
-- 1. 会員（USER）
------------------------------------------------------------
CREATE TABLE [User] (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_User_id      DEFAULT NEWSEQUENTIALID(),
    email           NVARCHAR(255)    NOT NULL,
    password_hash   NVARCHAR(255)    NOT NULL,
    name            NVARCHAR(100)    NULL,            -- F2-1（メール＋パスワード登録）に合わせ任意
    status          VARCHAR(20)      NOT NULL CONSTRAINT DF_User_status  DEFAULT 'active',
    failed_attempts INT              NOT NULL CONSTRAINT DF_User_failed  DEFAULT 0,  -- ログイン失敗回数（F1-5 アカウントロック。MVP は User 列で保持＝認証設計§6）
    lock_until      DATETIME2(3)     NULL,            -- ロック解除時刻（NULL=未ロック）。UTC
    created_at      DATETIME2(3)     NOT NULL CONSTRAINT DF_User_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_User       PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_User_email UNIQUE (email),
    CONSTRAINT CK_User_status CHECK (status IN ('active','withdrawn'))
);
GO

------------------------------------------------------------
-- 2. 駐車区画（PARKING_SPOT）
------------------------------------------------------------
CREATE TABLE ParkingSpot (
    id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Spot_id  DEFAULT NEWSEQUENTIALID(),
    name        NVARCHAR(100)    NOT NULL,
    occupancy   VARCHAR(20)      NOT NULL CONSTRAINT DF_Spot_occ DEFAULT 'vacant',  -- 確定値
    CONSTRAINT PK_ParkingSpot   PRIMARY KEY CLUSTERED (id),
    CONSTRAINT CK_Spot_occupancy CHECK (occupancy IN ('occupied','vacant'))
);
GO

------------------------------------------------------------
-- 3. AUTOSTAND（DEVICE）  区画と 1:1
------------------------------------------------------------
CREATE TABLE Device (
    device_id        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Device_id    DEFAULT NEWSEQUENTIALID(),
    spot_id          UNIQUEIDENTIFIER NOT NULL,
    plate_position   VARCHAR(10)      NOT NULL CONSTRAINT DF_Device_plate  DEFAULT 'up',
    last_occupancy   VARCHAR(20)      NULL,            -- 生テレメトリ
    last_seen_at     DATETIME2(3)     NULL,            -- 健全性判定に使用(§8)
    CONSTRAINT PK_Device       PRIMARY KEY CLUSTERED (device_id),
    CONSTRAINT UQ_Device_spot  UNIQUE (spot_id),       -- 1:1 を担保
    CONSTRAINT FK_Device_spot  FOREIGN KEY (spot_id) REFERENCES ParkingSpot(id),
    CONSTRAINT CK_Device_plate CHECK (plate_position IN ('up','down'))
);
GO

------------------------------------------------------------
-- 4. 同意記録（CONSENT）
------------------------------------------------------------
CREATE TABLE Consent (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Consent_id DEFAULT NEWSEQUENTIALID(),
    user_id         UNIQUEIDENTIFIER NOT NULL,
    terms_version   NVARCHAR(50)     NOT NULL,
    agreed_at       DATETIME2(3)     NOT NULL CONSTRAINT DF_Consent_at  DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_Consent      PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Consent_user FOREIGN KEY (user_id) REFERENCES [User](id)
);
GO

------------------------------------------------------------
-- 5. 予約（RESERVATION）
------------------------------------------------------------
CREATE TABLE Reservation (
    id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Resv_id      DEFAULT NEWSEQUENTIALID(),
    user_id     UNIQUEIDENTIFIER NOT NULL,
    spot_id     UNIQUEIDENTIFIER NOT NULL,
    start_time  DATETIME2(3)     NOT NULL,             -- UTC
    end_time    DATETIME2(3)     NOT NULL,             -- UTC
    status      VARCHAR(20)      NOT NULL CONSTRAINT DF_Resv_status  DEFAULT 'reserved',
    created_at  DATETIME2(3)     NOT NULL CONSTRAINT DF_Resv_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_Reservation   PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Resv_user     FOREIGN KEY (user_id) REFERENCES [User](id),
    CONSTRAINT FK_Resv_spot     FOREIGN KEY (spot_id) REFERENCES ParkingSpot(id),
    CONSTRAINT CK_Resv_status   CHECK (status IN ('reserved','active','completed','cancelled','no_show','overstay')),
    CONSTRAINT CK_Resv_time     CHECK (end_time > start_time)
);
GO

------------------------------------------------------------
-- 6. 利用記録（USAGE_RECORD）  予約期間内の複数回入出庫
------------------------------------------------------------
CREATE TABLE UsageRecord (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Usage_id DEFAULT NEWSEQUENTIALID(),
    reservation_id  UNIQUEIDENTIFIER NOT NULL,
    entry_time      DATETIME2(3)     NOT NULL,
    exit_time       DATETIME2(3)     NULL,
    CONSTRAINT PK_UsageRecord  PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Usage_resv   FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Usage_time   CHECK (exit_time IS NULL OR exit_time > entry_time)
);
GO

------------------------------------------------------------
-- 7. 料金（FEE）  予約と 0..1
------------------------------------------------------------
CREATE TABLE Fee (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Fee_id     DEFAULT NEWSEQUENTIALID(),
    reservation_id  UNIQUEIDENTIFIER NOT NULL,
    slot_fee        DECIMAL(10,2)    NOT NULL CONSTRAINT DF_Fee_slot   DEFAULT 0,   -- 予約枠料金
    overstay_fee    DECIMAL(10,2)    NOT NULL CONSTRAINT DF_Fee_over   DEFAULT 0,   -- 超過料金
    total           AS (slot_fee + overstay_fee) PERSISTED,                          -- 計算列（常に整合）
    calculated_at   DATETIME2(3)     NULL,
    status          VARCHAR(20)      NOT NULL CONSTRAINT DF_Fee_status DEFAULT 'pending',
    CONSTRAINT PK_Fee       PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_Fee_resv  UNIQUE (reservation_id),   -- 0..1 を担保
    CONSTRAINT FK_Fee_resv  FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Fee_status CHECK (status IN ('pending','confirmed'))
);
GO

------------------------------------------------------------
-- 8. コマンドログ（COMMAND_LOG）  DOWN 指示の監査・冪等
------------------------------------------------------------
CREATE TABLE CommandLog (
    id                   UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Cmd_id     DEFAULT NEWSEQUENTIALID(),
    reservation_id       UNIQUEIDENTIFIER NOT NULL,
    user_id              UNIQUEIDENTIFIER NOT NULL,
    request_id           NVARCHAR(100)    NOT NULL,            -- 冪等キー
    command_type         VARCHAR(10)      NOT NULL,
    issued_at            DATETIME2(3)     NOT NULL CONSTRAINT DF_Cmd_issued DEFAULT SYSUTCDATETIME(),
    result               VARCHAR(10)      NOT NULL CONSTRAINT DF_Cmd_result DEFAULT 'pending',
    device_responded_at  DATETIME2(3)     NULL,
    CONSTRAINT PK_CommandLog   PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_Cmd_request  UNIQUE (request_id),           -- 冪等性(F4-7)
    CONSTRAINT FK_Cmd_resv     FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT FK_Cmd_user     FOREIGN KEY (user_id) REFERENCES [User](id),
    CONSTRAINT CK_Cmd_type     CHECK (command_type IN ('DOWN')),
    CONSTRAINT CK_Cmd_result   CHECK (result IN ('pending','success','failure'))
);
GO

------------------------------------------------------------
-- 9. デバイスイベント（DEVICE_EVENT）  状態遷移の記録
------------------------------------------------------------
CREATE TABLE DeviceEvent (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Evt_id DEFAULT NEWSEQUENTIALID(),
    device_id       UNIQUEIDENTIFIER NOT NULL,
    reservation_id  UNIQUEIDENTIFIER NULL,                     -- 任意（予約に紐づかないイベントもある）
    event_type      VARCHAR(20)      NOT NULL,
    occurred_at     DATETIME2(3)     NOT NULL CONSTRAINT DF_Evt_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_DeviceEvent  PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Evt_device   FOREIGN KEY (device_id) REFERENCES Device(device_id),
    CONSTRAINT FK_Evt_resv     FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Evt_type     CHECK (event_type IN ('down_exec','up','entry','exit'))
);
GO

------------------------------------------------------------
-- 10. 通知ログ（NOTIFICATION）
------------------------------------------------------------
CREATE TABLE Notification (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Notif_id     DEFAULT NEWSEQUENTIALID(),
    user_id         UNIQUEIDENTIFIER NOT NULL,
    reservation_id  UNIQUEIDENTIFIER NULL,                     -- 任意（アカウント系は紐づかない）
    notif_type      NVARCHAR(50)     NOT NULL,
    sent_at         DATETIME2(3)     NULL,
    status          VARCHAR(20)      NOT NULL CONSTRAINT DF_Notif_status DEFAULT 'queued',
    CONSTRAINT PK_Notification  PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Notif_user    FOREIGN KEY (user_id) REFERENCES [User](id),
    CONSTRAINT FK_Notif_resv    FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Notif_status  CHECK (status IN ('queued','sent','failed'))
);
GO

------------------------------------------------------------
-- 11. リフレッシュトークン（REFRESH_TOKEN）  自前 JWT 認証（認証設計§7）
--     SHA-256(ソルト無) で token_hash 保存・ローテーション・family_id 系統失効
------------------------------------------------------------
CREATE TABLE RefreshToken (
    id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_RT_id      DEFAULT NEWSEQUENTIALID(),
    user_id     UNIQUEIDENTIFIER NOT NULL,
    family_id   UNIQUEIDENTIFIER NOT NULL,            -- ログインで採番、ローテーションで引継ぎ（系統失効の単位）
    token_hash  VARBINARY(32)    NOT NULL,            -- 平文トークンの SHA-256（ソルト無・決定的）
    expires_at  DATETIME2(3)     NOT NULL,            -- UTC
    revoked_at  DATETIME2(3)     NULL,                -- 失効時刻（NULL=有効）
    created_at  DATETIME2(3)     NOT NULL CONSTRAINT DF_RT_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_RefreshToken PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_RT_user      FOREIGN KEY (user_id) REFERENCES [User](id)
);
GO

/* ============================================================
   インデックス
   ============================================================ */

-- 競合チェック（バッファ込み・予約作成時の単一区画走査）用(§4.3.2)
-- spot_id で等値→start_time/end_time で範囲、status は被覆のため INCLUDE
CREATE INDEX IX_Reservation_spot_time
    ON Reservation (spot_id, start_time, end_time) INCLUDE (status);
GO

-- GET /spots/availability（全区画一括・spot_id 等値なし）の範囲検索用。migrations/002 で追加。
-- start_time の範囲シーク＋ spot_id/status を被覆（end_time 側は DATEADD のため残余述語）。
CREATE INDEX IX_Reservation_availability
    ON Reservation (start_time, end_time) INCLUDE (spot_id, status);
GO

-- マイページの予約・履歴一覧（status/end_time を被覆してキー参照を回避）
CREATE INDEX IX_Reservation_user
    ON Reservation (user_id, start_time) INCLUDE (status, end_time);
GO

-- 予約ごとの未完了 DOWN を引く（入庫待ちタイムアウト判定／コマンド監査）
CREATE INDEX IX_CommandLog_resv
    ON CommandLog (reservation_id, issued_at);
GO

-- ノーショー判定（入庫記録の有無）
CREATE INDEX IX_UsageRecord_resv
    ON UsageRecord (reservation_id);
GO

-- デバイス健全性の監視（最終通信が古い区画の抽出）
CREATE INDEX IX_Device_lastseen
    ON Device (last_seen_at);
GO

-- デバイスイベントの時系列参照（監査・デバッグ）
CREATE INDEX IX_DeviceEvent_device_time
    ON DeviceEvent (device_id, occurred_at);
GO

-- タイマー走査：ノーショー検知（status='reserved' AND start_time < now-猶予）
CREATE INDEX IX_Reservation_noshow
    ON Reservation (start_time) WHERE status = 'reserved';
GO

-- タイマー走査：超過・自動完了検知（status='active' AND end_time < now）
CREATE INDEX IX_Reservation_overstay
    ON Reservation (end_time) WHERE status = 'active';
GO

-- 通知一覧を会員単位で引く
CREATE INDEX IX_Notification_user
    ON Notification (user_id, sent_at);
GO

-- リフレッシュトークン：token_hash で等値1行引き（ローテーション照合）、family_id で系統一括失効
CREATE UNIQUE INDEX UQ_RefreshToken_hash
    ON RefreshToken (token_hash);
GO
CREATE INDEX IX_RefreshToken_family
    ON RefreshToken (family_id);
GO
CREATE INDEX IX_RefreshToken_user
    ON RefreshToken (user_id);
GO

/* ============================================================
   詳細設計メモ（記録のみ）
   ------------------------------------------------------------
   - 主キー戦略：NEWSEQUENTIALID() で順序性を持たせクラスタ化断片化を緩和。
     代替として「INT/BIGINT IDENTITY をクラスタ化キー、GUID を非クラスタ化 PK」も可。
   - 重複/近接予約：DB の範囲排他は不可。アプリ側で
       WHERE spot_id=@spot
         AND start_time < DATEADD(MINUTE, @bufferMin, @end)
         AND @start     < DATEADD(MINUTE, @bufferMin, end_time)
         AND status NOT IN ('cancelled','no_show')
     を serializable トランザクション内で確認してから INSERT する。
   - 退会/削除：論理削除（[User].status='withdrawn'）。物理削除・保持期間は§12で決定。
   - 金額：DECIMAL(10,2)。JPY 運用なら DECIMAL(10,0) も可。
   - 外部キーの ON DELETE は既定（NO ACTION）。カスケードは採用しない（監査ログ保全）。
   - 状態遷移の競合：すべての状態遷移は「現在状態を WHERE 条件に含めた条件付き UPDATE」で行い、
     更新0件を競合とみなす（タイマーのノーショー確定とユーザーのキャンセルの競合等を防ぐ）。
     必要なら Reservation に rowversion を足して楽観ロックを併用する。
   - [User].name は F2-1（メール＋パスワード登録）に合わせ NULL 許容。登録 UI が氏名を取るなら NOT NULL に変更。
   - FK 索引：Notification(user_id) は追加済み。Consent(user_id) は低頻度のため必要時に追加。
   - total は計算列（PERSISTED）化したため slot_fee/overstay_fee からアプリで再計算・代入しない。
   - 認証（自前 JWT・認証設計§7）：RefreshToken は token_hash(SHA-256 ソルト無) を UNIQUE で等値照合し、
     ローテーションは「WHERE id=@id AND revoked_at IS NULL の条件付き UPDATE が1件成功した側のみ新ペア発行」
     とする（状態遷移と同じ原則）。失効済み再使用検知時は family_id で系統一括失効。
     期限切れ/失効済み行はタイマー Functions cleanupTokens で定期 DELETE（テーブル肥大防止）。
   - アカウントロック（F1-5）：失敗回数・ロック時刻は MVP では [User].failed_attempts / lock_until で保持。
     キャッシュ運用や専用テーブルに移す場合は本2列を廃し別管理に切り替える（認証設計§6）。
   ============================================================ */