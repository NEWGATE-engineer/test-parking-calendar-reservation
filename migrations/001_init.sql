/* ============================================================
   001_init  初期スキーマ（駐車場予約システム）
   --------------------------------------------------------------
   実行用の正本。対象 DB 内（parking）で実行される前提（DB 作成と
   適用管理は apply.sh が行う）。設計意図・詳細メモは
   docs/database/SQLServerDDL.sql / docs/database/ER図.md を参照。
   スキーマ変更は本ファイルを編集せず、新しい連番ファイル
   （002_*.sql ...）を追加すること。
   - 日時は UTC 保存（DATETIME2 + SYSUTCDATETIME）。表示時に JST 変換。
   - enum 相当は CHECK 制約。重複/近接予約の排他はアプリ側（serializable）で担保。
   - 実行は親→子（外部キー依存順）。
   ============================================================ */

------------------------------------------------------------
-- 1. 会員（USER）
------------------------------------------------------------
CREATE TABLE [User] (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_User_id      DEFAULT NEWSEQUENTIALID(),
    email           NVARCHAR(255)    NOT NULL,
    password_hash   NVARCHAR(255)    NOT NULL,
    name            NVARCHAR(100)    NULL,
    status          VARCHAR(20)      NOT NULL CONSTRAINT DF_User_status  DEFAULT 'active',
    failed_attempts INT              NOT NULL CONSTRAINT DF_User_failed  DEFAULT 0,  -- F1-5 アカウントロック（MVP は User 列で保持）
    lock_until      DATETIME2(3)     NULL,            -- ロック解除時刻（NULL=未ロック）。UTC
    created_at      DATETIME2(3)     NOT NULL CONSTRAINT DF_User_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_User        PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_User_email  UNIQUE (email),
    CONSTRAINT CK_User_status CHECK (status IN ('active','withdrawn'))
);
GO

------------------------------------------------------------
-- 2. 駐車区画（PARKING_SPOT）
------------------------------------------------------------
CREATE TABLE ParkingSpot (
    id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Spot_id  DEFAULT NEWSEQUENTIALID(),
    name        NVARCHAR(100)    NOT NULL,
    occupancy   VARCHAR(20)      NOT NULL CONSTRAINT DF_Spot_occ DEFAULT 'vacant',  -- 表示/availability/物理占有事前判定用の確定値
    CONSTRAINT PK_ParkingSpot    PRIMARY KEY CLUSTERED (id),
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
    CONSTRAINT PK_Reservation PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Resv_user   FOREIGN KEY (user_id) REFERENCES [User](id),
    CONSTRAINT FK_Resv_spot   FOREIGN KEY (spot_id) REFERENCES ParkingSpot(id),
    CONSTRAINT CK_Resv_status CHECK (status IN ('reserved','active','completed','cancelled','no_show','overstay')),
    CONSTRAINT CK_Resv_time   CHECK (end_time > start_time)
);
GO

------------------------------------------------------------
-- 6. 利用記録（USAGE_RECORD）  予約期間内の複数回入出庫
--    open 行（exit_time NULL）の有無が在車・ノーショー判定の真実源
------------------------------------------------------------
CREATE TABLE UsageRecord (
    id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Usage_id DEFAULT NEWSEQUENTIALID(),
    reservation_id  UNIQUEIDENTIFIER NOT NULL,
    entry_time      DATETIME2(3)     NOT NULL,
    exit_time       DATETIME2(3)     NULL,
    CONSTRAINT PK_UsageRecord PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Usage_resv  FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Usage_time  CHECK (exit_time IS NULL OR exit_time > entry_time)
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
    CONSTRAINT PK_Fee        PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_Fee_resv   UNIQUE (reservation_id),   -- 0..1 を担保（完了確定の二重 INSERT 防止）
    CONSTRAINT FK_Fee_resv   FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
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
    request_id           NVARCHAR(100)    NOT NULL,            -- 冪等キー（1送信操作ごとに採番）
    command_type         VARCHAR(10)      NOT NULL,
    issued_at            DATETIME2(3)     NOT NULL CONSTRAINT DF_Cmd_issued DEFAULT SYSUTCDATETIME(),
    result               VARCHAR(10)      NOT NULL CONSTRAINT DF_Cmd_result DEFAULT 'pending',
    device_responded_at  DATETIME2(3)     NULL,
    CONSTRAINT PK_CommandLog  PRIMARY KEY CLUSTERED (id),
    CONSTRAINT UQ_Cmd_request UNIQUE (request_id),            -- 冪等性(F4-7)
    CONSTRAINT FK_Cmd_resv    FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT FK_Cmd_user    FOREIGN KEY (user_id) REFERENCES [User](id),
    CONSTRAINT CK_Cmd_type    CHECK (command_type IN ('DOWN')),
    CONSTRAINT CK_Cmd_result  CHECK (result IN ('pending','success','failure'))
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
    CONSTRAINT PK_DeviceEvent PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Evt_device  FOREIGN KEY (device_id) REFERENCES Device(device_id),
    CONSTRAINT FK_Evt_resv    FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Evt_type    CHECK (event_type IN ('down_exec','up','entry','exit'))
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
    CONSTRAINT PK_Notification PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_Notif_user   FOREIGN KEY (user_id) REFERENCES [User](id),
    CONSTRAINT FK_Notif_resv   FOREIGN KEY (reservation_id) REFERENCES Reservation(id),
    CONSTRAINT CK_Notif_status CHECK (status IN ('queued','sent','failed'))
);
GO

------------------------------------------------------------
-- 11. リフレッシュトークン（REFRESH_TOKEN）  自前 JWT（認証設計§7）
------------------------------------------------------------
CREATE TABLE RefreshToken (
    id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_RT_id      DEFAULT NEWSEQUENTIALID(),
    user_id     UNIQUEIDENTIFIER NOT NULL,
    family_id   UNIQUEIDENTIFIER NOT NULL,            -- 系統失効の単位
    token_hash  VARBINARY(32)    NOT NULL,            -- 平文トークンの SHA-256（ソルト無・決定的）
    expires_at  DATETIME2(3)     NOT NULL,            -- UTC
    revoked_at  DATETIME2(3)     NULL,                -- 失効時刻（NULL=有効）
    created_at  DATETIME2(3)     NOT NULL CONSTRAINT DF_RT_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_RefreshToken PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_RT_user      FOREIGN KEY (user_id) REFERENCES [User](id)
);
GO

/* ===================== インデックス ===================== */

-- 競合チェック（バッファ込み）・availability の範囲検索用(§4.3.2)
CREATE INDEX IX_Reservation_spot_time
    ON Reservation (spot_id, start_time, end_time) INCLUDE (status);
GO

-- マイページの予約・履歴一覧
CREATE INDEX IX_Reservation_user
    ON Reservation (user_id, start_time);
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

-- リフレッシュトークン：token_hash で等値1行引き、family_id で系統一括失効
CREATE UNIQUE INDEX UQ_RefreshToken_hash ON RefreshToken (token_hash);
GO
CREATE INDEX IX_RefreshToken_family ON RefreshToken (family_id);
GO
CREATE INDEX IX_RefreshToken_user   ON RefreshToken (user_id);
GO
