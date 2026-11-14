-- 只报价规格（contact_only）：前台照常显示价格和阶梯价，但不能加购、不能下单，按钮改成"联系客服购买"。
-- 下单拦截完全复用 sale_disabled：contact_only = 1 的规格永远同时 sale_disabled = 1，
-- 所以购物车、下单、续费、代理供货 API、代理卡网同步这些已有的禁售检查全部自动生效。
-- 下面两个触发器保证这个约束：后台、运维接口或自动起售任务把 sale_disabled 改回 0 时会被立即改回 1。
-- 想恢复在线销售：先把 contact_only 改成 0，再起售。
ALTER TABLE product_sellable_items ADD COLUMN contact_only INTEGER NOT NULL DEFAULT 0 CHECK (contact_only IN (0, 1));
--> statement-breakpoint
CREATE TRIGGER product_sellable_items_contact_only_insert
AFTER INSERT ON product_sellable_items
WHEN NEW.contact_only = 1 AND NEW.sale_disabled = 0
BEGIN
 UPDATE product_sellable_items SET sale_disabled = 1 WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER product_sellable_items_contact_only_update
AFTER UPDATE OF contact_only, sale_disabled ON product_sellable_items
WHEN NEW.contact_only = 1 AND NEW.sale_disabled = 0
BEGIN
 UPDATE product_sellable_items SET sale_disabled = 1 WHERE id = NEW.id;
END;
