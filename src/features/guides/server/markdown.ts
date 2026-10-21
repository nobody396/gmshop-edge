import type { Element, Root, RootContent } from "hast";
import { defaultSchema, sanitize } from "hast-util-sanitize";
import { toHtml } from "hast-util-to-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Server-only: guide markdown → sanitized HTML. Raw HTML in the markdown is
 * dropped (never passed through), the tree is sanitized with the GitHub
 * schema, headings are shifted so the page title stays the only <h1>, and
 * external links are marked nofollow.
 */
const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype, { allowDangerousHtml: false });

const schema = {
	...defaultSchema,
	protocols: {
		...defaultSchema.protocols,
		href: ["http", "https", "mailto"],
		src: ["http", "https"],
	},
};

function isElement(node: RootContent): node is Element {
	return node.type === "element";
}

function adjust(nodes: RootContent[]) {
	for (const node of nodes) {
		if (!isElement(node)) continue;
		if (node.tagName === "h1") node.tagName = "h2";
		if (node.tagName === "a") {
			const href = String(node.properties.href ?? "");
			if (
				/^https?:\/\//i.test(href) &&
				!/^https:\/\/laoshirenvip\.com(\/|$)/i.test(href)
			)
				node.properties.rel = ["nofollow", "noopener", "noreferrer"];
		}
		adjust(node.children as RootContent[]);
	}
}

export function renderGuideMarkdown(markdown: string): string {
	const tree = processor.runSync(processor.parse(markdown)) as Root;
	const clean = sanitize(tree, schema) as Root;
	adjust(clean.children);
	return toHtml(clean);
}
