-- 分站按期服务：每单记录是否续费，以及开通/续费后的到期时间（毫秒，lsrai.shop 回报）。
ALTER TABLE agent_access_orders ADD COLUMN renewal INTEGER NOT NULL DEFAULT 0 CHECK(renewal IN (0,1));
ALTER TABLE agent_access_orders ADD COLUMN term_expires_at INTEGER;
-- 已完成或撤销的单不再占用「同类进行中订单」锁，否则同一账号永远不能续费。
UPDATE agent_access_orders SET active_key=NULL WHERE state IN ('active','revoked','cancelled');
