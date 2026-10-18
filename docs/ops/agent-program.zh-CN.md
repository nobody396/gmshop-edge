# 代理管理（GMShop → agent-shop）

老板在 `/admin/agents` 查看代理销售、已交开通费、返还、排行榜审核和待打款。
仅启用的 `root` / `admin` 用户可用，读取需 `operations:read`，修改还需
`operations:update`。界面和代理中心读取同一份上游规则，不另写一套规则。
上游暂未提供本站利润，因此不把代理利润当本站利润显示。

## 密钥与操作边界

Worker secret 名为 **`AGENT_SHOP_PROGRAM_TOKEN`**，对应 agent-shop 的
`reseller.program.internal_api_token`。仅服务端请求固定地址
`https://lsrai.shop/api/internal/reseller-program/`，缺失密钥时拒绝请求。
Bun 运行时支持同名注入。密钥只通过 Agent Switch 及部署环境的密钥注入流程配置，
不写 Wrangler vars、项目 `.env`、文档、源码或日志。本次不配真实密钥、不部署。

修改已交开通费必须填原因，操作者由服务端按登录用户生成
`gmshop:<用户 id>`，上游审计记录旧值、新值、操作者和原因。
「记录已打款」必须填支付宝交易号；请先核对实际转账，它只登记结果，不发起转账。
商城新分站订单履约发送订单真实 `paid_minor` 对应的精确小数字符串 `paidAmount`，
不以当前标价替代实付金额，API 代理订单不写开通费。

## 验证与回滚

运行代理管理相关安全/UI 测试、代理开通集成测试、类型检查和 Worker 构建。
不做真实支付、邮件、Telegram 测试。撤销本 PR 即可移除入口和调用，无 GMShop
数据库迁移；保留未使用的 Worker secret 也不影响旧版运行。
