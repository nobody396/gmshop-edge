# Independent invoice entry

VIP 商城的发票申请留在本站 `/invoice`，导航和订单入口均不跨站。服务端通过限流、限制请求大小的接口复用统一开票服务，不转发浏览器 Cookie 或身份令牌。VIP 无订单代开申请保留 laoshirenvip.com 来源，付款后也返回 VIP。lsrai.shop 保留原独立页面，不新建数据库或重复通知流程。
