-- 手工添加的包裹：同步时即使渠道未返回也必须保留（与 Android 侧一致：合并写入、从不删除）
ALTER TABLE items ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
