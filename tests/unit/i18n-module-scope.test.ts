import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { discardPreRegistrationLocaleCookie } from "#/lib/i18n-runtime";

function sourceFiles(directory: string, files: string[] = []) {
	for (const entry of readdirSync(directory)) {
		if (entry === "paraglide" || entry === "routeTree.gen.ts") continue;
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) sourceFiles(path, files);
		else if (/\.tsx?$/.test(entry)) files.push(path);
	}
	return files;
}

function moduleScopeLocaleCalls(path: string) {
	const source = ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const offenders: string[] = [];
	const visit = (node: ts.Node) => {
		// Anything inside a function or class body runs later, at render time.
		if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
		if (ts.isCallExpression(node)) {
			const callee = node.expression.getText(source);
			if (/^m\.\w+$/.test(callee) || callee === "getLocale")
				offenders.push(
					`${relative(process.cwd(), path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${callee}()`,
				);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return offenders;
}

describe("locale resolution order", () => {
	it("never resolves a message or locale while modules are still loading", () => {
		// A module-scope m.*() runs before the system-default client strategy is
		// registered, resolves the base locale (en-US), and Paraglide persists it
		// as a cookie — every default-language visitor then flips to English.
		const offenders = sourceFiles("src").flatMap(moduleScopeLocaleCalls);
		expect(offenders).toEqual([]);
	});

	it("drops a language cookie guessed before the system default was known", () => {
		const doc = {
			cookie: "theme=dark; PARAGLIDE_LOCALE=en-US",
			documentElement: { lang: "zh-CN" },
		} as unknown as Document;
		const writes: string[] = [];
		Object.defineProperty(doc, "cookie", {
			get: () => "theme=dark; PARAGLIDE_LOCALE=en-US",
			set: (value: string) => writes.push(value),
		});
		expect(discardPreRegistrationLocaleCookie(doc, false)).toBe(true);
		expect(writes).toEqual(["PARAGLIDE_LOCALE=; path=/; max-age=0"]);
	});

	it("keeps a language the visitor chose before this page load", () => {
		const doc = {
			cookie: "PARAGLIDE_LOCALE=en-US",
			documentElement: { lang: "zh-CN" },
		} as unknown as Document;
		expect(discardPreRegistrationLocaleCookie(doc, true)).toBe(false);
		expect(discardPreRegistrationLocaleCookie(doc, undefined)).toBe(false);
		expect(doc.cookie).toBe("PARAGLIDE_LOCALE=en-US");
	});

	it("keeps a cookie that matches the server-rendered language", () => {
		const doc = {
			cookie: "PARAGLIDE_LOCALE=zh-CN",
			documentElement: { lang: "zh-CN" },
		} as unknown as Document;
		expect(discardPreRegistrationLocaleCookie(doc, false)).toBe(false);
		expect(doc.cookie).toBe("PARAGLIDE_LOCALE=zh-CN");
	});
});
