# 一次性代理资格 / One-time agent access

## 中文

此实现只增加两种固定商品与专用开通处理器，不增加会员等级、兑换码、邀请码交付、第二套钱包或 CI 工作流。代理端配套改动必须同时验收；代码合并不代表商品上架或主站限制启用。

### 商品与开关

- 子站：¥199，一次性；API：¥9.90，一次性。不含采购余额，数量固定 1，不能混单、使用优惠券或渠道改价。
- 后台「交付设置」可显式准备两个商品草稿；重复操作不覆盖已有配置，也不会发布商品。
- `agent_access.enabled` 是 GMShop 资格商品结账开关，默认 false，不改变 GMShop 其他商品、lsrai.shop 主站或任何子站注册设置。
- `AGENT_ACCESS_SIGNING_KEY` 为两站专用服务密钥，由 Agent Switch 保存并注入运行时，支持 Workers 绑定及 Bun 环境注入。不写项目 .env、脚本参数、教程、数据库商品内容或日志。
- 商品属于 automation，但由已付款订单的普通交付队列自动执行专用处理器，不需要 GitHub Actions 或客户手动启动任务。不能当作普通 stock 商品导出给下游。

固定商品标识在 `src/features/agent-access/products.ts`。金额使用 CNY 分：19900、990。后续调价必须同时更新此业务约束，不能只改页面显示值。

### 身份与交付

资格购买要求本人已登录且邮箱验证通过。服务端从账号读取邮箱与稳定用户 ID；不能用客户自填邮箱接管另一账号。已有 lsrai.shop 账号在原登录/MFA 后确认绑定；新账号由付款后的可信接口创建。

订单页显示实际开通进度。新账号通过短时单次 fragment 票据设置第一份密码；已有账号直接走原登录路径。普通订单、队列和日志不保存永久密码、API Secret 或激活票据。

子站交付：账号入口、系统域名、店铺/商品默认配置及开店教程。上线前须在代理端配置并审核默认售价、手续费影响和可用支付方式，不替老子站改价。

API 交付：账号入口、approved + active 权限、本人安全领取初始凭证的入口及协议教程。实际第三方系统连接、充值采购和回调测试由客户执行；不能把权限开通宣称为已完成对接。

### 可靠性与人工恢复

- 订单项是业务幂等键，账号+资格的唯一占位阻止并发重复下单。支付与开通记录使用现有 D1 事务；订单快照保存购买时身份。
- `processAgentDelivery` 仅处理已付款的对应订单，复用普通队列。原订单重试不轮换 API 凭证、不重复建店。
- 失败采用持久化间隔重试；8 次后进入后台「交付设置」异常列表，管理员可按原订单重试。后台异常列表不是已发送邮件/飞书通知的承诺。
- 分钟任务补偿丢失队列和退款撤销。退款处理中暂停交付；退款成功后使用相同订单项撤销远端权限。资格订单首版仅支持整单退款，仍走现有管理员权限及真实支付退款流程。
- 已退款但远端未撤销时保留异常并继续补偿，不能显示权限已撤销。撤销来源只指向本单，不能清空老代理资格或另一种资格。
- 草稿准备、异常查询与重试分别检查 products/update、delivery/read、delivery/update 权限；客户访问只接受本人订单与本人开通记录，校验 Origin，私密响应 no-store。

### 发布清单（不自动执行）

1. 完成两仓库测试；先配置服务密钥和代理端开通能力，主站限制保持关闭。
2. 验证新账号、已有账号、旧子站、旧 API、旧申请、双资格、重复请求、退款竞态以及子站游客/注册回归。
3. 老账号无需新 GMShop 订单、绑定或再次付款即可沿原权限使用。核对非标准历史授权，未解决前不收紧主站。
4. 核对新子站默认售价策略（老板已确认加价 5%，仅新开通子站）及本次新增售后告知：成功开通不支持个人原因退款，保留未开通、重复扣款和依法应退例外；不新增资格费返佣。
5. 获得明确授权后再准备生产商品、上架、开启 GMShop 结账。代理主站准入另行启用；不得修改全局注册开关或共享商品游客购买属性。
6. 回退优先关闭新商品结账与主站限制；保留开通记录、撤销补偿和原账号，不回滚或清除账本。

### 本地验证与消融

重点测试：`tests/integration/agent-access.test.ts`、`tests/security/agent-access.test.ts`、全量安装迁移/权限/订单/退款测试，以及代理端 agentaccess integrationtest。

代理端做了真实删除保护逻辑的对照实验：移除子站隔离，子站游客下单和注册测试失败；移除旧资格兼容，老子站代理采购测试失败。实验后恢复原代码并重跑。保留这两道保护；删除的是邀请码/卡密环节、通用会员中台和 CI 中转，而不是安全约束。

## English

Two fixed products use the existing commerce payment, outbox and delivery infrastructure. Both sales and agent main-site restrictions are off by default. Preparing drafts never publishes them. Runtime signing credentials come from Agent Switch only.

A verified purchaser is bound to one agent account. Existing accounts authenticate through their original login/MFA; new accounts set their first password using a short-lived, single-use activation ticket. API credentials are claimed on the agent site, not copied into order text. Stable order-item identifiers make retries idempotent.

Legacy agents require no new payment record. Child-shop registration and checkout policies are not changed. Full refunds revoke only the qualification granted by that order, with durable reconciliation. Production listing, real payment/email tests, and main-site restrictions require separate authorization and acceptance. Configure default storefront pricing and public support terms before launch.

### 资格费条款确认

两种资格统一使用 `agentAccessRefundPolicy` 的版本化双语文案。结账页为本人及当前商品显示非预勾选的独立确认框；`agentAccessTermsAccepted` 仅对资格商品必需，其他商品不增加确认步骤。新增迁移 `0027_agent_access_policy.sql` 为开通订单记录增加可空快照列；新订单保存条款原文、版本和确认时间，不伪造历史订单同意记录。

已确认新条款的资格订单，客户通过“开通异常/争议处理”提出故障和法定诉求，不提供个人原因退款、重发卡密或重跑 CI 的入口。后台人工纠错和依法处理所需的原路退款仍然保留。没有新条款快照的历史订单不被服务器追溯限制。

Both access products require explicit, unchecked purchase acknowledgment. The exact bilingual policy and acceptance time are snapshotted with the order. Personal-reason refunds after successful activation are not offered; failed activation, duplicate charges and legally required remedies retain an exception-support path. Historical orders without the new policy snapshot are not retroactively restricted, and authorized administrative refunds remain available.


### 联合发布验收

本轮老板已明确授权部署、上架这两种资格及邀请返利。5% 加价只初始化新付费子站；资格商品不能使用推广码或产生邀请奖励，已积累奖励作为支付来源时仍按原来源退款。迁移统一排序为 0026/0027（资格）及 0028/0029（推广），已有 0025 保持不变。主站准入限制仍以老代理和子站回归为门槛，且不修改全局注册设置。营销邮件、老客户批量发券和真实支付测试不随部署自动执行。
