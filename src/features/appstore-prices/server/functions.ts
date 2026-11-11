import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { getDb } from "#/server/db.server";
import { loadAppStoreSnapshot } from "./store";

/** Latest stored comparison, or null before the first daily run. */
export const getAppStorePricesFn = createServerFn({ method: "GET" }).handler(
	async () => loadAppStoreSnapshot(getDb(getRequest()).$client),
);
