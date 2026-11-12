-- 两篇已发布指南的摘要太短（<50 字），Bing 报"描述过短"。只在内容仍是原文时改写，
-- 后台若已改过就不动；revision +1 让运维接口的乐观锁看到变化；updated_at 不动，页面上的
-- "更新于"日期保持原样（正文没变）。
UPDATE guides
SET description = 'ChatGPT 额度（Credits）是套餐用量用完后继续用于 Codex 等功能的官方额度，必须是 Plus 或 Pro 账号，Free 不能买也不能用。本文列出 250 到 2500 四个档位，讲清额度和会员订阅的关系、用完后怎么补买、兑换步骤和到账后不退换的规则。',
  revision = revision + 1
WHERE slug = 'chatgpt-credits-explained'
  AND description = '介绍本站额度的四个档位、账号要求、兑换步骤，以及额度与会员充值的关系，并列出售后和不保的情况。';
--> statement-breakpoint
UPDATE guides
SET description = '智利区 ChatGPT Pro 有 Pro 100 和 Pro 500 两档，不支持覆盖，账号须是 Free 且没有 Go、Plus、Pro 订阅，Team 账号要先退出，手机渠道订阅到期后等 2–3 天。本文对比智利区与菲区、iOS 规格的覆盖规则和质保，附下单兑换步骤和售后范围。',
  revision = revision + 1
WHERE slug = 'chatgpt-chile-pro'
  AND description = '对比智利区与菲区、iOS 规格在覆盖规则和账号状态上的差异，并附下单兑换步骤和售后范围。';
