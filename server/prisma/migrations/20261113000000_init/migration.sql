-- Journal init (design Decision J5). The shared sequence comes first: every table's `seq` default uses it.
CREATE SEQUENCE journal_seq;

-- CreateTable
CREATE TABLE "orders" (
    "id" BIGSERIAL NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT nextval('journal_seq'::regclass),
    "record_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ts" BIGINT NOT NULL,
    "order_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "qty" BIGINT NOT NULL,
    "price" BIGINT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" BIGSERIAL NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT nextval('journal_seq'::regclass),
    "record_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ts" BIGINT NOT NULL,
    "market_ts" BIGINT NOT NULL,
    "order_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "qty" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL,
    "remaining" BIGINT NOT NULL,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rejections" (
    "id" BIGSERIAL NOT NULL,
    "seq" BIGINT NOT NULL DEFAULT nextval('journal_seq'::regclass),
    "record_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ts" BIGINT NOT NULL,
    "order_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "rejections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_record_id_key" ON "orders"("record_id");

-- CreateIndex
CREATE INDEX "orders_account_id_session_id_ts_seq_idx" ON "orders"("account_id", "session_id", "ts", "seq");

-- CreateIndex
CREATE INDEX "orders_account_id_ts_seq_idx" ON "orders"("account_id", "ts", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "fills_record_id_key" ON "fills"("record_id");

-- CreateIndex
CREATE INDEX "fills_account_id_session_id_ts_seq_idx" ON "fills"("account_id", "session_id", "ts", "seq");

-- CreateIndex
CREATE INDEX "fills_account_id_ts_seq_idx" ON "fills"("account_id", "ts", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "rejections_record_id_key" ON "rejections"("record_id");

-- CreateIndex
CREATE INDEX "rejections_account_id_session_id_ts_seq_idx" ON "rejections"("account_id", "session_id", "ts", "seq");

-- CreateIndex
CREATE INDEX "rejections_account_id_ts_seq_idx" ON "rejections"("account_id", "ts", "seq");
