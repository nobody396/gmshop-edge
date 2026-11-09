import {
	SiApple,
	SiClaude,
	SiGooglegemini,
	SiTelegram,
	SiX,
} from "@icons-pack/react-simple-icons";
import {
	Ellipsis,
	LayoutGrid,
	Mail,
	MessageSquareText,
	Store,
	Tag,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { type CatalogTag, orderedCategories } from "./category-order";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

function OpenAIIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg
			aria-hidden="true"
			fill="currentColor"
			role="img"
			viewBox="0 0 24 24"
			{...props}
		>
			<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
		</svg>
	);
}

type CategoryMeta = { label: () => string; icon: Icon; color?: string };

/** Sidebar order and look per product tag. Tags not listed here still show, after these, with a generic icon. */
const CATEGORY_META: Record<string, CategoryMeta> = {
	Anthropic: { label: () => "Claude", icon: SiClaude, color: "#D97757" },
	OpenAI: { label: () => "ChatGPT", icon: OpenAIIcon },
	X: { label: () => "X / Grok", icon: SiX },
	Gemini: { label: () => "Gemini", icon: SiGooglegemini, color: "#8E75B2" },
	Telegram: { label: () => "Telegram", icon: SiTelegram, color: "#26A5E4" },
	Apple: { label: () => "Apple ID", icon: SiApple },
	邮箱: { label: () => m.store_category_email(), icon: Mail, color: "#EA4335" },
	接码: {
		label: () => m.store_category_sms(),
		icon: MessageSquareText,
		color: "#1F8A4C",
	},
	开店赚钱: {
		label: () => m.store_category_reseller(),
		icon: Store,
		color: "#B8664A",
	},
	其他服务: { label: () => m.store_category_other(), icon: Ellipsis },
};

export {
	type CatalogTag,
	orderedCategories,
	primaryCategory,
} from "./category-order";

function meta(name: string): CategoryMeta {
	return CATEGORY_META[name] ?? { label: () => name, icon: Tag };
}

/** Whether a tag has its own brand icon (unknown tags fall back to a generic one). */
export function hasCategoryIcon(name: string | undefined) {
	return name != null && name in CATEGORY_META;
}

export function CategoryIcon({
	name,
	className,
}: {
	name: string | null;
	className?: string;
}) {
	const entry =
		name === null ? { icon: LayoutGrid as Icon, color: undefined } : meta(name);
	const Glyph = entry.icon;
	return (
		<span
			className={cn(
				"grid size-7 shrink-0 place-items-center rounded-lg border border-border/70 bg-background",
				className,
			)}
		>
			<Glyph
				aria-hidden="true"
				className="size-4"
				style={entry.color ? { color: entry.color } : undefined}
			/>
		</span>
	);
}

type Props = {
	tags: readonly CatalogTag[];
	active: string;
	onSelect: (tag: string) => void;
};

/** Desktop: a sticky list of categories beside the products, each with its icon and product count. */
export function CategorySidebar({
	tags,
	active,
	onSelect,
	top,
}: Props & { top: number }) {
	const categories = orderedCategories(tags);
	return (
		<nav
			aria-label={m.store_categories_title()}
			className="sticky hidden self-start overflow-y-auto overscroll-contain rounded-2xl border border-border/70 bg-card p-1.5 lg:block"
			data-home-category-sidebar
			style={{
				top: top + 16,
				maxHeight: `calc(100dvh - ${top + 32}px)`,
			}}
		>
			<p className="px-2 pt-1.5 pb-1 font-semibold text-muted-foreground text-xs tracking-wide">
				{m.store_categories_title()}
			</p>
			<ul className="grid gap-0.5">
				<li>
					<CategoryRow
						active={!active}
						label={m.store_category_all()}
						name={null}
						onClick={() => onSelect("")}
					/>
				</li>
				{categories.map((tag) => (
					<li key={tag.name}>
						<CategoryRow
							active={active === tag.name}
							count={tag.productCount}
							label={meta(tag.name).label()}
							name={tag.name}
							onClick={() => onSelect(tag.name)}
						/>
					</li>
				))}
			</ul>
		</nav>
	);
}

function CategoryRow({
	active,
	count,
	label,
	name,
	onClick,
}: {
	active: boolean;
	count?: number;
	label: string;
	name: string | null;
	onClick: () => void;
}) {
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start text-sm transition-colors",
				active
					? "bg-primary/10 font-semibold text-foreground ring-1 ring-primary/25"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			<CategoryIcon name={name} />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{count === undefined ? null : (
				<span
					className={cn(
						"min-w-7 rounded-full px-2 py-0.5 text-center text-xs tabular-nums",
						active
							? "bg-primary text-primary-foreground"
							: "bg-muted text-muted-foreground",
					)}
				>
					{count}
				</span>
			)}
		</button>
	);
}

/** Phones and tablets: the same categories as a horizontal row of chips with icons. */
export function CategoryChips({
	tags,
	active,
	onSelect,
	wrap = false,
}: Props & {
	/** Wrap onto several lines at every width, instead of one scrolling row hidden on desktop. */
	wrap?: boolean;
}) {
	const categories = orderedCategories(tags);
	return (
		<div
			className={cn(
				"flex min-w-0 flex-1 gap-1.5",
				wrap ? "flex-wrap" : "overflow-x-auto lg:hidden",
			)}
			data-home-category-chips
		>
			<Chip
				active={!active}
				label={m.store_category_all()}
				name={null}
				onClick={() => onSelect("")}
			/>
			{categories.map((tag) => (
				<Chip
					active={active === tag.name}
					key={tag.name}
					label={meta(tag.name).label()}
					name={tag.name}
					onClick={() => onSelect(tag.name)}
				/>
			))}
		</div>
	);
}

function Chip({
	active,
	label,
	name,
	onClick,
}: {
	active: boolean;
	label: string;
	name: string | null;
	onClick: () => void;
}) {
	return (
		<button
			aria-pressed={active}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-full border py-1 ps-1 pe-3 text-sm",
				active
					? "border-primary bg-primary text-primary-foreground"
					: "border-border bg-background text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			<CategoryIcon
				className="size-6 rounded-full border-0 text-foreground"
				name={name}
			/>
			{label}
		</button>
	);
}
