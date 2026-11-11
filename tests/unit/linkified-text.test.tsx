import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LinkifiedText } from "#/features/storefront/components/linkified-text";

describe("product description links", () => {
	it("turns https URLs into links and leaves the rest as text", () => {
		const html = renderToStaticMarkup(
			<LinkifiedText text="看各区价格对比：https://laoshirenvip.com/guides/appstore-prices。<b>不解析</b> http://x.example" />,
		);
		expect(html).toContain(
			'<a class="break-all text-primary underline underline-offset-4" href="https://laoshirenvip.com/guides/appstore-prices" rel="noopener">https://laoshirenvip.com/guides/appstore-prices</a>。',
		);
		expect(html).toContain("&lt;b&gt;不解析&lt;/b&gt; http://x.example");
		expect(html.match(/<a /g)?.length).toBe(1);
	});
});
