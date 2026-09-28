import type { SupportAttachment } from "./web-support-attachments";
export type WebSupportLocalMessage = {
	id: string;
	role: "customer" | "support";
	text: string;
	createdAt: number;
	sequence?: number;
	attachment?: SupportAttachment;
};

type WebSupportIdentity = {
	id: "identity";
	visitorId: string;
	privateKey: CryptoKey;
	publicKeyJwk: JsonWebKey;
	conversationId?: string;
};

type EncryptedReply = {
	id: string;
	sequence: number;
	algorithm: string;
	wrapped_key: string;
	iv: string;
	ciphertext: string;
	created_at: number;
};

const databaseName = "gmshop-web-support";

export async function getWebSupportIdentity() {
	const database = await openDatabase();
	const existing = await request<WebSupportIdentity | undefined>(
		database.transaction("state").objectStore("state").get("identity"),
	);
	if (existing) return existing;
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		false,
		["encrypt", "decrypt"],
	)) as CryptoKeyPair;
	const identity: WebSupportIdentity = {
		id: "identity",
		visitorId: crypto.randomUUID(),
		privateKey: pair.privateKey,
		publicKeyJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
	};
	await transaction(database, "state", (store) => store.put(identity));
	return identity;
}

export async function setWebSupportConversationId(conversationId: string) {
	const identity = await getWebSupportIdentity();
	identity.conversationId = conversationId;
	const database = await openDatabase();
	await transaction(database, "state", (store) => store.put(identity));
}

export async function loadWebSupportMessages() {
	const database = await openDatabase();
	return request<WebSupportLocalMessage[]>(
		database.transaction("messages").objectStore("messages").getAll(),
	).then((messages) =>
		messages.sort((left, right) => left.createdAt - right.createdAt),
	);
}

export async function saveWebSupportMessage(message: WebSupportLocalMessage) {
	const database = await openDatabase();
	await transaction(database, "messages", (store) => store.put(message));
}

export async function decryptWebSupportReply(
	identity: WebSupportIdentity,
	conversationId: string,
	reply: EncryptedReply,
) {
	if (reply.algorithm !== "RSA-OAEP-256+A256GCM")
		throw new Error("Unsupported reply envelope");
	const rawKey = await crypto.subtle.decrypt(
		{ name: "RSA-OAEP" },
		identity.privateKey,
		fromBase64Url(reply.wrapped_key),
	);
	const contentKey = await crypto.subtle.importKey(
		"raw",
		rawKey,
		"AES-GCM",
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64Url(reply.iv),
			additionalData: new TextEncoder().encode(
				`${conversationId}:${reply.sequence}`,
			),
		},
		contentKey,
		fromBase64Url(reply.ciphertext),
	);
	return new TextDecoder().decode(plaintext);
}

function openDatabase() {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const opening = indexedDB.open(databaseName, 1);
		opening.onupgradeneeded = () => {
			const database = opening.result;
			if (!database.objectStoreNames.contains("state"))
				database.createObjectStore("state", { keyPath: "id" });
			if (!database.objectStoreNames.contains("messages"))
				database.createObjectStore("messages", { keyPath: "id" });
		};
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error);
	});
}

function request<T>(value: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}

function transaction(
	database: IDBDatabase,
	storeName: string,
	operation: (store: IDBObjectStore) => IDBRequest,
) {
	return new Promise<void>((resolve, reject) => {
		const value = database.transaction(storeName, "readwrite");
		operation(value.objectStore(storeName));
		value.oncomplete = () => resolve();
		value.onerror = () => reject(value.error);
		value.onabort = () => reject(value.error);
	});
}

function fromBase64Url(value: string) {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(
		normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
	);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
