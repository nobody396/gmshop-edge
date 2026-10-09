# Account order date hydration

The account overview and order list share OrderLink. Its date text previously used the process time zone on the server and the browser time zone on hydration, producing React 418 across time zones.

Reuse TanStack Router useHydrated: render order dates in UTC on the server and first client render, then retain the existing browser-local presentation after hydration. Keep the selected language. Do not change stored timestamps, reward eligibility, global formatter defaults or suppress hydration warnings.

The regression test renders the real AccountOverviewPage on the server, hydrates the same snapshot with a different implicit time zone, checks onRecoverableError stays empty, and verifies the final browser-local text in English/Chinese and New York/Shanghai. The original failing diff was 2026-10-09 03:30:28 versus 2026-10-08 23:30:28. No new component, dependency, provider or persistent preference is needed.
