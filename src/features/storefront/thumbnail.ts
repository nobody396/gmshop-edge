/** Small square icon for a product (cards, cart, checkout, orders); the server falls back to the cover. */
export function productThumbnailUrl(coverUrl: string): string {
	return `${coverUrl}${coverUrl.includes("?") ? "&" : "?"}thumb=1`;
}
