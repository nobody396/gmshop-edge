import { ZodError } from "zod";
import { requireRestockAuthorization } from "#/features/catalog/server/restock-api";
import { DomainError } from "#/lib/domain-error";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import {
	claimSupplierTopUpJob,
	offerSupplierTopUp,
	recordSupplierTopUpResult,
} from "./topup";

type Fetcher = typeof fetch;
type Options = { now?: number; fetcher?: Fetcher };

// The gateway (SUPPLIER_ALERT_TOKEN) may only post alerts; the Mac runner
// (SUPPLIER_TOPUP_RUNNER_TOKEN) may only claim and report jobs.
async function authorized(
	request: Request,
	env: CloudflareBindings,
	token: string | undefined,
) {
	const db = env.DB;
	if (!db || !token?.trim())
		throw new DomainError("supplier_topup_unavailable", 503, "Unavailable");
	if (request.method !== "POST")
		throw new DomainError("method_not_allowed", 405, "POST only");
	await requireRestockAuthorization(request, db, token);
	if (Number(request.headers.get("content-length") ?? "0") > 2_000_000)
		throw new DomainError("supplier_topup_too_large", 413, "Too large");
	return db;
}

export async function handleSupplierTopUpOffer(
	request: Request,
	env: CloudflareBindings,
	options: Options = {},
) {
	return respond(async () => {
		const db = await authorized(request, env, env.SUPPLIER_ALERT_TOKEN);
		return offerSupplierTopUp(db, await request.json(), options);
	});
}

export async function handleSupplierTopUpClaim(
	request: Request,
	env: CloudflareBindings,
	options: Options = {},
) {
	return respond(async () => {
		const db = await authorized(request, env, env.SUPPLIER_TOPUP_RUNNER_TOKEN);
		return { job: await claimSupplierTopUpJob(db, options.now ?? Date.now()) };
	});
}

export async function handleSupplierTopUpResult(
	request: Request,
	env: CloudflareBindings,
	options: Options = {},
) {
	return respond(async () => {
		const db = await authorized(request, env, env.SUPPLIER_TOPUP_RUNNER_TOKEN);
		return recordSupplierTopUpResult(db, await request.json(), options);
	});
}

async function respond(run: () => Promise<Record<string, unknown>>) {
	try {
		return json({ ok: true, ...(await run()) }, 200);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof ZodError || error instanceof SyntaxError)
			return json({ ok: false, error: "invalid_request" }, 400);
		return json({ ok: false, error: "internal_error" }, 500);
	}
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
