-- 浏览器设备编号（gm_device cookie）与登录过它的账号；邀请奖励只在「下单浏览器登录过邀请人账号」时扣下。
CREATE TABLE user_devices (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL,
 first_seen_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 PRIMARY KEY (user_id, device_id)
);
--> statement-breakpoint
CREATE INDEX user_devices_device_idx ON user_devices(device_id);
