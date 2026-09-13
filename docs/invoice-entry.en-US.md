# Independent invoice entry

Invoice requests stay on `/invoice` on the VIP storefront. Both navigation and order links are same-origin. A bounded, rate-limited server endpoint calls the shared invoice service; no browser cookies or auth headers are forwarded. VIP offline applications retain `laoshirenvip.com` as their source and VIP payment returns use that same domain. lsrai.shop keeps its existing independent page. No additional database or notification pipeline is introduced.
