# Independent invoice entry

VIP 发票申请留在本站 `/invoice`，导航和订单入口不跨站。页面利用现有 CORS 策略调用统一公开开票 API，明确不携带 Cookie 或身份凭证。VIP 无订单申请保留本站来源，付款后返回 laoshirenvip.com。lsrai.shop 保留独立页面，不新增转发代理、数据库、身份系统或通知流水线。

## 提交失败处理

先检查 HTTP 和业务状态，再解析成功发票字段。业务失败可能返回 HTTP 200、非零 status_code，以及只含 request_id 的 data 对象；应显示业务错误而非 Zod 内部报告。异常成功响应显示本地化通用错误。创建失败时可能已存在待付款申请：GMShop 重试必须核对相同开票资料，复用原申请编号及金额，且不能覆盖已到账回调。
