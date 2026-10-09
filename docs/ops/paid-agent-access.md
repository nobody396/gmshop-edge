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

### D1 远程迁移兼容

发布时确认 D1 远程 `/query` 对触发器内未加括号的 `CASE … END` 报 `incomplete input`，本地 SQLite/Miniflare 不会复现。0028/0029 的每个 CASE 表达式仅增加括号，账本条件和金额逻辑不变；没有移除任何资金约束。对应上游问题：https://github.com/cloudflare/workers-sdk/issues/4727 。

修复后已使用一次性远程 D1 库，通过同一 Wrangler `migrations apply --remote` 路径从空库执行全部 28 个迁移并校验外键；测试库已删除。生产失败的 0028 已确认整批回滚（新增字段、触发器和迁移记录均不存在），已成功的 0026/0027 保留，不重跑或删除生产表。静态回归测试约束括号和 LF 换行，业务回归继续验证退款、结算和资格联动。

为避免已安装 v1.24.0 的 Bun 实例升级时被“已执行迁移变更”保护误拦，仅允许这两份迁移的精确旧 SHA-256 与精确新 SHA-256 等价组合；保留原执行记录，不重放 ALTER、不改余额。额外测试从旧原文完整建库后升级，确认无迁移重放、余额不变，未知校验值依旧被拒绝。

### 邮箱直购（2026-10-08） / Email-first purchase

资格商品页及结账页提供邮箱验证码入口。复用 Better Auth 六位 OTP（10 分钟、3 次错误上限、D1 限流），验证后自动创建普通购物客户或登录已有购物客户。仅两个固定 SKU 且 `agent_access.enabled=true` 的请求开启此注册能力；普通验证码登录仍不创建账号。邮件发送走原事务通知队列；新入口同样保留 Turnstile。停用账号及后台角色不得借此进入；已验证会话不重复验证。lsrai.shop 公共注册、旧账号登录和子站策略保持不变。

新代理账号仅在已付款交付阶段创建。初始化密码由安全随机数生成，在 GMShop 专用字段以用途隔离的 AES-GCM 密文保存后才调用签名接口；重试复用同一份，绝不重置已有账号。代理端仅保存 bcrypt 哈希。订单本人主动查看时远端再次确认密码未变更，才短暂显示初始密码；修改后不再显示。老订单保留原激活链接兼容，新订单直接登录并提示首次登录后修改密码。API Secret 仍在代理端原安全入口领取。

No second auth system, OTP table, guest-order system, wallet, or password-reset service. Existing customer credentials are never overwritten. The dedicated encrypted initial-password column is not general delivery text, email, audit data, or a queue payload. Payment and one-time entitlement idempotency remain unchanged. Human checks, email delivery and payment providers must not be faked as production completion.

本次消融验收：关闭仅资格购买的 OTP 注册选项，新邮箱验证码链路测试失败；移除传入初始密码初始化，代理端密码交付测试失败。恢复后通过。前端移除了资格订单重复的联系邮箱、不可用的优惠码框与游客无效检查按钮；保留验证码限流、防机器人、原账号绑定与付款幂等。没有增加第二套注册/邮件/支付服务。

初始密码展示绑定当前购物会话；退出或切换账号即卸载展示组件，按用户隔离缓存。退款撤销、远端确认密码已更改时清除本单保存的初始密码密文。不得把这一展示入口改成仅凭邮箱或订单号读取。


普通登录页另有折叠的“代理资格订单：邮箱验证码登录”入口，复用同一验证组件并安全跳回原订单。购买开关关闭时禁止验证码新注册，但仍允许已存在的普通购物账号验证登录、读取订单；停用或后台账号仍被拒绝。不修改全局普通验证码登录配置，不要求客户记住第二份商城密码。

### 结账消融与 Workers 传输修复

资格检查与付费交付的桥接原使用 `redirect: "error"`，实际 workerd 会在请求发出前抛 TypeError；仅用 Node fetch mock 的测试无法捕获。改成 `manual` 并保留非 2xx 拒绝，不跟随重定向、不转发签名给其他站点。新增真实 workerd 执行实际 client 模块的测试；原参数必失败，修复后正常请求成功、302 仍被拒绝。

资格结账复用同一资格查询缓存，未通过、失败、检查中、已有资格或待绑定均禁用提交，服务端原有校验仍保留。一个非预勾选的确认项同时覆盖订单、购买、开通和售后；原政策快照不变。零优惠/零余额不展示；资格商品只留余额抵扣开关，足额时使用原余额结算路径、不再重复选“余额支付”，不足额时选外部差额支付。普通商品渠道定价、优惠券、奖励优先顺序、余额账本和幂等扣款不改。

验证码发送成功后隐藏已消费的真人验证，直接进入输入验证码；仅失败或主动重发才重新挑战。Better Auth 自带会话刷新，删除额外整页 reload；购物车、钱包和资格查询按账号隔离，避免切换账号复用旧缓存。保留明确的邮箱不可投递/限流/真人过期提示，不把所有错误都说成“过于频繁”。

The access checkout shares one eligibility query with the compact status panel and fails closed before submission. A single explicit acknowledgment retains the existing backend policy snapshot. Presentation-only balance consolidation uses the original full/mixed balance paths for fixed access SKUs; no ledger or coupon logic changes. Real workerd transport coverage replaces the previous false confidence from Node-only fetch mocks. Email code sign-in remains in place with account-scoped queries; CAPTCHA is renewed only for another send, not merely to enter the received code.

### Workers 后台事件上下文 / Background event context

真实余额支付验收发现：网页资格检查处于运行时上下文内，但原 Worker `queue` / `scheduled` 直接指向处理器，导致自动交付及补偿调用签名桥接时读不到绑定。两个后台入口现与 `fetch` 一样使用现有 `adaptCloudflareEnv` 和 `runWithRuntimeEnv`，不增加服务层、不传递客户密钥、不修改钱包/权限逻辑。回归从实际 Worker 入口经过异步边界执行实际签名客户端；删除任一入口包装即对应测试失败。已付款订单仅从原交付记录重试，不重新下单扣款。

Cloudflare queue and scheduled handlers must enter the same existing runtime context as fetch. Entry-point regression tests execute the real signed bridge client after an asynchronous boundary and verify bindings do not leak outside the event. Recovery reuses the original paid order and delivery record; it must not create another charge.

### 明确选择余额支付 / Explicit wallet payment

根据实际验收反馈，两个资格商品的支付区始终显示“余额支付”卡片，与支付宝、USDT 并列，零余额时仍显示但禁用并注明不足。余额足额默认选择余额；用户可明确切换至外部支付全额付款。删除资格商品的余额抵扣开关、零元外部差额及自动隐藏支付方式逻辑。余额卡复用既有奖励优先的钱包结算，不传外部通道、不创建支付宝/USDT 支付单；余额变化后前端禁止提交，服务端原有余额及幂等约束继续生效。普通商品的组合支付保持不变。

Access products expose one explicit wallet radio card beside external methods, including a disabled insufficient-balance state. Selecting wallet reuses the existing reward-aware balance-only checkout with no external channel. Selecting an external method charges its full quoted total with no implicit wallet deduction. Ordinary merchandise split-tender behavior is unchanged.
