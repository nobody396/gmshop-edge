import { type IpCheck, maskIp } from "./check";
export const checkerShareUrl =
	"https://laoshirenvip.com/ip-check?utm_source=ip_share&utm_medium=card";
export async function createShareImage(
	result: IpCheck,
	qrSvg: string,
	copy: { title: string; source: string; note: string; cta: string },
) {
	const canvas = document.createElement("canvas");
	canvas.width = 900;
	canvas.height = 1200;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas_unavailable");
	ctx.fillStyle = "#f5f6f2";
	ctx.fillRect(0, 0, 900, 1200);
	ctx.fillStyle = "#fff";
	ctx.fillRect(50, 50, 800, 1100);
	ctx.fillStyle = "#196440";
	ctx.font = "bold 28px sans-serif";
	ctx.fillText("老实人 VIP · IP CHECK", 90, 115);
	ctx.fillStyle = "#16251c";
	ctx.font = "bold 38px sans-serif";
	ctx.fillText(copy.title, 90, 190);
	ctx.font = "bold 160px sans-serif";
	ctx.fillStyle =
		result.mode === "edge"
			? "#936623"
			: (result.score ?? 0) >= 90
				? "#196440"
				: "#936623";
	ctx.fillText(String(result.score ?? "—"), 90, 385);
	ctx.font = "30px sans-serif";
	ctx.fillStyle = "#637168";
	ctx.fillText("/ 100", 425, 385);
	ctx.font = "bold 32px monospace";
	ctx.fillStyle = "#16251c";
	ctx.fillText(maskIp(result.ip), 90, 465);
	ctx.font = "24px sans-serif";
	function wrap(text: string, y: number, width = 680) {
		let line = "";
		for (const char of text) {
			if (ctx && ctx.measureText(line + char).width > width) {
				ctx.fillText(line, 90, y);
				y += 38;
				line = "";
			}
			line += char;
		}
		ctx?.fillText(line, 90, y);
		return y + 38;
	}
	let y = wrap(copy.source, 530);
	ctx.fillStyle = "#637168";
	y = wrap(copy.note, y + 14);
	ctx.font = "21px sans-serif";
	ctx.fillText(
		new Date(result.checkedAt).toISOString().replace("T", " ").slice(0, 19) +
			" UTC",
		90,
		y + 26,
	);
	const url = URL.createObjectURL(new Blob([qrSvg], { type: "image/svg+xml" }));
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("qr_failed"));
			img.src = url;
		});
		ctx.drawImage(img, 335, 790, 230, 230);
	} finally {
		URL.revokeObjectURL(url);
	}
	ctx.fillStyle = "#196440";
	ctx.font = "bold 23px sans-serif";
	wrap(copy.cta, 1070);
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("image_failed"))),
			"image/png",
		),
	);
	return new File([blob], "laoshirenvip-ip-check.png", { type: "image/png" });
}
